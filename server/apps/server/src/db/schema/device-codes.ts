import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const deviceCodes = pgTable("device_codes", {
  code: text("code").primaryKey(),
  status: text("status").notNull().default("pending"),
  userId: uuid("user_id"),
  sessionData: jsonb("session_data"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export type DeviceCode = typeof deviceCodes.$inferSelect;
export type NewDeviceCode = typeof deviceCodes.$inferInsert;
