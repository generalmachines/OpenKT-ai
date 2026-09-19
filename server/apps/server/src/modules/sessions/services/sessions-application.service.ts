import { Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { NotFoundDomainError } from "@openkt/core-errors";

import type {
  AddSessionTurnInput,
  CloseSessionInput,
  CreateSessionInput,
  ListSessionsQuery,
  SessionListMeta,
  SessionRecord,
  SessionTurnRecord,
} from "../contracts/session.contract";
import { SessionRepository } from "../repositories/session.repository";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { MemoryRepository } from "../../memory/repositories/memory.repository";
import type { MemoryRecord } from "../../memory/contracts/memory.contract";
import { GrantRepository } from "../../grants/repositories/grant.repository";

@Injectable()
export class SessionsApplicationService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly projectScopeService: ProjectScopeService,
    // MemoryRepository (not MemoryQueriesApplicationService/MemoryModule)
    // deliberately — it only needs the globally-provided DRIZZLE token,
    // so SessionsModule can provide the class directly without an
    // import cycle with MemoryModule (which itself needs
    // SessionRepository for save-time session stamping).
    private readonly memoryRepository: MemoryRepository,
    private readonly grantRepository: GrantRepository,
  ) {}

  async start(context: ActorContext, input: CreateSessionInput): Promise<SessionRecord> {
    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );
    const access = await this.projectScopeService.requireProjectAccess(
      context,
      projectId,
      "write",
    );
    return this.sessionRepository.create(context, projectId, access.orgId, input);
  }

  async addTurn(
    context: ActorContext,
    sessionId: string,
    input: AddSessionTurnInput,
  ): Promise<SessionTurnRecord> {
    await this.requireWritable(context, sessionId);
    return this.sessionRepository.addTurn(sessionId, input);
  }

  async close(
    context: ActorContext,
    sessionId: string,
    input: CloseSessionInput,
  ): Promise<SessionRecord> {
    await this.requireWritable(context, sessionId);
    return this.sessionRepository.close(sessionId, input.summary ?? null);
  }

  async list(
    context: ActorContext,
    input: ListSessionsQuery,
  ): Promise<{ data: SessionRecord[]; meta: SessionListMeta }> {
    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );
    await this.projectScopeService.requireProjectAccess(context, projectId, "read");
    return this.sessionRepository.listByProject(projectId, {
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
  }

  async get(
    context: ActorContext,
    sessionId: string,
  ): Promise<{ session: SessionRecord; turns: SessionTurnRecord[]; memories: MemoryRecord[] }> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundDomainError("session");
    await this.requireReadable(context, session);

    const [turns, memories] = await Promise.all([
      this.sessionRepository.turnsForSession(sessionId),
      this.memoryRepository.findBySessionId(sessionId),
    ]);

    return { session, turns, memories };
  }

  // Shared write-access + open-session guard for addTurn/close.
  // Writes still gate on project access only — sessions don't have
  // independent write grants, only reader grants (M4) for cross-
  // project visibility.
  private async requireWritable(context: ActorContext, sessionId: string): Promise<SessionRecord> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundDomainError("session");
    await this.projectScopeService.requireProjectAccess(context, session.project_id, "write");
    return session;
  }

  // Read access to a single session: either the caller can read the
  // owning project (owner/org member/project grant — the common
  // case), OR the caller holds a direct grant on THIS session (M4 —
  // the "share one conversation from my personal space" case, where
  // the project itself stays private). The project check is tried
  // first since it's the common path; the session-grant lookup only
  // runs on that 404/403.
  private async requireReadable(context: ActorContext, session: SessionRecord): Promise<void> {
    try {
      await this.projectScopeService.requireProjectAccess(context, session.project_id, "read");
      return;
    } catch (err) {
      if (!(err instanceof NotFoundDomainError)) throw err;
      const userId = context.principal.userId;
      if (userId && (await this.grantRepository.hasSessionGrant(session.id, userId))) {
        return;
      }
      throw err;
    }
  }
}
