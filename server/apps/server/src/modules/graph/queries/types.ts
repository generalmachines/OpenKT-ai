import type { ZodSchema } from "zod";

// Shared types for the named Cypher query library.
//
// Each query in `./` exports a `CypherQuery` describing how the UI may
// invoke it: the Zod schema validates incoming params, `buildCypher`
// produces the parameterized Cypher (project_id is always bound from
// the URL path so a client can never override it), and `parseResult`
// converts the Neo4j records into a generic node/edge shape.
//
// Some queries don't actually read from Neo4j (episode_lineage is
// Postgres-only, tag_contributors is Postgres-only) — for those the
// service short-circuits Neo4j entirely and calls `runPostgres()`
// instead, but they still implement the same Zod params + result
// shape so the controller can treat them uniformly.

export interface GraphLibraryNode {
  id: string;
  type: string;
  label: string;
  [extra: string]: unknown;
}

export interface GraphLibraryEdge {
  source: string;
  target: string;
  kind: string;
  weight?: number | null;
  [extra: string]: unknown;
}

export interface GraphLibraryResult {
  nodes: GraphLibraryNode[];
  edges: GraphLibraryEdge[];
  stats?: Record<string, unknown>;
}

// A row-shaped subset of the neo4j-driver record. Matches the shape
// already used by Neo4jService — keeps us from needing to import the
// optional neo4j-driver types.
export interface Neo4jRecordLike {
  keys: string[];
  get: (key: string) => unknown;
  toObject?: () => Record<string, unknown>;
}

export interface BuildCypherOutput {
  cypher: string;
  params: Record<string, unknown>;
}

// Backend the dispatcher uses to execute a query. Each backend is
// supplied by the GraphQueryService — queries don't talk to the driver
// or to Postgres directly, they just declare what they need.
export type CypherQueryBackend = "neo4j" | "postgres";

export interface CypherQuery<P = unknown> {
  name: string;
  description: string;
  backend: CypherQueryBackend;
  paramSchema: ZodSchema<P>;
  // Build the Cypher template + bound params. For postgres-backed
  // queries this returns SQL in `cypher` and SQL params keyed by name.
  buildCypher(params: P, project_id: string): BuildCypherOutput;
  // Convert raw records → node/edge shape. Postgres-backed queries
  // are still passed a record-like array.
  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult;
}

// Defense-in-depth: even though every query in the registry is static
// code we own, we still scrub the produced Cypher for write keywords
// before sending it to the driver. Cheap and catches future
// programmer error.
const FORBIDDEN_CYPHER_KEYWORDS = [
  "\\bCREATE\\b",
  "\\bMERGE\\b",
  "\\bDELETE\\b",
  "\\bSET\\b",
  "\\bDROP\\b",
  "\\bREMOVE\\b",
  "\\bCALL\\s+apoc\\.(create|merge|refactor)",
];

const FORBIDDEN_PATTERN = new RegExp(FORBIDDEN_CYPHER_KEYWORDS.join("|"), "i");

export function assertReadOnlyCypher(cypher: string): void {
  if (FORBIDDEN_PATTERN.test(cypher)) {
    throw new Error(
      `read-only guard tripped: cypher contains a write keyword (${cypher.slice(0, 120)}…)`,
    );
  }
}
