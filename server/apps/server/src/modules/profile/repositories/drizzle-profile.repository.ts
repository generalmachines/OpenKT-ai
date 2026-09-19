import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type { ActorContext, ActorOAuthIdentity } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";
import type {
  ProfileRecord,
  ProfileRepository,
  UpdateProfileRecord,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { profiles } from "../../../db/schema";

// Repository for the BFF-owned `profiles` table.
//
// The Supabase legacy `on_auth_user_created` trigger (which used to insert
// into `public.profiles`) was dropped in the 2026-05-12 cleanup, so this
// repository is the single insertion point for profile rows. On every
// authenticated request `getMe` will:
//   1. Look up the row by user_id (the Supabase JWT sub).
//   2. If missing — INSERT a new row from the ActorPrincipal's resolved
//      identity (email, OAuth metadata) so the caller sees a fully-
//      populated profile on the very first request.
//   3. If present — upgrade GitHub fields when the row was created under
//      auth_provider='email' and the current session is GitHub-OAuth-
//      backed. Lets a user signed up with email + password link their
//      GitHub account just by signing in via GitHub once.
//
// Writes happen unconditionally on cold-start; the SQL is small enough
// that this stays cheaper than a "did we already insert?" pre-check.
@Injectable()
export class DrizzleProfileRepository implements ProfileRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getMe(context: ActorContext): Promise<ProfileRecord | null> {
    const principal = context.principal;
    const userId = principal.userId;
    if (!userId) return null;

    const existing = await this.findByUserId(userId);
    const oauth = principal.oauthIdentity ?? null;

    if (!existing) {
      // Cold-start lazy-create. Pulls every field from the resolved
      // principal so the response on the first /v1/profile/me hit looks
      // identical to a "row already existed" response.
      const inserted = await this.insertFromPrincipal({
        userId,
        email: principal.email,
        displayName: principal.displayName,
        oauth,
      });
      return inserted;
    }

    // Upgrade path: row was created under password / magic-link, and the
    // current session is GitHub-backed. Backfill the GitHub fields.
    if (
      oauth &&
      oauth.provider === "github" &&
      existing.authProvider === "email"
    ) {
      const upgraded = await this.upgradeToGithub(userId, oauth);
      if (upgraded) return upgraded;
    }

    return existing;
  }

  async updateMe(
    context: ActorContext,
    input: UpdateProfileRecord,
  ): Promise<ProfileRecord> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    // Ensure the row exists first — a PATCH against a cold profile lazy-
    // creates the base row before applying the patch (the typical
    // sequence is GET-then-PATCH so this is rarely the hot path).
    const current = await this.getMe(context);
    if (!current) throw new ValidationDomainError("profile read-after-write failed");

    const patch: Record<string, unknown> = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl;
    if (input.bio !== undefined) patch.bio = input.bio;

    if (Object.keys(patch).length === 0) {
      // No-op PATCH — still return the current profile so the controller
      // can wrap it in okResponse without a re-fetch.
      return current;
    }

    patch.updatedAt = new Date();

    await this.db
      .update(profiles)
      .set(patch)
      .where(eq(profiles.userId, userId));

    const updated = await this.findByUserId(userId);
    if (!updated) throw new ValidationDomainError("profile read-after-write failed");
    return updated;
  }

  // ── internals ─────────────────────────────────────────────────────

  private async findByUserId(userId: string): Promise<ProfileRecord | null> {
    const [row] = await this.db
      .select({
        userId: profiles.userId,
        email: profiles.email,
        displayName: profiles.displayName,
        avatarUrl: profiles.avatarUrl,
        githubUsername: profiles.githubUsername,
        githubId: profiles.githubId,
        authProvider: profiles.authProvider,
        bio: profiles.bio,
        createdAt: profiles.createdAt,
        updatedAt: profiles.updatedAt,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    if (!row) return null;
    return this.toRecord(row);
  }

  private async insertFromPrincipal(input: {
    userId: string;
    email: string | null;
    displayName: string | null;
    oauth: ActorOAuthIdentity | null;
  }): Promise<ProfileRecord> {
    const displayName =
      input.oauth?.fullName ?? input.displayName ?? input.email ?? null;

    const now = new Date();
    // INSERT … ON CONFLICT DO NOTHING — protects against the race where
    // two requests for a brand-new user land in parallel.
    await this.db
      .insert(profiles)
      .values({
        userId: input.userId,
        email: input.email,
        displayName,
        avatarUrl: input.oauth?.avatarUrl ?? null,
        githubUsername: input.oauth?.githubUsername ?? null,
        githubId: input.oauth?.githubId ?? null,
        authProvider: input.oauth?.provider ?? "email",
        bio: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: profiles.userId });

    const stored = await this.findByUserId(input.userId);
    if (!stored) {
      // Shouldn't happen — insert just succeeded or conflicted (in which
      // case findByUserId would return the existing row). Treat as a
      // hard error so we never return a half-populated record.
      throw new ValidationDomainError("profile read-after-write failed");
    }
    return stored;
  }

  private async upgradeToGithub(
    userId: string,
    oauth: ActorOAuthIdentity,
  ): Promise<ProfileRecord | null> {
    // Only touch the GitHub-derived fields + auth_provider. display_name
    // / bio are user-editable and shouldn't be clobbered by a re-auth.
    await this.db
      .update(profiles)
      .set({
        githubUsername: oauth.githubUsername ?? null,
        githubId: oauth.githubId ?? null,
        avatarUrl: oauth.avatarUrl ?? null,
        authProvider: "github",
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));
    return this.findByUserId(userId);
  }

  private toRecord(row: {
    userId: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    githubUsername: string | null;
    githubId: string | null;
    authProvider: string;
    bio: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }): ProfileRecord {
    return {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      githubUsername: row.githubUsername,
      githubId: row.githubId,
      authProvider: row.authProvider,
      bio: row.bio,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
    };
  }

  private iso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d);
  }
}
