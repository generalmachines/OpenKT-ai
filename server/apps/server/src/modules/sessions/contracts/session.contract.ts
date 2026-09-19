import { z } from "zod";

export const UUID = z.string().uuid();
export const ISO = z.string().datetime({ offset: true });

// Connectors that can open a session — product.md "Connector". Kept
// as a zod enum (application boundary) over a free-text column
// (`sessions.source` is `text`, not a pg enum) so new connectors never
// require a migration; only this list needs a one-line addition.
export const SessionSourceSchema = z.enum([
  "claude-code",
  "chatgpt",
  "claude",
  "mcp",
  "voice",
  "meeting",
  "screenshot",
  "note",
  "connector",
]);
export type SessionSource = z.infer<typeof SessionSourceSchema>;

export const SessionStatusSchema = z.enum(["open", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionTurnRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type SessionTurnRole = z.infer<typeof SessionTurnRoleSchema>;

export const SessionRecordSchema = z.object({
  id: UUID,
  org_id: UUID.nullable(),
  project_id: UUID,
  owner_user_id: UUID,
  source: SessionSourceSchema,
  client: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  status: SessionStatusSchema,
  started_at: ISO,
  ended_at: ISO.nullable(),
  last_activity_at: ISO,
  metadata: z.record(z.string(), z.unknown()),
  created_at: ISO,
  updated_at: ISO,
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const SessionTurnRecordSchema = z.object({
  id: UUID,
  session_id: UUID,
  seq: z.number().int().min(1),
  role: SessionTurnRoleSchema,
  content: z.string(),
  created_at: ISO,
  metadata: z.record(z.string(), z.unknown()),
});
export type SessionTurnRecord = z.infer<typeof SessionTurnRecordSchema>;

export const CreateSessionSchema = z.object({
  // Same slug-or-uuid-or-empty convention as memory.contract's
  // CreateMemorySchema.project_id — resolved through
  // ProjectScopeService.resolveProjectIdOrSlug, so an omitted
  // project_id lazily creates/reuses the caller's personal project
  // (product.md "Every person has a private personal space").
  project_id: z.string().min(1).max(256).optional(),
  source: SessionSourceSchema.default("mcp"),
  client: z.string().max(120).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export const AddSessionTurnSchema = z.object({
  role: SessionTurnRoleSchema,
  content: z.string().min(1).max(50_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AddSessionTurnInput = z.infer<typeof AddSessionTurnSchema>;

export const CloseSessionSchema = z.object({
  summary: z.string().max(20_000).nullable().optional(),
});
export type CloseSessionInput = z.infer<typeof CloseSessionSchema>;

export const SessionIdParamsSchema = z.object({ id: UUID });
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;

export const ListSessionsQuerySchema = z.object({
  project_id: z.string().min(1).max(256).optional(),
  status: SessionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export interface SessionListMeta {
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}
