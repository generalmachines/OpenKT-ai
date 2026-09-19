import { z } from "zod";

export const UUID = z.string().uuid();
export const ISO = z.string().datetime({ offset: true });

// Connectors that can open a session — product.md "Connector". Kept
// as a zod enum (application boundary) over a free-text column
// (`sessions.source` is `text`, not a pg enum) so new connectors never
// require a migration; only this list needs a one-line addition.
// The tool ids are those of `packages/connect` (`kt connect <tool>`) and the
// desktop app; `connector` is for anything else (say which in `client`).
export const SESSION_SOURCES = [
  // coding agents and editors
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "windsurf",
  "opencode",
  "vscode",
  // assistants and agents
  "claude-desktop",
  "claude-ai",
  "claude",
  "cowork",
  "chatgpt",
  "hermes",
  "mcp",
  // the desktop app's own captures
  "voice",
  "screenshot",
  "meeting",
  "note",
  "connector",
] as const;
export const SessionSourceSchema = z.enum(SESSION_SOURCES);
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
  // The conversation's id and link in the tool it came from; `(source,
  // external_id)` names one session per owner (migration 0045).
  external_id: z.string().nullable(),
  external_url: z.string().nullable(),
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
  // Spec 04: the same `(source, external_id)` again → 200 with the existing
  // session, so a hook or an import that retries never makes a duplicate.
  external_id: z.string().min(1).max(256).optional(),
  external_url: z.string().url().max(2048).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export const AddSessionTurnSchema = z.object({
  role: SessionTurnRoleSchema,
  content: z.string().min(1).max(50_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AddSessionTurnInput = z.infer<typeof AddSessionTurnSchema>;

// Spec 04: `{turns:[{role, speaker?, content, t0_ms?, t1_ms?}]}` → `{appended,
// next_seq}`. At most 200 turns and 1 MB of text per call. `speaker` and the
// timings ride in each turn's metadata.
export const SESSION_TURNS_MAX = 200;
export const SESSION_TURNS_MAX_BYTES = 1024 * 1024;
export const BatchSessionTurnSchema = z.object({
  role: SessionTurnRoleSchema,
  speaker: z.string().max(200).optional(),
  content: z.string().min(1).max(50_000),
  t0_ms: z.number().int().min(0).optional(),
  t1_ms: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const AddSessionTurnsSchema = z.object({
  turns: z.array(BatchSessionTurnSchema).min(1).max(SESSION_TURNS_MAX),
});
export type AddSessionTurnsInput = z.infer<typeof AddSessionTurnsSchema>;

export const CloseSessionSchema = z.object({
  summary: z.string().max(20_000).nullable().optional(),
});
export type CloseSessionInput = z.infer<typeof CloseSessionSchema>;

// PATCH /v1/sessions/:id (the session's owner): move it into another space
// the owner can write — its facts move with it — and/or rename it.
export const UpdateSessionSchema = z
  .object({
    project_id: z.string().min(1).max(256).optional(),
    title: z.string().max(200).nullable().optional(),
  })
  .refine((v) => v.project_id !== undefined || v.title !== undefined, {
    message: "pass project_id and/or title",
  });
export type UpdateSessionInput = z.infer<typeof UpdateSessionSchema>;

export const SessionIdParamsSchema = z.object({ id: UUID });
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;

export const ListSessionsQuerySchema = z.object({
  project_id: z.string().min(1).max(256).optional(),
  // `shared=true`: the sessions other people shared with the caller one by
  // one (a session grant), whatever space they are in — "Shared with you".
  shared: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .default(false),
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
