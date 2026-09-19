// Kinds — the fixed set and its mapping to the existing `memory_kind` enum
// (Spec 02 §7). The enum is not altered in v0.1; product kinds ride on
// `note` with a marker tag.

import type { Kind } from "./types.js";

export type DbKind = "decision" | "fact" | "pattern" | "incident" | "note";

const KINDS: readonly Kind[] = ["decision", "fact", "how-to", "issue", "question", "action", "idea"];

export function mapKind(kind: Kind): { dbKind: DbKind; extraTags: string[] } {
  switch (kind) {
    case "decision":
      return { dbKind: "decision", extraTags: [] };
    case "fact":
      return { dbKind: "fact", extraTags: [] };
    case "how-to":
      return { dbKind: "pattern", extraTags: [] };
    case "issue":
      return { dbKind: "incident", extraTags: [] };
    case "question":
      return { dbKind: "note", extraTags: ["open-question"] };
    case "action":
      return { dbKind: "note", extraTags: ["action"] };
    case "idea":
      return { dbKind: "note", extraTags: ["idea"] };
  }
}

const DB_TO_KIND: Record<string, Kind> = {
  decision: "decision",
  fact: "fact",
  pattern: "how-to",
  incident: "issue",
};

export function unmapKind(dbKind: string, tags: string[]): Kind {
  if (dbKind === "note") {
    if (tags.includes("open-question")) return "question";
    if (tags.includes("action")) return "action";
    if (tags.includes("idea")) return "idea";
    return "fact";
  }
  return KINDS.includes(DB_TO_KIND[dbKind] as Kind) ? (DB_TO_KIND[dbKind] as Kind) : "fact";
}
