import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { resolveSupabaseEnvironment, STATELESS_AUTH_OPTIONS } from "@openkt/data-supabase";

import { AuditService } from "../../audit/services/audit.service";

// Lightweight request metadata threaded from the controller. Public-auth
// endpoints don't have an ActorContext yet (they're pre-auth), so we
// pass just what the audit row needs: ip, user agent, request id.
export interface AuthRequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

// Wraps Supabase Auth for the public auth surface (/v1/auth/*).
//
// All endpoints route through this service so:
//   - The CLI / dashboard never see Supabase URLs or keys.
//   - We can drop in custom audit / rate-limit / claim-injection later
//     without touching every client.
//   - Email delivery (verification, magic-link) stays Supabase's job.
//     We trigger via the SDK; Supabase's email infrastructure sends.
//
// Uses a fresh anonymous Supabase client per call (cheap; ~one
// fetch-equivalent of allocation) instead of the cached service-role
// admin client because:
//   - signInWithPassword + signUp + signInWithOtp on a service-role
//     client behave differently w.r.t. rate limits and confirmation
//     emails — the anon path is what end-user clients are *supposed*
//     to use.
//   - We don't want a single long-lived auth client picking up the
//     last-set session by accident in stateless server contexts.

export interface SessionShape {
  token: string;
  refresh_token: string;
  expires_at: number | null;
  user: { id: string; email: string | null };
}

@Injectable()
export class AuthApplicationService {
  private readonly logger = new Logger(AuthApplicationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private async writeAudit(
    action: string,
    userId: string | null,
    meta: AuthRequestMeta | undefined,
    extras: Record<string, unknown> = {},
  ): Promise<void> {
    // Best-effort: a stale DB or audit-log table issue must never
    // bubble back to the user and turn a successful auth into a 5xx.
    try {
      await this.audit.write({
        actorId: userId,
        actorKind: userId ? "user" : "system",
        orgId: null,
        action,
        resourceType: userId ? "user" : null,
        resourceId: userId,
        before: null,
        after: extras,
        request: {
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          requestId: meta?.requestId ?? "-",
        },
      });
    } catch (err) {
      this.logger.warn(
        `[auth.audit] failed to write ${action}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private anonClient(): SupabaseClient {
    const environment = resolveSupabaseEnvironment(this.configService);
    return createClient(
      environment.url,
      environment.publishableKey,
      STATELESS_AUTH_OPTIONS,
    );
  }

  async passwordLogin(
    email: string,
    password: string,
    meta?: AuthRequestMeta,
  ): Promise<SessionShape> {
    const supabase = this.anonClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session || !data.user) {
      await this.writeAudit("auth.login.failed", null, meta, {
        email: email.toLowerCase(),
      });
      // Generic error — don't leak "user exists / wrong password" vs
      // "no such user." Matches the dashboard signin UX.
      throw new UnauthorizedException("invalid email or password");
    }
    await this.writeAudit("auth.login.success", data.user.id, meta);
    return shapeSession(data.session, data.user);
  }

  async signup(
    email: string,
    password: string,
    meta?: AuthRequestMeta,
  ): Promise<SessionShape> {
    const supabase = this.anonClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error || !data.user) {
      await this.writeAudit("auth.signup.failed", null, meta, {
        email: email.toLowerCase(),
        message: error?.message ?? null,
      });
      throw new UnauthorizedException(error?.message ?? "signup failed");
    }
    await this.writeAudit("auth.signup.success", data.user.id, meta, {
      email: data.user.email ?? null,
      session_created: !!data.session,
    });

    // If the project requires email confirmation Supabase returns a
    // user with no session. Caller branches on `token === ""` to
    // surface a "check your email" message.
    if (!data.session) {
      return {
        token: "",
        refresh_token: "",
        expires_at: null,
        user: { id: data.user.id, email: data.user.email ?? null },
      };
    }
    return shapeSession(data.session, data.user);
  }

  async sendMagicLink(email: string, meta?: AuthRequestMeta): Promise<void> {
    const supabase = this.anonClient();
    // Supabase's signInWithOtp issues a passwordless magic link; if
    // the user doesn't exist, `shouldCreateUser: true` (the default)
    // creates them. The route returns 200 regardless of outcome to
    // prevent email enumeration.
    await supabase.auth.signInWithOtp({ email });
    // Audit at the system level — we deliberately don't record an
    // actorId here because that would leak existence for an enumeration
    // attack. The email goes into the `after` payload so security ops
    // can still investigate.
    await this.writeAudit("auth.magic_link.requested", null, meta, {
      email: email.toLowerCase(),
    });
  }

  async refresh(refreshToken: string, meta?: AuthRequestMeta): Promise<SessionShape> {
    const supabase = this.anonClient();
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session || !data.user) {
      await this.writeAudit("auth.refresh.failed", null, meta);
      throw new UnauthorizedException("refresh token expired or revoked");
    }
    await this.writeAudit("auth.refresh.success", data.user.id, meta);
    return shapeSession(data.session, data.user);
  }

  async logout(jwt: string, meta?: AuthRequestMeta): Promise<void> {
    // signOut on the user-scoped client revokes the refresh token
    // server-side. The access token is still valid until expiry —
    // that's a Supabase guarantee, not a regression. Clients should
    // also clear local state on logout.
    const environment = resolveSupabaseEnvironment(this.configService);
    const supabase = createClient(environment.url, environment.publishableKey, {
      ...STATELESS_AUTH_OPTIONS,
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    await supabase.auth.signOut();
    // Audited without an actorId — extracting the user id from the JWT
    // would require an extra network call to Supabase. The request id
    // + IP + UA on the audit row is enough to trace a logout, and a
    // SupabaseJwtGuard-gated wrapper at the controller could surface
    // the user id later if security ops asks.
    await this.writeAudit("auth.logout", null, meta);
  }
}

function shapeSession(
  session: { access_token: string; refresh_token: string; expires_at?: number | undefined },
  user: { id: string; email?: string | null | undefined },
): SessionShape {
  return {
    token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    user: { id: user.id, email: user.email ?? null },
  };
}
