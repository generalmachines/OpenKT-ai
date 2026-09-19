import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type {
  ActorContext,
  ActorOAuthIdentity,
  RequestMetadata,
} from "@openkt/core-context";
import { buildServicePrincipal, buildUserPrincipal } from "@openkt/auth-principal";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { profiles } from "../../../db/schema";
import { ActorContextFactory } from "./actor-context.factory";
import {
  type SupabaseJwtClaims,
  SupabaseJwtVerifier,
} from "./supabase-jwt-verifier.service";

@Injectable()
export class PrincipalResolutionService {
  constructor(
    private readonly actorContextFactory: ActorContextFactory,
    private readonly supabaseJwtVerifier: SupabaseJwtVerifier,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  // Single entry point for JWT-based auth. Supabase is the sole JWT
  // provider — delegates directly to resolveSupabaseJwt. Kept as a
  // distinct method so all call-sites (SupabaseJwtGuard, BearerAuthGuard)
  // share one entry point without needing to know the provider.
  async resolveJwt(
    request: RequestMetadata,
    token: string,
  ): Promise<ActorContext> {
    return this.resolveSupabaseJwt(request, token);
  }

  async resolveSupabaseJwt(
    request: RequestMetadata,
    jwt: string,
  ): Promise<ActorContext> {
    const claims = await this.supabaseJwtVerifier.verify(jwt);

    if (!claims.sub) {
      // Verifier guarantees signature + iss + aud + exp. The only
      // remaining failure is a JWT minted without a `sub` claim — not
      // something Supabase issues, but defend in depth.
      throw new UnauthorizedDomainError("invalid or expired bearer token");
    }

    const userId = claims.sub;
    const email = typeof claims.email === "string" ? claims.email : null;
    const oauthIdentity = extractSupabaseOAuth(claims);

    // See `ensureProfileAndLookupDisplayName` below for why the upsert
    // happens here and not lazily in /v1/me.
    const displayName = await this.ensureProfileAndLookupDisplayName(
      userId,
      email,
      oauthIdentity,
    );

    return this.actorContextFactory.createUserContext({
      principal: buildUserPrincipal(
        {
          userId,
          email,
          displayName,
          oauthIdentity,
        },
        "supabase-jwt",
      ),
      request,
      jwt,
    });
  }

  async resolveServicePrincipal(
    request: RequestMetadata,
    serviceName: string,
  ): Promise<ActorContext> {
    return this.actorContextFactory.createServiceContext({
      principal: buildServicePrincipal(serviceName),
      request,
    });
  }

  private async lookupDisplayName(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    return rows[0]?.displayName ?? null;
  }

  // Idempotent profile upsert + display-name read in one round-trip.
  // INSERT ... ON CONFLICT DO NOTHING means concurrent calls (e.g. two
  // tabs hitting the server simultaneously after a fresh login) won't
  // race; only one row lands. The display_name returned is the row's
  // post-upsert value, so a brand-new user gets the OAuth full_name
  // (or null for email signups, which the UI handles by showing the
  // email prefix as a fallback).
  private async ensureProfileAndLookupDisplayName(
    userId: string,
    email: string | null,
    oauth: ActorOAuthIdentity,
  ): Promise<string | null> {
    await this.db
      .insert(profiles)
      .values({
        userId,
        email,
        displayName: oauth.fullName,
        avatarUrl: oauth.avatarUrl,
        githubUsername: oauth.githubUsername,
        githubId: oauth.githubId,
        authProvider: oauth.provider,
      })
      .onConflictDoNothing({ target: profiles.userId });

    return this.lookupDisplayName(userId);
  }
}

// Surfaces the Supabase user_metadata / app_metadata fields the
// profile lazy-create path needs. Supabase's GitHub OAuth provider
// populates:
//   - user_metadata.user_name      → GitHub login
//   - user_metadata.provider_id    → GitHub numeric account id
//   - user_metadata.avatar_url     → avatar URL
//   - user_metadata.full_name      → display name (falls back to name)
//   - app_metadata.provider        → 'github'
function extractSupabaseOAuth(claims: SupabaseJwtClaims): ActorOAuthIdentity {
  const appMd = claims.app_metadata ?? {};
  const userMd = claims.user_metadata ?? {};
  return {
    provider: stringOr(appMd.provider, "email"),
    githubUsername: stringOrNull(userMd.user_name),
    githubId: stringOrNull(userMd.provider_id),
    avatarUrl: stringOrNull(userMd.avatar_url),
    fullName: stringOrNull(userMd.full_name) ?? stringOrNull(userMd.name),
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function stringOr(value: unknown, fallback: string): string {
  return stringOrNull(value) ?? fallback;
}
