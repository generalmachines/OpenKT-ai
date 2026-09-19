import { randomUUID } from "node:crypto";

import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import { buildUserPrincipal } from "@openkt/auth-principal";
import type { ActorContext, RequestMetadata } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { profiles, userCredentials, type UserCredentials } from "../../../db/schema";
import { AuditService } from "../../audit/services/audit.service";
import { ActorContextFactory } from "../../auth/services/actor-context.factory";
import { GrantRepository } from "../../grants/repositories/grant.repository";
import {
  PersonalTokensService,
  SESSION_TOKEN_NAME_PREFIX,
} from "../../personal-tokens/services/personal-tokens.service";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { SkillsApplicationService } from "../../skills/services/skills-application.service";
import { GoogleIdTokenVerifier, type GoogleIdentity } from "./google-id-token-verifier.service";
import { LoginAttemptsService } from "./login-attempts.service";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./password-hasher";
import { passwordProblem } from "./password-policy";

// Built-in accounts: email + password and Google sign-in, owned by this
// server. There is no separate session store — a successful sign-in mints an
// ordinary access token (`okt_pat_…`, name `session:<client>`, 90 days), which
// is the one credential every REST route and the MCP endpoint already accept.
// Logging out revokes that token.

export type SessionClient = "desktop" | "web" | "cli";
const SESSION_DAYS = 90;

export interface SignedInUser {
  userId: string;
  email: string;
  displayName: string | null;
}

export interface AccountSession {
  token: string;
  expires_at: string;
  user: { id: string; email: string; display_name: string | null };
}

// One sentence for every failed sign-in, whatever the reason — unknown email,
// wrong password, Google-only account, rejected Google token.
const INVALID_CREDENTIALS_MESSAGE = "invalid email or password";

function fail(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tokens: PersonalTokensService,
    private readonly attempts: LoginAttemptsService,
    private readonly google: GoogleIdTokenVerifier,
    private readonly projectScope: ProjectScopeService,
    private readonly grantRepository: GrantRepository,
    private readonly actorContextFactory: ActorContextFactory,
    private readonly audit: AuditService,
    private readonly skills: SkillsApplicationService,
  ) {}

  providers(): { password: true; google: { enabled: boolean; client_id?: string } } {
    const [clientId] = this.google.clientIds();
    return { password: true, google: clientId ? { enabled: true, client_id: clientId } : { enabled: false } };
  }

  async signup(
    input: { email: string; password: string; displayName: string; client: SessionClient },
    request: RequestMetadata,
  ): Promise<AccountSession> {
    const user = await this.registerWithPassword(input, request);
    return this.startSession(user.userId, user.email, user.displayName, input.client);
  }

  async login(
    input: { email: string; password: string; client: SessionClient },
    request: RequestMetadata,
  ): Promise<AccountSession> {
    const user = await this.authenticateWithPassword(input, request);
    return this.startSession(user.userId, user.email, user.displayName, input.client);
  }

  // The sign-up checks without minting a session: `signup` above and the
  // OAuth sign-in page (which issues an authorization code instead) share it,
  // so both get the same password rules, attempt limits and errors.
  async registerWithPassword(
    input: { email: string; password: string; displayName: string },
    request: RequestMetadata,
  ): Promise<SignedInUser> {
    const ip = request.ip ?? null;
    await this.attempts.assertAllowed(input.email, ip);

    // Judged before anything touches the database, so a refused password says
    // nothing about the email — and fumbling the rules does not use up attempts.
    const problem = passwordProblem(input.password, input.email);
    if (problem) throw fail(HttpStatus.BAD_REQUEST, "weak_password", problem);

    // From here every sign-up counts, successful or not: it caps both
    // account-farming from one address and probing the 409 below for who has
    // an account.
    await this.attempts.record(input.email, ip);

    if (await this.findByEmail(input.email)) {
      throw fail(HttpStatus.CONFLICT, "email_taken", "an account with this email already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const userId = await this.createAccount({
      email: input.email,
      displayName: input.displayName,
      passwordHash,
      googleSub: null,
      emailVerified: false,
      avatarUrl: null,
      authProvider: "email",
    }, request);
    await this.writeAudit("auth.signup.success", userId, request);
    return { userId, email: input.email, displayName: input.displayName };
  }

  // The login checks without minting a session (see registerWithPassword).
  // Every failure is the same 401 `invalid_credentials`.
  async authenticateWithPassword(
    input: { email: string; password: string },
    request: RequestMetadata,
  ): Promise<SignedInUser> {
    const ip = request.ip ?? null;
    await this.attempts.assertAllowed(input.email, ip);

    const credentials = await this.findByEmail(input.email);
    // Always run one scrypt, account or not, so timing does not tell them apart.
    const matches = await verifyPassword(input.password, credentials?.passwordHash ?? (await dummyPasswordHash()));
    if (!credentials || !credentials.passwordHash || !matches) {
      await this.attempts.record(input.email, ip);
      await this.writeAudit("auth.login.failed", null, request, { email: input.email });
      throw fail(HttpStatus.UNAUTHORIZED, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
    }

    await this.touchLastLogin(credentials.userId);
    await this.writeAudit("auth.login.success", credentials.userId, request);
    return {
      userId: credentials.userId,
      email: credentials.email,
      displayName: await this.displayNameOf(credentials.userId),
    };
  }

  async googleSignIn(
    input: { idToken: string; client: SessionClient },
    request: RequestMetadata,
  ): Promise<AccountSession> {
    if (!this.google.enabled()) {
      throw fail(HttpStatus.NOT_FOUND, "provider_disabled", "Google sign-in is not enabled on this server");
    }
    const ip = request.ip ?? null;
    await this.attempts.assertAllowed(null, ip);

    let identity: GoogleIdentity;
    try {
      identity = await this.google.verify(input.idToken);
    } catch {
      await this.attempts.record(null, ip);
      await this.writeAudit("auth.google.failed", null, request);
      throw fail(HttpStatus.UNAUTHORIZED, "invalid_credentials", "Google sign-in was not accepted");
    }

    const userId = await this.resolveGoogleAccount(identity, request);
    await this.touchLastLogin(userId);
    await this.writeAudit("auth.google.success", userId, request);
    return this.startSession(userId, identity.email, await this.displayNameOf(userId), input.client);
  }

  // Revokes the token that made this request. A caller without a token id
  // (a Supabase JWT) has nothing of ours to revoke; that is still a 204.
  async logout(context: ActorContext): Promise<void> {
    const { userId, tokenId } = context.principal;
    if (!userId || !tokenId) return;
    await this.tokens.revoke(userId, tokenId).catch(() => undefined);
    await this.writeAudit("auth.logout", userId, context.request);
  }

  // Changes the password and signs out every OTHER session. `currentPassword`
  // may be omitted only by an account that has no password yet (Google-only).
  async changePassword(
    context: ActorContext,
    input: { currentPassword: string | null; newPassword: string },
  ): Promise<void> {
    const userId = context.principal.userId;
    const credentials = userId ? await this.findByUserId(userId) : null;
    if (!userId || !credentials) {
      throw fail(HttpStatus.BAD_REQUEST, "no_built_in_account", "this account does not sign in with a password here");
    }
    const ip = context.request.ip ?? null;
    await this.attempts.assertAllowed(credentials.email, ip);

    if (credentials.passwordHash) {
      const matches = input.currentPassword
        ? await verifyPassword(input.currentPassword, credentials.passwordHash)
        : false;
      if (!matches) {
        await this.attempts.record(credentials.email, ip);
        throw fail(HttpStatus.UNAUTHORIZED, "invalid_credentials", "current password is not correct");
      }
    }

    const problem = passwordProblem(input.newPassword, credentials.email);
    if (problem) throw fail(HttpStatus.BAD_REQUEST, "weak_password", problem);

    await this.db
      .update(userCredentials)
      .set({ passwordHash: await hashPassword(input.newPassword), updatedAt: sql`now()` })
      .where(eq(userCredentials.userId, userId));
    await this.tokens.revokeSessions(userId, context.principal.tokenId ?? null);
    await this.writeAudit("auth.password.changed", userId, context.request);
  }

  // ── internals ─────────────────────────────────────────────────────

  // Find by Google subject, else by email (link), else create.
  private async resolveGoogleAccount(identity: GoogleIdentity, request: RequestMetadata): Promise<string> {
    const [bySub] = await this.db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.googleSub, identity.sub))
      .limit(1);
    if (bySub) return bySub.userId;

    const byEmail = await this.findByEmail(identity.email);
    if (byEmail) {
      // Google has verified this person owns the address. If the existing
      // account never proved that (we send no verification mail), whoever set
      // its password may be someone else who registered the address first —
      // so that password and its sessions do not survive the link. The rightful
      // owner is signed in now and can set a new password.
      const takeOver = !byEmail.emailVerified;
      await this.db
        .update(userCredentials)
        .set({
          googleSub: identity.sub,
          emailVerified: true,
          ...(takeOver ? { passwordHash: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(userCredentials.userId, byEmail.userId));
      if (takeOver) await this.tokens.revokeSessions(byEmail.userId);
      await this.grantRepository.convertPendingForEmail(identity.email, byEmail.userId);
      return byEmail.userId;
    }

    return this.createAccount({
      email: identity.email,
      displayName: identity.name ?? identity.email.split("@")[0]!,
      passwordHash: null,
      googleSub: identity.sub,
      emailVerified: true,
      avatarUrl: identity.picture,
      authProvider: "google",
    }, request);
  }

  // Profile + credentials in one transaction, then the personal space, the
  // starter skill, and any shares that were waiting for this email.
  private async createAccount(input: {
    email: string;
    displayName: string;
    passwordHash: string | null;
    googleSub: string | null;
    emailVerified: boolean;
    avatarUrl: string | null;
    authProvider: string;
  }, request: RequestMetadata): Promise<string> {
    const userId = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(profiles).values({
          userId,
          email: input.email,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl,
          authProvider: input.authProvider,
        });
        await tx.insert(userCredentials).values({
          userId,
          email: input.email,
          passwordHash: input.passwordHash,
          googleSub: input.googleSub,
          emailVerified: input.emailVerified,
          lastLoginAt: new Date(),
        });
      });
    } catch (err) {
      // Two sign-ups for one email racing: the unique index picks the winner.
      if (isUniqueViolation(err)) {
        throw fail(HttpStatus.CONFLICT, "email_taken", "an account with this email already exists");
      }
      throw err;
    }

    const context = this.actorContextFactory.createUserContext({
      principal: buildUserPrincipal(
        { userId, email: input.email, displayName: input.displayName, oauthIdentity: null },
        "mcp-token",
      ),
      request,
      jwt: null,
    });
    await this.projectScope.resolvePersonalProjectId(context);
    await this.skills.seedStarterSkill(userId);
    const converted = await this.grantRepository.convertPendingForEmail(input.email, userId);
    this.logger.log(`[accounts] created user=${userId} provider=${input.authProvider} pending_grants=${converted}`);
    return userId;
  }

  private async startSession(
    userId: string,
    email: string,
    displayName: string | null,
    client: SessionClient,
  ): Promise<AccountSession> {
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const issued = await this.tokens.create({
      userId,
      name: `${SESSION_TOKEN_NAME_PREFIX}${client}`,
      scopes: ["read", "write"],
      expiresAt,
    });
    return {
      token: issued.rawToken,
      expires_at: (issued.expiresAt ?? expiresAt).toISOString(),
      user: { id: userId, email, display_name: displayName },
    };
  }

  private async findByEmail(email: string): Promise<UserCredentials | null> {
    const [row] = await this.db.select().from(userCredentials).where(eq(userCredentials.email, email)).limit(1);
    return row ?? null;
  }

  private async findByUserId(userId: string): Promise<UserCredentials | null> {
    const [row] = await this.db.select().from(userCredentials).where(eq(userCredentials.userId, userId)).limit(1);
    return row ?? null;
  }

  private async displayNameOf(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    return row?.displayName ?? null;
  }

  private async touchLastLogin(userId: string): Promise<void> {
    await this.db.update(userCredentials).set({ lastLoginAt: sql`now()` }).where(eq(userCredentials.userId, userId));
  }

  // Best-effort: an audit hiccup must never turn a good sign-in into a 5xx.
  private async writeAudit(
    action: string,
    userId: string | null,
    request: RequestMetadata,
    after: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.audit.write({
        actorId: userId,
        actorKind: userId ? "user" : "system",
        orgId: null,
        action,
        resourceType: userId ? "user" : null,
        resourceId: userId,
        before: null,
        after,
        request: { ip: request.ip ?? null, userAgent: request.userAgent ?? null, requestId: request.requestId ?? "-" },
      });
    } catch (err) {
      this.logger.warn(`[accounts.audit] failed to write ${action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code ??
    (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
}
