// Shared types for the write path. Field names follow docs/specs/01-memory-overlays.md.

export type Kind = "decision" | "fact" | "how-to" | "issue" | "question" | "action" | "idea";

export const KIND_PRIORITY: readonly Kind[] = ["decision", "issue", "how-to", "action", "question", "fact", "idea"];

export type TurnRole = "user" | "assistant" | "speaker" | "system" | "note";

export interface Turn {
  seq: number;
  role: TurnRole;
  speaker?: string;
  content: string;
  t0_ms?: number;
  t1_ms?: number;
  /** present when one oversized turn was split into parts (J20) */
  part?: number;
}

export interface ExtractedFact {
  statement: string;
  quote: string;
  kind: Kind;
}

/** An existing fact as seen by duplicate / routing logic. */
export interface FactRef {
  id: string;
  project_id: string;
  statement: string;
  kind: Kind;
  created_at: string; // ISO-8601 with `Z` or an offset; compare as instants (Date.parse), never as text
  owner_user_id: string;
  is_pinned: boolean;
  confidence: number;
}

export interface Neighbour extends FactRef {
  similarity: number; // cosine, 0..1
}
