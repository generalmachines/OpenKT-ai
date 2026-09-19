import { Injectable, Logger } from "@nestjs/common";

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
import { refuseSecrets } from "../../../common/secrets/refuse-secrets";
import { GrantRepository } from "../../grants/repositories/grant.repository";
import { JobQueueRepository } from "../../jobs/repositories/job-queue.repository";

export type SessionRole = "owner" | "editor" | "reader";

/** Spec 02 §2: a session with less user + assistant text than this is not processed at all. */
export const MIN_SESSION_CHARS = 200;

@Injectable()
export class SessionsApplicationService {
  private readonly logger = new Logger(SessionsApplicationService.name);

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
    private readonly jobQueue: JobQueueRepository,
  ) {}

  async start(context: ActorContext, input: CreateSessionInput): Promise<SessionRecord> {
    refuseSecrets("session title", input.title);
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
    refuseSecrets("turn", input.content);
    await this.requireWritable(context, sessionId);
    return this.sessionRepository.addTurn(sessionId, input);
  }

  async close(
    context: ActorContext,
    sessionId: string,
    input: CloseSessionInput,
  ): Promise<SessionRecord> {
    refuseSecrets("summary", input.summary);
    await this.requireWritable(context, sessionId);
    const closed = await this.sessionRepository.close(sessionId, input.summary ?? null);
    // Living context: a member's Mac with the on-device model picks this up, extracts the facts
    // and folds them into the space's pages (modules/jobs). Once per session. Never fails a close.
    await this.jobQueue.enqueueSessionOnce(closed.id, MIN_SESSION_CHARS).catch((err: unknown) => {
      this.logger.warn(`[sessions] could not queue processing for ${closed.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return closed;
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

  // Spec 04: `GET /v1/sessions/:id` → the session, its facts and `my_role`.
  // Transcripts (turns) need editor or owner — a reader gets the facts, not
  // the turns, so for a reader the `turns` key is absent.
  async get(
    context: ActorContext,
    sessionId: string,
  ): Promise<{
    session: SessionRecord;
    turns?: SessionTurnRecord[];
    memories: MemoryRecord[];
    my_role: SessionRole;
  }> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundDomainError("session");
    const myRole = await this.roleOn(context, session);

    const [turns, memories] = await Promise.all([
      myRole === "reader" ? null : this.sessionRepository.turnsForSession(sessionId),
      this.memoryRepository.findBySessionId(sessionId),
    ]);

    return turns
      ? { session, turns, memories, my_role: myRole }
      : { session, memories, my_role: myRole };
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

  // The caller's role on one session, or 404. `owner` is the session's own
  // author; `editor` is anyone who may write to its space, or who holds an
  // editor/owner grant on the session itself; `reader` can read the space or
  // holds a reader grant on the session (M4 — "share one conversation from my
  // personal space" while the space itself stays private).
  private async roleOn(context: ActorContext, session: SessionRecord): Promise<SessionRole> {
    const userId = context.principal.userId;
    if (!userId) throw new NotFoundDomainError("session");
    if (session.owner_user_id === userId) return "owner";

    const [spaceRole, sessionGrant] = await Promise.all([
      this.spaceRole(context, session.project_id),
      this.grantRepository.findUserRole("session", session.id, userId),
    ]);
    if (spaceRole === "editor" || sessionGrant === "editor" || sessionGrant === "owner") return "editor";
    if (spaceRole === "reader" || sessionGrant === "reader") return "reader";
    throw new NotFoundDomainError("session");
  }

  private async spaceRole(context: ActorContext, projectId: string): Promise<"editor" | "reader" | null> {
    for (const mode of ["write", "read"] as const) {
      try {
        await this.projectScopeService.requireProjectAccess(context, projectId, mode);
        return mode === "write" ? "editor" : "reader";
      } catch (err) {
        if (!(err instanceof NotFoundDomainError)) throw err;
      }
    }
    return null;
  }
}
