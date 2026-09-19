// Worker-side bridge to MemMachine. The server has its own
// MemMachineClient inside the MemoryModule; the worker can't import
// from apps/server/, so this file is a focused, separate client whose
// jobs are:
//   1. "find candidate memories similar to this one" — used by triage
//      when OpenKT's pgvector embedding isn't available
//   2. "fetch the rich MemMachine graph for this memory" — used by
//      synthesize to persist MemMachine's canonical statements +
//      semantic items + relation triples into `memmachine_nodes`
//
// We intentionally do NOT mirror the full MemMachineClient surface
// here — write/forget happen in the server's request path, never in
// the worker.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface MemMachineEpisode {
  uid?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

interface MemMachineSemanticItem {
  uid?: string;
  content?: string;
  // Some MemMachine deployments tag semantic items with a `kind` of
  // "statement" or "fact" vs "relation" (s/p/o triple). Both shapes
  // come back from `semantic_memory[*]`.
  kind?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface MemMachineCandidate {
  openktMemoryId: string;
  similarity: number;
}

// One MemMachine node, in the shape the synthesize stage persists. The
// bridge normalizes the raw MemMachine response into this discriminated
// union so the persistence layer doesn't have to know the API shape.
export type MemMachineGraphNode =
  | {
      nodeKind: "episodic";
      externalId: string | null;
      statement: string | null;
      score: number | null;
      metadata: Record<string, unknown>;
    }
  | {
      nodeKind: "semantic";
      externalId: string | null;
      statement: string | null;
      score: number | null;
      metadata: Record<string, unknown>;
    }
  | {
      nodeKind: "relation";
      externalId: string | null;
      statement: string | null;
      subject: string | null;
      predicate: string | null;
      object: string | null;
      score: number | null;
      metadata: Record<string, unknown>;
    };

@Injectable()
export class MemMachineBridgeService {
  private readonly logger = new Logger(MemMachineBridgeService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = (
      this.configService.get<string>("OPENKT_MEMMACHINE_URL") ?? "http://127.0.0.1:8091"
    ).replace(/\/+$/, "");
    this.timeoutMs =
      this.configService.get<number>("OPENKT_MEMMACHINE_TIMEOUT_MS") ?? 20_000;
  }

  isEnabled(): boolean {
    return (
      (this.configService.get<string>("OPENKT_MEMORY_ENGINE") ?? "").toLowerCase() ===
      "memmachine"
    );
  }

  // Map OpenKT (org_id, project_id, owner_user_id) to MemMachine
  // (org_id, project_id) using the same convention the server uses.
  // Personal-scope memories collapse under `personal:<owner>` so the
  // worker doesn't have to look up org_members.
  namespace(memory: { org_id: string | null; project_id: string; owner_user_id: string }): {
    orgId: string;
    projectId: string;
  } {
    return {
      orgId: memory.org_id ?? `personal:${memory.owner_user_id}`,
      projectId: memory.project_id,
    };
  }

  // Find OpenKT memory IDs whose MemMachine embeddings are most
  // similar to `query`, scoped to the same MemMachine namespace.
  // Used by triage to short-list duplicate / supersede candidates.
  async findCandidates(args: {
    orgId: string;
    projectId: string;
    query: string;
    limit: number;
    excludeMemoryId?: string;
  }): Promise<MemMachineCandidate[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v2/memories/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: args.orgId,
          project_id: args.projectId,
          query: args.query,
          top_k: args.limit + (args.excludeMemoryId ? 1 : 0),
          types: ["episodic"],
          expand_context: 0,
          agent_mode: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.logger.warn(
          `[memmachine.bridge] search failed status=${response.status} body=${text.slice(0, 200)}`,
        );
        return [];
      }
      const body = (await response.json()) as {
        content?: {
          episodic_memory?: {
            long_term_memory?: { episodes?: MemMachineEpisode[] };
            short_term_memory?: { episodes?: MemMachineEpisode[] };
          };
        };
      };
      const longTerm = body.content?.episodic_memory?.long_term_memory?.episodes ?? [];
      const shortTerm = body.content?.episodic_memory?.short_term_memory?.episodes ?? [];
      const episodes = [...longTerm, ...shortTerm];

      const results: MemMachineCandidate[] = [];
      const seen = new Set<string>();
      for (const ep of episodes) {
        const memoryId = readOpenktMemoryId(ep.metadata);
        if (!memoryId) continue;
        if (memoryId === args.excludeMemoryId) continue;
        if (seen.has(memoryId)) continue;
        seen.add(memoryId);
        // MemMachine returns scores in different ranges depending on
        // ranking method. Normalize to [0,1] so the triage threshold
        // (>=0.5) keeps making sense.
        const raw = typeof ep.score === "number" ? ep.score : 0;
        const similarity = raw <= 1 ? raw : raw / (raw + 1);
        results.push({ openktMemoryId: memoryId, similarity });
        if (results.length >= args.limit) break;
      }
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[memmachine.bridge] search threw: ${message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fetch the rich MemMachine response for the given OpenKT memory and
  // normalize it into MemMachineGraphNode rows. We use MemMachine's
  // own search endpoint with the memory's content as the query because
  // the public v2 API doesn't expose a "get by openkt_memory_id"
  // route — the canonical statement MemMachine stored for a memory is
  // the top hit when you search for that memory's content. We filter
  // the returned hits by `metadata.openkt_memory_id == memoryId` so
  // we only persist nodes that actually point at the input memory.
  //
  // Returns `[]` (never throws) when:
  //   • the bridge is disabled
  //   • MemMachine is unreachable / 5xx / times out
  //   • the response shape doesn't carry useful nodes
  // The synthesize stage relies on that contract — MemMachine being
  // down should never block knowledge synthesis.
  async fetchMemoryGraph(args: {
    orgId: string;
    projectId: string;
    memoryId: string;
    query: string;
    limit?: number;
  }): Promise<MemMachineGraphNode[]> {
    if (!this.isEnabled()) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v2/memories/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: args.orgId,
          project_id: args.projectId,
          query: args.query,
          top_k: args.limit ?? 10,
          types: ["episodic", "semantic"],
          expand_context: 0,
          agent_mode: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.logger.warn(
          `[memmachine.bridge] graph fetch failed status=${response.status} body=${text.slice(0, 200)}`,
        );
        return [];
      }
      const body = (await response.json()) as {
        content?: {
          episodic_memory?: {
            long_term_memory?: { episodes?: MemMachineEpisode[] };
            short_term_memory?: { episodes?: MemMachineEpisode[] };
          };
          semantic_memory?: MemMachineSemanticItem[];
        };
      };

      const nodes: MemMachineGraphNode[] = [];

      const episodicLists: MemMachineEpisode[][] = [
        body.content?.episodic_memory?.long_term_memory?.episodes ?? [],
        body.content?.episodic_memory?.short_term_memory?.episodes ?? [],
      ];
      const seenEpisodic = new Set<string>();
      for (const list of episodicLists) {
        for (const ep of list) {
          if (readOpenktMemoryId(ep.metadata) !== args.memoryId) continue;
          const uid = typeof ep.uid === "string" ? ep.uid : null;
          if (uid && seenEpisodic.has(uid)) continue;
          if (uid) seenEpisodic.add(uid);
          nodes.push({
            nodeKind: "episodic",
            externalId: uid,
            statement: typeof ep.content === "string" ? ep.content : null,
            score: typeof ep.score === "number" ? ep.score : null,
            metadata: (ep.metadata ?? {}) as Record<string, unknown>,
          });
        }
      }

      const semanticItems = body.content?.semantic_memory ?? [];
      const seenSemantic = new Set<string>();
      for (const item of semanticItems) {
        if (readOpenktMemoryId(item.metadata) !== args.memoryId) continue;
        const uid = typeof item.uid === "string" ? item.uid : null;
        const isRelation =
          item.kind === "relation" ||
          item.kind === "triple" ||
          typeof item.subject === "string" ||
          typeof item.predicate === "string" ||
          typeof item.object === "string";
        if (isRelation) {
          nodes.push({
            nodeKind: "relation",
            externalId: uid,
            statement: typeof item.content === "string" ? item.content : null,
            subject: typeof item.subject === "string" ? item.subject : null,
            predicate: typeof item.predicate === "string" ? item.predicate : null,
            object: typeof item.object === "string" ? item.object : null,
            score: typeof item.score === "number" ? item.score : null,
            metadata: (item.metadata ?? {}) as Record<string, unknown>,
          });
          continue;
        }
        if (uid && seenSemantic.has(uid)) continue;
        if (uid) seenSemantic.add(uid);
        nodes.push({
          nodeKind: "semantic",
          externalId: uid,
          statement: typeof item.content === "string" ? item.content : null,
          score: typeof item.score === "number" ? item.score : null,
          metadata: (item.metadata ?? {}) as Record<string, unknown>,
        });
      }

      return nodes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[memmachine.bridge] graph fetch threw: ${message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

// MemMachine sometimes nests the openkt_memory_id under `metadata.other`
// instead of `metadata` directly (depends on whether the producer used
// the v1 or v2 add path). Check both.
function readOpenktMemoryId(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  const direct = metadata.openkt_memory_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const other = metadata.other;
  if (other && typeof other === "object") {
    const nested = (other as Record<string, unknown>).openkt_memory_id;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return null;
}
