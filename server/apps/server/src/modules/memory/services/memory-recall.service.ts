import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { requireProjectAccess } from "@openkt/auth-authorization";

import type {
  KnowledgeNode,
  MemoryWithSimilarityRecord,
  RecallMeta,
  RecallRequest,
} from "../contracts/memory.contract";
import { KnowledgeRepository } from "../repositories/knowledge.repository";
import { MemoryRepository } from "../repositories/memory.repository";
import { MEMORY_ENGINE, type MemoryEngine } from "./memory-engine";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { SessionRepository } from "../../sessions/repositories/session.repository";
import { AccessScopeService } from "../../access/services/access-scope.service";

// Cap on the number of knowledge nodes we surface inline with a single
// recall response. The intent is "show me the rolled-up truth for the
// topics in these results" — five is more than enough for any sane
// recall (limit ≤ 50 raw memories) and keeps the response bounded.
const KNOWLEDGE_LIMIT = 5;

/**
 * Single-responsibility service for the memory recall path.
 *
 * Why separate from MemoryQueriesApplicationService:
 *
 * - Recall is the only path that mutates `recall_count`,
 *   `last_recall_at`, `access_count`, `last_accessed_at` via the
 *   `memory_accesses` trigger. Owning that mutation contract in one
 *   place makes the trigger drift identified by the audit (recall
 *   counters never bumping in prod) easier to reason about.
 *
 * - Recall composes hybrid retrieval + workspace ring resolution +
 *   recall-event logging. Search and list don't carry the
 *   recall-event semantics, so co-locating them with recall blurs
 *   responsibilities.
 *
 * - Recall is the surface CLI / MCP / browser plugins all converge on
 *   for retrieval. A dedicated class makes it the single point of
 *   future mock / instrument / replace.
 */
@Injectable()
export class MemoryRecallService {
  private readonly logger = new Logger(MemoryRecallService.name);

  constructor(
    @Inject(MEMORY_ENGINE) private readonly memoryEngine: MemoryEngine,
    private readonly projectScopeService: ProjectScopeService,
    private readonly knowledgeRepository: KnowledgeRepository,
    private readonly memoryRepository: MemoryRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly accessScopeService: AccessScopeService,
  ) {}

  async recall(
    context: ActorContext,
    input: RecallRequest,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }> {
    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );

    await requireProjectAccess(context, projectId, "read");
    const workspaceIds = await this.projectScopeService.workspaceRing(context, projectId);
    // "access enforced inside the retrieval query, not after it"
    // (product.md "Privacy and trust") — the visible scope's granted
    // session ids let a `visibility: 'personal'` memory reach a
    // teammate who was granted exactly that session, without exposing
    // any of the owner's other personal-space memories.
    const scope = await this.accessScopeService.visibleScope(context);
    const result = await this.memoryEngine.search(
      context,
      {
        query: input.query,
        mode: "hybrid",
        vector_weight: input.vector_weight,
        workspace_weight: input.workspace_weight,
        filters: {
          project_ids: [projectId],
          kinds: input.kind ? [input.kind] : undefined,
          min_confidence: input.min_confidence,
          include_archived: false,
          include_superseded: false,
        },
        limit: input.limit,
      },
      workspaceIds,
      scope.sessionIds,
    );

    const recalled = await this.memoryEngine.recall(
      context,
      result,
      input.invocation_id,
    );

    // "recall bumps last_activity_at" — kt_session_start / kt_save /
    // kt_recall / kt_session_end all count as "the session is still
    // active" for the idle-close sweep. Fire-and-forget; a failed
    // touch must never fail the recall response.
    if (input.session_id) {
      void this.sessionRepository
        .touchActivity(input.session_id)
        .catch(() => undefined);
    }

    // Lazy neighbors refresh — fire-and-forget. The worker no longer
    // pre-computes `memory_neighbors` per memory; instead the first
    // recall that touches a memory triggers an inline pgvector pass
    // here and caches the result for 24h. We don't await so the recall
    // response shape (and its latency) is unchanged. Errors inside
    // ensureNeighborsFresh are already swallowed + logged.
    if (recalled.data.length > 0) {
      const recalledIds = recalled.data.map((row) => row.id);
      void this.memoryRepository
        .ensureNeighborsFresh(recalledIds)
        .catch((err) => {
          this.logger.warn(
            `[memory.recall] background neighbors refresh failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    if (!input.include_knowledge) {
      return recalled;
    }

    // Opt-in: enrich `meta.knowledge` with the unarchived knowledge
    // nodes that overlap any tag on the recalled raw memories. The
    // raw `data` array (Memory[]) stays exactly the same so existing
    // CLI / SDK consumers keep parsing the payload unchanged.
    const knowledge = await this.collectKnowledge(projectId, recalled.data);
    return {
      data: recalled.data,
      meta: { ...recalled.meta, knowledge },
    };
  }

  private async collectKnowledge(
    projectId: string,
    rows: MemoryWithSimilarityRecord[],
  ): Promise<KnowledgeNode[]> {
    const tagSlugs = new Set<string>();
    for (const row of rows) {
      for (const tag of row.tags ?? []) {
        if (tag.slug) tagSlugs.add(tag.slug);
      }
    }
    if (tagSlugs.size === 0) return [];
    return this.knowledgeRepository.listForProjectByTags(
      projectId,
      Array.from(tagSlugs),
      KNOWLEDGE_LIMIT,
    );
  }
}
