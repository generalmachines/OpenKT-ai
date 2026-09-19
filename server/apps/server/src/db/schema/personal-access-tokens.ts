import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Long-lived per-user tokens for connector + service-style access.
// See migration 0031 for the rationale.
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY['read','write']::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Migration 0032 — set when the token was minted by the OAuth 2.1
    // authorization-code grant (DCR'd Claude.ai clients, primarily).
    // NULL on manually-minted dashboard PATs.
    oauthClientId: text("oauth_client_id"),
    // sha256 hex of the raw refresh token (prefix `okt_rt_…`). Only
    // populated for OAuth-issued tokens; NULL otherwise.
    refreshTokenHash: text("refresh_token_hash"),
  },
  (table) => ({
    tokenHashUniq: uniqueIndex("personal_access_tokens_token_hash_uniq").on(
      table.tokenHash,
    ),
    activeIdx: index("personal_access_tokens_active_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;
export type NewPersonalAccessToken = typeof personalAccessTokens.$inferInsert;
