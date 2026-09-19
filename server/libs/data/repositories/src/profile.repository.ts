import type { ActorContext } from "@openkt/core-context";

export interface ProfileRecord {
  userId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  // GitHub OAuth metadata (migration 0018). Populated when the user has
  // signed in via the Supabase GitHub provider at least once.
  githubUsername: string | null;
  githubId: string | null;
  // 'email' | 'github' — Supabase's app_metadata.provider for the last
  // session that touched this row.
  authProvider: string;
  bio: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileRecord {
  displayName?: string | null;
  avatarUrl?: string | null;
  // Freeform user bio exposed via PATCH /v1/profile/me. The route does not
  // accept email / github_username / role — those flow from the auth
  // provider and are not editable by the user.
  bio?: string | null;
}

export interface ProfileRepository {
  // Returns the caller's profile, lazy-creating it on first authenticated
  // request when missing (using the OAuth identity carried on the
  // ActorPrincipal). May still return null for non-user principals.
  getMe(context: ActorContext): Promise<ProfileRecord | null>;
  updateMe(context: ActorContext, input: UpdateProfileRecord): Promise<ProfileRecord>;
}
