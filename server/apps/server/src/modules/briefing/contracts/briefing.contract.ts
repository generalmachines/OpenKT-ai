import { z } from "zod";

// Wire contracts for the briefings-v2 surface.
//
//   GET /v1/projects/:project_id/briefing
//   GET /v1/projects/:project_id/changelog?since=<iso8601>
//
// The briefing is a live view (one row per project, recomputed lazily
// when stale). The changelog is "what's new since timestamp X" — a
// composition of new memories, new episodes, archived memories, and
// superseded episodes, plus an LLM paragraph summarising the period.

const UUID = z.string().uuid("must be a UUID v4");

export const ProjectIdParamSchema = z.object({
  project_id: UUID,
});

export const ChangelogQuerySchema = z.object({
  since: z
    .string()
    .datetime({ offset: true, message: "since must be ISO 8601 with timezone offset" }),
});

// — Briefing response ——————————————————————————————————————————————

export const BriefingThemeSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  memory_ids: z.array(UUID).default([]),
  episode_ids: z.array(UUID).default([]),
});

export const BriefingDecisionSchema = z.object({
  summary: z.string(),
  episode_id: UUID.nullable().default(null),
  decided_at: z.string().nullable().default(null),
});

export const BriefingQuestionSchema = z.object({
  question: z.string(),
  raised_in_memory_id: UUID.nullable().default(null),
  raised_at: z.string().nullable().default(null),
});

export const BriefingResponseSchema = z.object({
  project_id: UUID,
  version: z.number().int(),
  generated_at: z.string(),
  stale_at: z.string().nullable(),
  stale: z.boolean(),
  memory_count_at_generation: z.number().int(),
  episode_count_at_generation: z.number().int(),
  summary: z.string(),
  themes: z.array(BriefingThemeSchema),
  key_decisions: z.array(BriefingDecisionSchema),
  open_questions: z.array(BriefingQuestionSchema),
  stats: z.record(z.string(), z.unknown()),
});

export type BriefingResponse = z.infer<typeof BriefingResponseSchema>;

// — Changelog response ————————————————————————————————————————————

export const ChangelogMemorySchema = z.object({
  id: UUID,
  kind: z.string(),
  preview: z.string(),
  tags: z.array(z.string()),
  created_at: z.string(),
  actor_id: UUID.nullable(),
});

export const ChangelogEpisodeSchema = z.object({
  id: UUID,
  summary: z.string().nullable(),
  action: z.enum(["created", "updated", "superseded"]),
  supersedes_episode_id: UUID.nullable(),
});

export const ChangelogArchivedMemorySchema = z.object({
  id: UUID,
  archived_at: z.string(),
});

export const ChangelogSupersededEpisodeSchema = z.object({
  id: UUID,
  superseded_by_episode_id: UUID.nullable(),
});

export const ChangelogResponseSchema = z.object({
  since: z.string(),
  until: z.string(),
  summary: z.string(),
  new_memories: z.array(ChangelogMemorySchema),
  new_episodes: z.array(ChangelogEpisodeSchema),
  archived_memories: z.array(ChangelogArchivedMemorySchema),
  superseded_episodes: z.array(ChangelogSupersededEpisodeSchema),
});

export type ChangelogResponse = z.infer<typeof ChangelogResponseSchema>;
