import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  requireMemoryReadAccess,
  requireProjectAccess,
} from "@openkt/auth-authorization";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import type {
  ListMemoriesQuery,
  MemoryAccessSummary,
  MemoryNeighborRecord,
  MemoryRecord,
  MemorySearchMeta,
  MemorySearchRequest,
  MemoryWithSimilarityRecord,
} from "../contracts/memory.contract";
import { MemoryRepository } from "../repositories/memory.repository";
import { MEMORY_ENGINE, type MemoryEngine } from "./memory-engine";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { AccessScopeService } from "../../access/services/access-scope.service";

@Injectable()
export class MemoryQueriesApplicationService {
  constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly projectScopeService: ProjectScopeService,
    @Inject(MEMORY_ENGINE) private readonly memoryEngine: MemoryEngine,
    private readonly accessScopeService: AccessScopeService,
  ) {}

  async list(context: ActorContext, input: ListMemoriesQuery) {
    await requireProjectAccess(context, input.project_id, "read");
    return this.memoryRepository.listByProject(context, input);
  }

  // categorized returns top-N memories per kind, sorted by importance ×
  // recency. Thin wrapper over the repo so the prime service doesn't
  // reach into MemoryRepository directly. Auth is enforced both here
  // (requireProjectAccess) and inside the repo (assertProjectMember);
  // belt-and-suspenders is intentional — the repo method is also
  // callable from internal code paths that may not go through this
  // application service in future.
  async categorized(
    context: ActorContext,
    projectId: string,
    kinds: MemoryRecord["kind"][],
    perKindLimit: number,
  ): Promise<Record<string, MemoryRecord[]>> {
    await requireProjectAccess(context, projectId, "read");
    return this.memoryRepository.categorizedByProject(context, projectId, kinds, perKindLimit);
  }

  async get(context: ActorContext, memoryId: string): Promise<MemoryRecord> {
    await requireMemoryReadAccess(context, memoryId);
    const memory = await this.memoryRepository.findById(context, memoryId);
    if (!memory) {
      throw new NotFoundDomainError("memory");
    }

    await this.memoryRepository.logAccess(context, memoryId, "read");
    return memory;
  }

  async accessSummary(context: ActorContext, memoryId: string): Promise<MemoryAccessSummary> {
    await requireMemoryReadAccess(context, memoryId);
    return this.memoryRepository.accessSummary(context, memoryId);
  }

  async neighbors(
    context: ActorContext,
    memoryId: string,
    limit: number,
    minSimilarity: number,
  ): Promise<MemoryNeighborRecord[]> {
    await requireMemoryReadAccess(context, memoryId);
    return this.memoryRepository.neighbors(memoryId, limit, minSimilarity);
  }

  async search(
    context: ActorContext,
    input: MemorySearchRequest,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta }> {
    const requested = [...new Set(input.filters.project_ids ?? [])];
    const primaryProjectId = requested[0];
    if (!primaryProjectId) {
      throw new ValidationDomainError(
        "search requires filters.project_ids with at least one project",
      );
    }

    // The engine searches EVERY id in the list, so every id is authorised —
    // not just the first. One unreadable id makes the whole request a 404
    // (Spec 04: a resource the caller cannot read is 404). The error is the
    // same whichever id failed and whether or not that space exists, so the
    // response never tells a caller which of their ids names a real space.
    const denied = await Promise.all(
      requested.map((projectId) =>
        requireProjectAccess(context, projectId, "read").then(
          () => false,
          (err: unknown) => {
            if (err instanceof NotFoundDomainError) return true;
            throw err;
          },
        ),
      ),
    );
    if (denied.some(Boolean)) throw new NotFoundDomainError("project");

    const workspaceIds = await this.projectScopeService.workspaceRing(context, primaryProjectId);
    const scope = await this.accessScopeService.visibleScope(context);
    const result = await this.memoryEngine.search(context, input, workspaceIds, scope.sessionIds);
    await this.memoryRepository.logAccessBatch(
      context,
      result.data.map((memory) => memory.id),
      "read",
    );
    return result;
  }

}
