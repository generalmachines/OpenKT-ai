import { z } from "zod";

// Wire contracts for the per-contributor knowledge endpoints. The
// shape of `themes` is fixed: an array of { tag, weight, memory_count }
// triples ordered by weight desc.

// ── Route params ────────────────────────────────────────────────────

export const ProjectIdParamSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID v4"),
});

export const ProjectMemberParamsSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID v4"),
  user_id: z.string().uuid("user_id must be a UUID v4"),
});

// ── Query strings ───────────────────────────────────────────────────

export const MembersListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor_id: z.string().uuid().optional(),
});

// `user_ids=a,b,c` — comma-separated UUIDs. Zod parses + dedupes.
export const MembersMixQuerySchema = z.object({
  user_ids: z
    .string()
    .min(1, "user_ids is required")
    .transform((raw) => Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))))
    .pipe(z.array(z.string().uuid("each user_ids entry must be a UUID v4")).min(1).max(50)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── Response shapes ─────────────────────────────────────────────────

export const ThemeSchema = z.object({
  tag: z.string(),
  weight: z.number(),
  memory_count: z.number().int().nonnegative().optional(),
});

export const MemberSummarySchema = z.object({
  user_id: z.string().uuid(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  memory_count: z.number().int().nonnegative(),
  episode_count: z.number().int().nonnegative(),
  themes: z.array(ThemeSchema),
  summary: z.string().nullable(),
  last_contribution_at: z.string().nullable(),
});

export const MembersListPayloadSchema = z.object({
  data: z.array(MemberSummarySchema),
  meta: z.object({
    project_id: z.string().uuid(),
    total: z.number().int().nonnegative(),
  }),
});

export const RecentMemorySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  preview: z.string(),
  created_at: z.string(),
});

export const MemberDetailStatsSchema = z.object({
  memory_count: z.number().int().nonnegative(),
  episode_count: z.number().int().nonnegative(),
  first_contribution_at: z.string().nullable(),
  last_contribution_at: z.string().nullable(),
  tags_owned: z.array(z.string()),
});

export const MemberDetailPayloadSchema = z.object({
  user_id: z.string().uuid(),
  display_name: z.string().nullable(),
  summary: z.string().nullable(),
  themes: z.array(ThemeSchema),
  stats: MemberDetailStatsSchema,
  recent_memories: z.array(RecentMemorySchema),
});

export const MemberMemoryItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  content: z.string(),
  owner_user_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const MembersMixPayloadSchema = z.object({
  data: z.array(MemberMemoryItemSchema),
  meta: z.object({
    project_id: z.string().uuid(),
    user_ids: z.array(z.string().uuid()),
    total: z.number().int().nonnegative(),
  }),
});

export type Theme = z.infer<typeof ThemeSchema>;
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
export type MembersListPayload = z.infer<typeof MembersListPayloadSchema>;
export type MemberDetailPayload = z.infer<typeof MemberDetailPayloadSchema>;
export type MembersMixPayload = z.infer<typeof MembersMixPayloadSchema>;
export type MemberMemoryItem = z.infer<typeof MemberMemoryItemSchema>;
export type RecentMemory = z.infer<typeof RecentMemorySchema>;
