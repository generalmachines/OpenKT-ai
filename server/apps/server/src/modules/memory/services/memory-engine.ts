import type { ActorContext } from "@openkt/core-context";

import type {
  MemoryRecord,
  MemorySearchMeta,
  MemorySearchRequest,
  MemoryWithSimilarityRecord,
  RecallMeta,
} from "../contracts/memory.contract";

export const MEMORY_ENGINE = Symbol("MEMORY_ENGINE");

export interface MemorySearchScopeOptions {
  // Search ONLY facts saved in these sessions. Set when the asker cannot
  // read the space but holds a grant on some of its sessions (Spec 01 §2
  // visible_sessions): they see those sessions' facts and nothing else
  // from the space.
  onlySessionIds?: string[];
  // Search every space the asker can read, plus every session granted to
  // them one by one, instead of `filters.project_ids` (recall/search with no
  // space given). The access rule is a subquery inside the ranking SQL
  // (access/readable-sql.ts), so nothing is ranked before it is authorised.
  everyReadableSpace?: boolean;
}

export interface MemoryEngine {
  remember(context: ActorContext, memory: MemoryRecord): Promise<void>;
  forget(context: ActorContext, memoryId: string, hard: boolean): Promise<void>;
  search(
    context: ActorContext,
    request: MemorySearchRequest,
    workspaceIds: string[],
    // Sessions the asker holds a direct grant on (AccessScopeService,
    // M4) — the escape hatch that lets a `visibility: 'personal'`
    // memory be seen by someone other than its owner: architecture.md
    // §3 "A fact extracted from a private session stays private until
    // the session is shared". Defaults to [] for callers that haven't
    // been updated yet (list/browse paths that don't touch personal
    // memories owned by someone else).
    grantedSessionIds?: string[],
    options?: MemorySearchScopeOptions,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta }>;
  recall(
    context: ActorContext,
    searchResult: { data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta },
    invocationId?: string,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }>;
}
