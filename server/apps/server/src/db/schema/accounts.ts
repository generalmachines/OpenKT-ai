import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { profiles } from "./profiles";

// Built-in accounts (migration 0039). `user_credentials` is how a person
// proves who they are; the session itself is an ordinary access token in
// `personal_access_tokens` (name `session:<client>`), so every route and the
// MCP endpoint accept it through the one existing token path.
export const userCredentials = pgTable(
  "user_credentials",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => profiles.userId, { onDelete: "cascade" }),
    // Always stored lower-cased; look up with the lower-cased input.
    email: text("email").notNull(),
    // `scrypt$N$r$p$<salt b64>$<hash b64>`. NULL = the account signs in with Google only.
    passwordHash: text("password_hash"),
    googleSub: text("google_sub"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    emailUnique: uniqueIndex("user_credentials_email_unique").on(t.email),
    googleSubUnique: uniqueIndex("user_credentials_google_sub_unique").on(t.googleSub),
  }),
);

// One row per counted sign-in attempt; the limiter counts the last 15 minutes.
export const loginAttempts = pgTable(
  "login_attempts",
  {
    email: text("email"),
    ip: text("ip"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailAtIdx: index("login_attempts_email_at_idx").on(t.email, t.at),
    ipAtIdx: index("login_attempts_ip_at_idx").on(t.ip, t.at),
  }),
);

// A share addressed to an email that has no account yet. Becomes a `grants`
// row when that email signs up or first signs in with Google.
export const pendingGrants = pgTable(
  "pending_grants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    resourceEmailUnique: unique("pending_grants_resource_email_unique").on(t.resourceType, t.resourceId, t.email),
    emailIdx: index("pending_grants_email_idx").on(t.email),
  }),
);

export type UserCredentials = typeof userCredentials.$inferSelect;
export type PendingGrant = typeof pendingGrants.$inferSelect;
