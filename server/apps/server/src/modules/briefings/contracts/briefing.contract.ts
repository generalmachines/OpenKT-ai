import { z } from "zod";

// Wire contracts for the team-briefing endpoints. Mirrors what the
// dashboard's TeamBriefing component already expects on the wire,
// so the frontend only swaps the URL — the envelope shape stays.

export const ProjectIdQuerySchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID v4"),
});

export const RefreshBriefingBodySchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID v4"),
});

export const BriefingRowSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  org_id: z.string().uuid().nullable(),
  generated_at: z.string(),
  briefing_md: z.string(),
  model: z.string(),
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  source_memory_count_at_generation: z.number(),
  source_memory_ids: z.array(z.string().uuid()),
  is_current: z.boolean(),
});

export const BriefingPayloadSchema = z.object({
  briefing: BriefingRowSchema.nullable(),
  is_demo: z.boolean(),
});

export type BriefingRow = z.infer<typeof BriefingRowSchema>;
export type BriefingPayload = z.infer<typeof BriefingPayloadSchema>;
