import { z } from "zod";

// ── Request contracts ─────────────────────────────────────────────────

const INCLUDE_TYPES = ["memories", "episodes", "entities", "similarity"] as const;
export type GraphIncludeType = (typeof INCLUDE_TYPES)[number];

const ALL_INCLUDES: GraphIncludeType[] = [
  "memories",
  "episodes",
  "entities",
  "similarity",
];

const includeSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value): GraphIncludeType[] => {
    if (!value) return ALL_INCLUDES;
    const raw = Array.isArray(value) ? value : value.split(",");
    const trimmed = raw.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (trimmed.length === 0) return ALL_INCLUDES;
    const valid = trimmed.filter((entry): entry is GraphIncludeType =>
      INCLUDE_TYPES.includes(entry as GraphIncludeType),
    );
    return valid.length > 0 ? valid : ALL_INCLUDES;
  });

export const GraphProjectIdParamsSchema = z.object({
  project_id: z.string().uuid(),
});

export const GraphQuerySchema = z.object({
  focus: z.string().min(1).max(128).optional(),
  depth: z.coerce.number().int().min(1).max(5).default(2),
  include: includeSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type GraphQuery = z.infer<typeof GraphQuerySchema>;

// ── Response contracts ───────────────────────────────────────────────

export type GraphNodeType = "memory" | "episode" | "entity";

export const GraphMemoryNodeSchema = z.object({
  id: z.string(),
  type: z.literal("memory"),
  label: z.string(),
  kind: z.string().nullable(),
  confidence: z.number().nullable(),
  actor_id: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.string(),
});

export const GraphEpisodeNodeSchema = z.object({
  id: z.string(),
  type: z.literal("episode"),
  label: z.string(),
  summary: z.string().nullable(),
  member_count: z.number().int().min(0),
  archived: z.boolean(),
  created_at: z.string(),
});

export const GraphEntityNodeSchema = z.object({
  id: z.string(),
  type: z.literal("entity"),
  label: z.string(),
  neo4j_node_id: z.string().nullable(),
  entity_kind: z.string().nullable(),
  memory_count: z.number().int().min(0),
});

export const GraphNodeSchema = z.discriminatedUnion("type", [
  GraphMemoryNodeSchema,
  GraphEpisodeNodeSchema,
  GraphEntityNodeSchema,
]);
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const EDGE_KINDS = [
  "contributes_to",
  "supersedes",
  "extends",
  "forks",
  "mentions",
  "similar",
] as const;
export type GraphEdgeKind = (typeof EDGE_KINDS)[number];

export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum(EDGE_KINDS),
  weight: z.number().nullable().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  stats: z.object({
    node_count: z.number().int().min(0),
    edge_count: z.number().int().min(0),
    focus: z.string().nullable(),
    depth: z.number().int().min(0),
    truncated: z.boolean(),
    neo4j_available: z.boolean(),
  }),
  legend: z.object({
    node_types: z.array(z.enum(["memory", "episode", "entity"])),
    edge_kinds: z.array(z.enum(EDGE_KINDS)),
  }),
});
export type GraphResponse = z.infer<typeof GraphResponseSchema>;
