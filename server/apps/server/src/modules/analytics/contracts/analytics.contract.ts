import { z } from "zod";

// Zod contracts for the /v1/analytics/* + /v1/orgs/:org_id/analytics
// surfaces. The query params are coerced from raw URLSearchParams strings.

const UUID = z.string().uuid();
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const SelfAnalyticsQuerySchema = z.object({
  since: DateOnly.optional(),
  until: DateOnly.optional(),
  days: z.coerce.number().int().min(1).max(180).default(30),
});

export type SelfAnalyticsQuery = z.infer<typeof SelfAnalyticsQuerySchema>;

export const OrgAnalyticsParamsSchema = z.object({
  org_id: UUID,
});

export const OrgAnalyticsQuerySchema = z.object({
  since: DateOnly.optional(),
  until: DateOnly.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  // Comma-separated subset of: user_breakdown
  include: z.string().max(120).optional(),
});

export type OrgAnalyticsQuery = z.infer<typeof OrgAnalyticsQuerySchema>;

export const AdminAnalyticsQuerySchema = z.object({
  since: DateOnly.optional(),
  until: DateOnly.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export type AdminAnalyticsQuery = z.infer<typeof AdminAnalyticsQuerySchema>;
