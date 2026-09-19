import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { requireMemoryWriteAccess } from "@openkt/auth-authorization";
import { ValidationDomainError } from "@openkt/core-errors";

import { AuditService } from "../../audit/services/audit.service";

import {
  MEMORY_CONTENT_MAX,
  type CreateMemoryInput,
  type DeleteMemoryInput,
  type DeleteMemoryResult,
  type MemoryGateSuggestion,
  type MemoryRecord,
} from "../contracts/memory.contract";
import { MemoryRepository } from "../repositories/memory.repository";
import { MEMORY_ENGINE, type MemoryEngine } from "./memory-engine";
import { MemoryOutboxService } from "./memory-outbox.service";
import { MemorySynthesisService } from "./memory-synthesis.service";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { SessionRepository } from "../../sessions/repositories/session.repository";

@Injectable()
export class MemoryCommandsApplicationService {
  constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly projectScopeService: ProjectScopeService,
    private readonly memoryOutbox: MemoryOutboxService,
    @Inject(MEMORY_ENGINE) private readonly memoryEngine: MemoryEngine,
    private readonly auditService: AuditService,
    private readonly synthesis: MemorySynthesisService,
    private readonly sessionRepository: SessionRepository,
  ) {}

  async create(
    context: ActorContext,
    input: CreateMemoryInput,
  ): Promise<MemoryRecord | MemoryGateSuggestion> {
    if (input.content.length > MEMORY_CONTENT_MAX) {
      return {
        verdict: "reject-too-long",
        reason: `content is ${input.content.length} chars; the limit is ${MEMORY_CONTENT_MAX}.`,
        suggested_skill: {
          slug_suggestion: "overflow-from-memory",
          title_suggestion: "Overflow from Memory",
          preview: input.content.slice(0, 500),
        },
      };
    }

    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );
    const access = await this.projectScopeService.requireProjectAccess(
      context,
      projectId,
      "write",
    );

    // save at decision points (architecture.md §4): when the caller
    // passes session_id, stamp the memory with the session's connector
    // as `source` and bump the session's last_activity_at so an idle
    // sweep never closes a session mid-work just because the model is
    // "thinking" between saves. The session must belong to the same
    // project the memory is being written to — a session_id from a
    // different project is rejected rather than silently ignored,
    // since that would be a cross-project provenance bug.
    const sessionStamp = input.session_id
      ? await this.resolveSessionStamp(input.session_id, projectId)
      : null;

    // Synthesize-on-save (dedup-only, v1): if the incoming content
    // is a near-duplicate of an existing memory (cosine ≥ 0.92), we
    // MERGE — bump importance + append source_refs on the existing
    // row — and return it instead of creating a new one. This keeps
    // recall results clean for repeated facts ("we use AWS" said
    // five times across sessions = one canonical row, not five).
    //
    // Null result = no synthesis happened (mode=off, no neighbors,
    // or sub-threshold). Caller proceeds with the normal create.
    // See MemorySynthesisService for thresholds + tuning knobs.
    const synthesisResult = await this.synthesis.tryDedup(context, projectId, input);
    if (synthesisResult) {
      // The merge updated the existing row; log + return it as the
      // "saved" memory. No outbox publish needed — the row already
      // exists in the pipeline.
      await this.memoryRepository.logAccess(context, synthesisResult.merged.id, "write");
      return synthesisResult.merged;
    }

    const duplicate = await this.memoryRepository.findDuplicate(context, projectId, input.content);
    if (duplicate) {
      throw new ValidationDomainError("duplicate memory", duplicate);
    }

    const created = await this.memoryRepository.create(
      context,
      projectId,
      access.orgId,
      input,
      sessionStamp,
    );
    await this.memoryEngine.remember(context, created);
    await this.memoryRepository.embedNow(created.id, created.content).catch(() => false);
    await this.memoryRepository.logAccess(context, created.id, "write");
    if (sessionStamp) {
      void this.sessionRepository.touchActivity(sessionStamp.sessionId).catch(() => undefined);
    }

    // Outbox publish is inside the synchronous write boundary. If this
    // fails, the request fails and the caller can retry instead of
    // silently dropping the async pipeline trigger.
    await this.memoryOutbox.publishCreated(context, created);

    return created;
  }

  private async resolveSessionStamp(
    sessionId: string,
    projectId: string,
  ): Promise<{ sessionId: string; source: string }> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) throw new ValidationDomainError("session not found");
    if (session.project_id !== projectId) {
      throw new ValidationDomainError("session_id does not belong to the resolved project");
    }
    return { sessionId: session.id, source: session.source };
  }

  async forget(
    context: ActorContext,
    input: DeleteMemoryInput,
  ): Promise<DeleteMemoryResult> {
    await requireMemoryWriteAccess(context, input.id);
    await this.memoryEngine.forget(context, input.id, input.hard);
    await this.memoryRepository.forget(context, input.id, input.hard);
    if (!input.hard) {
      await this.memoryRepository.logAccess(context, input.id, "archive");
    }
    if (input.hard) {
      // memory.hard_deleted is a security-relevant action — the row is
      // gone, so we keep the audit trail in audit_log. orgId is left
      // null because the memory record is no longer queryable; callers
      // who need cross-referencing can join via resource_id.
      await this.auditService.writeFromContext(context, {
        actorKind: "user",
        action: "memory.hard_deleted",
        resourceType: "memory",
        resourceId: input.id,
      });
    }
    return { id: input.id, archived: true, hard: input.hard };
  }
}
