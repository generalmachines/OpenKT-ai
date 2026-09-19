import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { requireProjectAccess } from "@openkt/auth-authorization";
import { NotFoundDomainError } from "@openkt/core-errors";

import type {
  KnowledgeNode,
  MemoryWithSimilarityRecord,
  RecallMeta,
  RecallRequest,
  RecallSection,
} from "../contracts/memory.contract";
import { stripCitations } from "../../jobs/rules/living-rules";
import { PageRepository } from "../../pages/repositories/page.repository";
import { embed } from "../repositories/embedding-bge";
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

// Page sections returned alongside facts, and the vector floor below which a section is not
// relevant enough to show (Spec 01 §4 step 6 abstains below cosine 0.30 without a reranker).
const SECTION_LIMIT = 4;
const SECTION_MIN_SIMILARITY = 0.3;

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
    // Optional so a module that wires recall without pages (a test module) still resolves;
    // recall then returns no sections.
    @Optional() private readonly pageRepository?: PageRepository,
  ) {}

  async recall(
    context: ActorContext,
    input: RecallRequest,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }> {
    // No space given → every space the caller can read, and every session
    // granted to them (the core promise: what one person saved reaches a
    // teammate's session). Access is a subquery in the ranking SQL.
    if (!input.project_id || !input.project_id.trim()) {
      return this.recallEverywhere(context, input);
    }

    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );

    // "access enforced inside the retrieval query, not after it"
    // (product.md "Privacy and trust") — the visible scope's granted
    // session ids let a `visibility: 'personal'` memory reach a
    // teammate who was granted exactly that session, without exposing
    // any of the owner's other personal-space memories.
    const scope = await this.accessScopeService.visibleScope(context);

    // Whole-space access, or — failing that — a grant on some of this
    // space's sessions (Spec 01 §2 visible_sessions). A session-only
    // grantee recalls those sessions' facts and nothing else from the space:
    // no workspace ring, no space-level knowledge. No grant at all → 404.
    let onlySessionIds: string[] | null = null;
    try {
      await requireProjectAccess(context, projectId, "read");
    } catch (err) {
      if (!(err instanceof NotFoundDomainError)) throw err;
      const granted = await this.sessionRepository.idsInProject(scope.sessionIds, projectId);
      if (granted.length === 0) throw err;
      onlySessionIds = granted;
    }
    const workspaceIds = onlySessionIds
      ? []
      : await this.projectScopeService.workspaceRing(context, projectId);
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
      onlySessionIds ? { onlySessionIds } : undefined,
    );

    const recalled = await this.finishRecall(context, input, result);

    // Page sections from the same spaces, grant-filtered the same way: someone who can read only
    // some sessions of a space (onlySessionIds) cannot read its pages, so gets none.
    const sections = onlySessionIds
      ? []
      : await this.sectionsOrNone([projectId, ...workspaceIds], input.query ?? "");
    recalled.meta = { ...recalled.meta, sections };

    if (!input.include_knowledge) {
      return recalled;
    }
    if (onlySessionIds) {
      return { data: recalled.data, meta: { ...recalled.meta, knowledge: [] } };
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

  private async recallEverywhere(
    context: ActorContext,
    input: RecallRequest,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }> {
    const result = await this.memoryEngine.search(
      context,
      {
        query: input.query,
        mode: "hybrid",
        vector_weight: input.vector_weight,
        workspace_weight: input.workspace_weight,
        filters: {
          kinds: input.kind ? [input.kind] : undefined,
          min_confidence: input.min_confidence,
          include_archived: false,
          include_superseded: false,
        },
        limit: input.limit,
      },
      [],
      [],
      { everyReadableSpace: true },
    );
    const recalled = await this.finishRecall(context, input, result);

    // Page sections from every space the caller can read as a whole (a single granted session
    // does not open its space's pages).
    const readable = await this.accessScopeService.readableProjectIds(context);
    recalled.meta = { ...recalled.meta, sections: await this.sectionsOrNone(readable, input.query ?? "") };
    if (!input.include_knowledge) return recalled;

    // Knowledge only from spaces the caller can read as a whole — a fact
    // reached through a single granted session says nothing about its space.
    const byProject = new Map<string, MemoryWithSimilarityRecord[]>();
    for (const row of recalled.data) {
      byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
    }
    const knowledge: KnowledgeNode[] = [];
    for (const [projectId, rows] of byProject) {
      const readable = await requireProjectAccess(context, projectId, "read").then(
        () => true,
        (err: unknown) => {
          if (err instanceof NotFoundDomainError) return false;
          throw err;
        },
      );
      if (readable) knowledge.push(...(await this.collectKnowledge(projectId, rows)));
      if (knowledge.length >= KNOWLEDGE_LIMIT) break;
    }
    return {
      data: recalled.data,
      meta: { ...recalled.meta, knowledge: knowledge.slice(0, KNOWLEDGE_LIMIT) },
    };
  }

  // Record the recall, keep the session alive, refresh neighbours.
  private async finishRecall(
    context: ActorContext,
    input: RecallRequest,
    result: Awaited<ReturnType<MemoryEngine["search"]>>,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }> {
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
    return recalled;
  }

  private async sectionsOrNone(projectIds: string[], query: string): Promise<RecallSection[]> {
    if (projectIds.length === 0) return [];
    return this.recallSections(projectIds, query).catch((err) => {
      this.logger.warn(`[memory.recall] section search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as RecallSection[];
    });
  }

  private async recallSections(projectIds: string[], query: string): Promise<RecallSection[]> {
    const q = query.trim();
    if (!q || !this.pageRepository) return [];
    const vector = await embed(q).catch(() => null);
    const hits = await this.pageRepository.searchSections([...new Set(projectIds)], q, vector, SECTION_LIMIT * 2);
    return hits
      .filter((h) => h.similarity === null || h.similarity >= SECTION_MIN_SIMILARITY)
      .slice(0, SECTION_LIMIT)
      .map((h) => ({
        id: h.id,
        type: "section" as const,
        heading: h.heading,
        text: stripCitations(h.body_md),
        page: { id: h.page_id, title: h.page_title },
        space: { id: h.project_id, name: h.project_name },
        locked: h.locked,
        updated_at: h.updated_at,
        score: h.score,
      }));
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
