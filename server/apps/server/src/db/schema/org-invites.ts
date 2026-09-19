import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Org invite tables — supersedes the legacy `org_invites` shape that
// used to live in `settings.ts`. Two modes are encoded on the same row:
//
//   * targeted (single-use): `email` set, `is_open=false`, `accepted_at`
//     consumed on first redeem.
//   * open / link-share (multi-use): `is_open=true`, `email` nullable,
//     `max_uses` caps total redemptions (null = unlimited), individual
//     redemptions tracked in `org_invite_redemptions`.
export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    orgId: uuid("org_id").notNull(),
    invitedBy: uuid("invited_by").notNull(),
    email: text("email"),
    role: text("role").notNull().default("member"),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    isOpen: boolean("is_open").notNull().default(false),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("org_invites_token_uniq").on(t.token),
    orgIdx: uniqueIndex("org_invites_org_token_uniq").on(t.orgId, t.token),
  }),
);

export const orgInviteRedemptions = pgTable(
  "org_invite_redemptions",
  {
    inviteId: uuid("invite_id").notNull(),
    userId: uuid("user_id").notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.inviteId, t.userId] }),
  }),
);

export type OrgInvite = typeof orgInvites.$inferSelect;
export type NewOrgInvite = typeof orgInvites.$inferInsert;
export type OrgInviteRedemption = typeof orgInviteRedemptions.$inferSelect;
export type NewOrgInviteRedemption = typeof orgInviteRedemptions.$inferInsert;
