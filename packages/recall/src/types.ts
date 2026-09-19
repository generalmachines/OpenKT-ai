// Shared types for recall. Field names follow docs/specs/01-memory-overlays.md section 4
// and docs/specs/04-api-contract.md (RecallItem).

export type ItemType = "fact" | "section";

/** S0 same session · S1 personal space · S2 named space · S3 other readable space · S4 workspace-shared space */
export type Scope = "S0" | "S1" | "S2" | "S3" | "S4";

export interface Candidate {
  id: string;
  type: ItemType;
  text: string;
  project_id: string;
  session_id?: string;
  page_id?: string;
  /** ids of facts a section cites; empty for facts */
  cites: string[];
  created_at: string; // ISO-8601
  is_pinned: boolean;
  locked: boolean; // human-edited section
  recalls_30d_unused: number;
  /** 1-based rank in each candidate list the item appeared in; absent = not in that list */
  ranks: { vector?: number; keyword?: number };
  /** cosine similarity to the query, when the item came from a vector list */
  similarity?: number;
  scope: Scope;
}

export interface Scored extends Candidate {
  fused: number;
  weighted: number;
  rerank?: number;
  score: number;
}
