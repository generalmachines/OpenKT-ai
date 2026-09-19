import { z } from "zod";

// Zod contracts for the v1 observability surface. Snake-case is the
// wire shape; the controllers parse with these schemas so any drift
// between dashboard expectations and runtime returns 422 rather than
// silently returning a wrong-shape payload.

export const Uuid = z.string().uuid();

export const LlmCallStatusSchema = z.enum([
  "success",
  "error",
  "timeout",
  "rate_limited",
  "quota_exceeded",
]);

export const LlmCallListQuerySchema = z
  .object({
    project_id: Uuid.optional(),
    user_id: Uuid.optional(),
    provider: z.string().min(1).max(64).optional(),
    stage: z.string().min(1).max(64).optional(),
    status: LlmCallStatusSchema.optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().optional(),
  })
  .passthrough();

export type LlmCallListQuery = z.infer<typeof LlmCallListQuerySchema>;

export const UsageQuerySchema = z
  .object({
    project_id: Uuid.optional(),
    user_id: Uuid.optional(),
    provider: z.string().min(1).max(64).optional(),
    group_by: z.enum(["day", "hour", "provider", "stage"]).default("day"),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const PipelineHealthQuerySchema = z
  .object({
    project_id: Uuid.optional(),
  })
  .passthrough();

export const ProjectUsageParamsSchema = z.object({ project_id: Uuid });
export const UserQuotaParamsSchema = z.object({ user_id: Uuid });

export interface LlmCallRow {
  id: string;
  project_id: string | null;
  user_id: string | null;
  provider: string;
  model: string;
  stage: string;
  purpose: string | null;
  memory_id: string | null;
  episode_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: string;
  latency_ms: number;
  status: string;
  error_reason: string | null;
  request_id: string | null;
  created_at: string;
}

export interface UsageBucketRow {
  bucket: string;
  provider: string;
  stage: string | null;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
}
