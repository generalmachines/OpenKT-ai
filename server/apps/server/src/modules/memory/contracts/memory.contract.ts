import { z } from "zod";

export const UUID = z.string().uuid();
export const ISO = z.string().datetime({ offset: true });

export const MemoryKindSchema = z.enum([
  "decision",
  "pattern",
  "incident",
  "skill",
  "context",
  "anti-pattern",
  "debug-recipe",
  "environment",
  "note",
  "fact",
  "other",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryVisibilitySchema = z.enum(["personal", "project", "org"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

export const SearchModeSchema = z.enum(["vector", "keyword", "hybrid"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const MEMORY_CONTENT_MAX = 20_000;
export const MEMORY_TAGS_MAX = 8;

const TagSlugSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "tag: lowercase kebab, 2-40 chars");

const SourceRefSchema = z.object({
  kind: z.enum(["commit", "pr", "issue", "url", "file", "decision"]),
  ref: z.string().min(1).max(512),
});
export type SourceRefRecord = z.infer<typeof SourceRefSchema>;

export const MemoryAuthorSchema = z.object({
  user_id: UUID,
  email: z.string().email().nullable(),
  display_name: z.string().nullable(),
});
export type MemoryAuthorRecord = z.infer<typeof MemoryAuthorSchema>;

export const MemoryTagSchema = z.object({
  id: UUID,
  slug: TagSlugSchema,
  display_name: z.string().min(1).max(80),
});
export type MemoryTagRecord = z.infer<typeof MemoryTagSchema>;

export const MemoryProjectSchema = z.object({
  id: UUID,
  slug: z.string(),
  name: z.string(),
  visibility: z.enum(["personal", "org", "public"]),
});
export type MemoryProjectRecord = z.infer<typeof MemoryProjectSchema>;

export const DecayStateSchema = z.enum(["fresh", "warm", "decaying", "stale"]);
export type DecayStateName = z.infer<typeof DecayStateSchema>;

export const MemoryRecordSchema = z.object({
  id: UUID,
  org_id: UUID.nullable(),
  project_id: UUID,
  owner: MemoryAuthorSchema,
  content: z.string().min(1).max(MEMORY_CONTENT_MAX),
  kind: MemoryKindSchema,
  category: z.string().max(64).nullable(),
  tags: z.array(MemoryTagSchema).max(MEMORY_TAGS_MAX),
  visibility: MemoryVisibilitySchema,
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  decay_lambda: z.number().min(0).max(1),
  importance_at: ISO,
  // Importance after exponential decay against `importance_at`. Pure
  // function of the three columns above; the API computes it so the
  // UI doesn't have to replicate the formula.
  importance_now: z.number().min(0).max(1),
  decay_state: DecayStateSchema,
  access_count: z.number().int().min(0),
  last_accessed_at: ISO.nullable(),
  source_refs: z.array(SourceRefSchema),
  superseded_by: UUID.nullable(),
  archived: z.boolean(),
  created_at: ISO,
  updated_at: ISO,
  project: MemoryProjectSchema,
  // T0 provenance (migration 0037): which session this fact was saved
  // from, and which connector produced it. Both null for memories
  // written outside any session (dashboard "add memory", pre-existing
  // rows). See docs/architecture.md §2 (T0→T1 pointer).
  session_id: UUID.nullable(),
  source: z.string().nullable(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryWithSimilaritySchema = MemoryRecordSchema.extend({
  similarity: z.number().min(0).max(1).nullable(),
  source_scope: z.enum(["primary", "workspace"]),
  effective_importance: z.number().min(0).max(1),
});
export type MemoryWithSimilarityRecord = z.infer<typeof MemoryWithSimilaritySchema>;

export const ListMemoriesQuerySchema = z.object({
  project_id: UUID,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  include_archived: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .default(false),
  q: z.string().max(200).optional(),
  kind: MemoryKindSchema.optional(),
  visibility: MemoryVisibilitySchema.optional(),
  min_confidence: z.coerce.number().min(0).max(1).optional(),
  tag: z.string().max(100).optional(),
});
export type ListMemoriesQuery = z.infer<typeof ListMemoriesQuerySchema>;

export interface MemoryListMeta {
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export const MemoryIdParamsSchema = z.object({ id: UUID });
export type MemoryIdParams = z.infer<typeof MemoryIdParamsSchema>;

// GET /v1/memories/:memory_id/neighbors
//
// Returns the pre-computed top-N neighbors for a memory (rows in
// `memory_neighbors`). The default limit (10) keeps the UI panel
// bounded; min_similarity defaults to 0.5, matching the stage's
// own storage floor.
export const MemoryNeighborParamsSchema = z.object({ memory_id: UUID });
export type MemoryNeighborParams = z.infer<typeof MemoryNeighborParamsSchema>;

export const MemoryNeighborsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  min_similarity: z.coerce.number().min(0).max(1).default(0.5),
});
export type MemoryNeighborsQuery = z.infer<typeof MemoryNeighborsQuerySchema>;

export const MemoryNeighborRecordSchema = z.object({
  id: UUID,
  kind: MemoryKindSchema,
  content_preview: z.string(),
  tags: z.array(MemoryTagSchema),
  similarity: z.number().min(0).max(1),
  computed_at: ISO,
});
export type MemoryNeighborRecord = z.infer<typeof MemoryNeighborRecordSchema>;

// DELETE /memories/:id?hard=true. Default is soft (archive); `hard=true` is
// the destructive variant that drops the row outright. Boolean coercion
// matches the legacy contract so existing callers keep working.
export const DeleteMemoryInputSchema = z.object({
  id: UUID,
  hard: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .default(false),
});
export type DeleteMemoryInput = z.infer<typeof DeleteMemoryInputSchema>;

export interface DeleteMemoryResult {
  id: string;
  archived: boolean;
  hard: boolean;
}

export const CreateMemorySchema = z.object({
  content: z.string().min(1).max(MEMORY_CONTENT_MAX),
  kind: MemoryKindSchema.default("note"),
  project_id: z.string().min(1).max(256).optional(),
  visibility: MemoryVisibilitySchema.default("project"),
  tag_slugs: z.array(TagSlugSchema).max(MEMORY_TAGS_MAX).default([]),
  category: z.string().max(64).nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  importance: z.number().min(0).max(1).default(0.5),
  source_refs: z.array(SourceRefSchema).default([]),
  // Optional session this save happened inside of. When set, the
  // memory is stamped with the session's connector as `source` and
  // the session's `last_activity_at` is bumped — save-at-decision-
  // points (architecture.md §4) without a separate "touch" call.
  session_id: UUID.optional(),
});
export type CreateMemoryInput = z.infer<typeof CreateMemorySchema>;

export const EnhanceMemorySchema = z.object({
  content: z.string().min(1).max(MEMORY_CONTENT_MAX),
  existing_tags: z.array(TagSlugSchema).max(MEMORY_TAGS_MAX).default([]),
  action: z.enum(["content", "tags", "both"]).default("both"),
});
export type EnhanceMemoryInput = z.infer<typeof EnhanceMemorySchema>;

export const EnhancedMemorySchema = z.object({
  enhanced_content: z.string().min(1).max(MEMORY_CONTENT_MAX),
  tags: z.array(TagSlugSchema).max(MEMORY_TAGS_MAX),
  kind: MemoryKindSchema,
});
export type EnhancedMemoryResult = z.infer<typeof EnhancedMemorySchema>;

export const MemoryGateSuggestionSchema = z.object({
  verdict: z.enum(["accept", "reject-too-long", "reject-better-as-skill"]),
  reason: z.string(),
  suggested_skill: z
    .object({
      slug_suggestion: z.string().min(1).max(128),
      title_suggestion: z.string(),
      preview: z.string(),
    })
    .nullable(),
});
export type MemoryGateSuggestion = z.infer<typeof MemoryGateSuggestionSchema>;

export interface MemoryAccessSummary {
  viewer_count: number;
  recall_count: number;
  last_recall_at: string | null;
  last_view_at: string | null;
  top_viewers: Array<{
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
    view_count: number;
    last_at: string;
  }>;
}

export const MemorySearchFiltersSchema = z.object({
  project_ids: z.array(UUID).max(50).optional(),
  visibility: z.array(MemoryVisibilitySchema).optional(),
  authors: z.array(UUID).max(50).optional(),
  kinds: z.array(MemoryKindSchema).optional(),
  tags: z
    .object({
      any: z.array(UUID).max(20).optional(),
      all: z.array(UUID).max(20).optional(),
      none: z.array(UUID).max(20).optional(),
    })
    .optional(),
  created_after: ISO.optional(),
  created_before: ISO.optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  min_similarity: z.number().min(0).max(1).optional(),
  include_archived: z.boolean().default(false),
  include_superseded: z.boolean().default(false),
});
export type MemorySearchFilters = z.infer<typeof MemorySearchFiltersSchema>;

export const MemorySearchRequestSchema = z.object({
  query: z.string().max(2_000).default(""),
  mode: SearchModeSchema.default("hybrid"),
  vector_weight: z.number().min(0).max(1).default(0.6),
  workspace_weight: z.number().min(0).max(1).default(0.4),
  filters: MemorySearchFiltersSchema.default(() => MemorySearchFiltersSchema.parse({})),
  limit: z.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

export interface MemorySearchMeta {
  total_matched: number;
  mode: SearchMode;
  vector_weight: number | null;
  embedding_model: string;
  next_cursor: string | null;
  query_ms: number;
  workspace_weight: number;
  workspace_size: number;
}

export const RecallRequestSchema = z.object({
  project_id: z.string().min(1).max(256).optional(),
  // Optional session this recall happened inside of. When set, the
  // session's last_activity_at is bumped — a recall counts as
  // "the session is still active" the same way a save does.
  session_id: UUID.optional(),
  query: z.string().max(2_000).default(""),
  kind: MemoryKindSchema.optional(),
  min_confidence: z.number().min(0).max(1).default(0),
  workspace_weight: z.number().min(0).max(1).default(0.4),
  vector_weight: z.number().min(0).max(1).default(0.6),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  invocation_id: UUID.optional(),
  rerank: z.boolean().default(false),
  // Knowledge-synthesis layer opt-in. CLI clients keep the default
  // (false) and receive an unchanged payload — knowledge nodes only
  // appear in `meta.knowledge` when explicitly requested.
  include_knowledge: z.boolean().default(false),
});
export type RecallRequest = z.infer<typeof RecallRequestSchema>;

export const KnowledgeNodeSchema = z.object({
  id: UUID,
  summary: z.string(),
  tags: z.array(z.string()),
  confidence: z.number().min(0).max(1).nullable(),
  supporting_memory_ids: z.array(UUID),
  created_at: ISO,
  updated_at: ISO,
});
export type KnowledgeNode = z.infer<typeof KnowledgeNodeSchema>;

/** A page section returned by recall (Spec 01 §4 lists C and D): the default retrieval unit. */
export interface RecallSection {
  id: string;
  type: "section";
  heading: string;
  /** The section's text with the citation markers removed. */
  text: string;
  page: { id: string; title: string };
  space: { id: string; name: string };
  locked: boolean;
  updated_at: string;
  score: number;
}

export interface RecallMeta {
  query_ms: number;
  knowledge?: KnowledgeNode[];
  /** Page sections from the same spaces the facts came from, best first. */
  sections?: RecallSection[];
}

export const EpisodeIdParamsSchema = z.object({ id: UUID });
export type EpisodeIdParams = z.infer<typeof EpisodeIdParamsSchema>;

export const AnswerRequestSchema = z.object({
  project_id: z.string().min(1).max(256).optional(),
  question: z.string().min(1).max(2_000),
  limit: z.coerce.number().int().min(3).max(30).default(15),
  vector_weight: z.number().min(0).max(1).default(0.6),
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

export interface AnswerCitation {
  memory_id: string;
  quote: string;
}

export interface AnswerResult {
  answer: string | null;
  citations: AnswerCitation[];
  confidence: number;
  used_provider: string | null;
  recalled: Array<{
    id: string;
    content: string;
    kind: string;
    similarity: number | null;
  }>;
  meta: {
    query_ms: number;
    recall_count: number;
  };
}
