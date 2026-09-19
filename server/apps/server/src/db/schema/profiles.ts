import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Per-user public-ish profile. user_id is the FK to users.id (no
// inline FK declared so we can pull profiles before users during the
// Supabase migration).
//
// Columns landed in migration 0018:
//   - github_username / github_id — populated when a user signs in via the
//     Supabase GitHub OAuth provider (Supabase puts `login` in
//     user_metadata.user_name and the numeric id in user_metadata.provider_id).
//   - avatar_url — denormalised onto the profile so /v1/profile/me doesn't
//     need to join users (and so OAuth-only flows can populate it before a
//     users row exists).
//   - auth_provider — 'email' | 'github' (defaulted 'email' for back-compat).
//   - bio — user-editable freeform text exposed via PATCH /v1/profile/me.
//   - updated_at — refreshed by the repository on every write.
export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id").primaryKey(),
    email: text("email"),
    displayName: text("display_name"),
    githubUsername: text("github_username"),
    githubId: text("github_id"),
    avatarUrl: text("avatar_url"),
    authProvider: text("auth_provider").notNull().default("email"),
    bio: text("bio"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    githubIdKey: uniqueIndex("profiles_github_id_key").on(t.githubId),
    githubUsernameIdx: index("profiles_github_username_idx").on(t.githubUsername),
  }),
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
