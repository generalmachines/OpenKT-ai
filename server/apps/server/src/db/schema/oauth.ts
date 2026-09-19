import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// OAuth 2.1 + RFC 7591 Dynamic Client Registration schema. See migration
// 0032_oauth.sql for the rationale. Only the metadata + short-lived
// authorization codes live here; issued access/refresh tokens piggyback
// on `personal_access_tokens` so the BearerAuthGuard verify path is
// reused unchanged.

export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    // NULL for public clients (token_endpoint_auth_method = "none").
    // Confidential clients (client_secret_post) always have a non-null
    // hashed secret. See migration 0035_oauth_public_clients.sql.
    clientSecretHash: text("client_secret_hash"),
    name: text("name").notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    // "client_secret_post" (default) or "none" (public client / PKCE-only).
    tokenEndpointAuthMethod: text("token_endpoint_auth_method")
      .notNull()
      .default("client_secret_post"),
    // The user who triggered the DCR call. NULL for purely anonymous
    // DCR (most Claude.ai installs) — the user binding only happens at
    // /oauth/authorize → /oauth/consent, against the auth code row.
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    activeIdx: index("oauth_clients_active_idx").on(table.createdAt),
  }),
);

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    code: text("code").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY['read','write']::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`(now() + interval '10 minutes')`),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    clientIdx: index("oauth_authorization_codes_client_idx").on(table.clientId),
  }),
);

export type OauthClient = typeof oauthClients.$inferSelect;
export type NewOauthClient = typeof oauthClients.$inferInsert;
export type OauthAuthorizationCode =
  typeof oauthAuthorizationCodes.$inferSelect;
export type NewOauthAuthorizationCode =
  typeof oauthAuthorizationCodes.$inferInsert;
