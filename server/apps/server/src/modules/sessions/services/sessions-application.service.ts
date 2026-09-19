import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError, NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import {
  SESSION_TURNS_MAX_BYTES,
  type AddSessionTurnInput,
  type AddSessionTurnsInput,
  type CloseSessionInput,
  type CreateSessionInput,
  type ListSessionsQuery,
  type SessionListMeta,
  type SessionRecord,
  type SessionTurnRecord,
  type UpdateSessionInput,
} from "../contracts/session.contract";
import { SessionRepository } from "../repositories/session.repository";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { MemoryRepository } from "../../memory/repositories/memory.repository";
import type { MemoryRecord } from "../../memory/contracts/memory.contract";
import { refuseSecrets } from "../../../common/secrets/refuse-secrets";
import { GrantRepository } from "../../grants/repositories/grant.repository";
import { JobQueueRepository } from "../../jobs/repositories/job-queue.repository";

export type SessionRole = "owner" | "editor" | "reader";

// A session in a list: who owns it (name only) and the caller's role on it.
export type SessionListItem = SessionRecord & {
  my_role: SessionRole;
  owner: { id: string; name: string | null };
};

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
    return (await this.startOrGet(context, input)).session;
  }

  // Spec 04: the same `(source, external_id)` for the same owner is the same
  // session — `created: false` returns the existing one (200), whatever
  // space or title the retry names.
  async startOrGet(
    context: ActorContext,
    input: CreateSessionInput,
  ): Promise<{ session: SessionRecord; created: boolean }> {
    refuseSecrets("session title", input.title);
    const userId = context.principal.userId;
    if (!userId) throw new NotFoundDomainError("session");
    if (input.external_id) {
      const existing = await this.sessionRepository.findByExternalId(userId, input.source, input.external_id);
      if (existing) return { session: existing, created: false };
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
    const created = await this.sessionRepository.create(context, projectId, access.orgId, input);
    if (created) return { session: created, created: true };
    // A concurrent create with the same external id won.
    const winner = await this.sessionRepository.findByExternalId(userId, input.source, input.external_id!);
    if (!winner) throw new ValidationDomainError("session create failed");
    return { session: winner, created: false };
  }

  async addTurn(
    context: ActorContext,
    sessionId: string,
    input: AddSessionTurnInput,
  ): Promise<SessionTurnRecord> {
    refuseSecrets("turn", input.content);
    await this.requireWritable(context, sessionId);
    const [turn] = await this.sessionRepository.appendTurns(sessionId, [
      { role: input.role, content: input.content, metadata: input.metadata ?? {} },
    ]);
    if (!turn) throw new ValidationDomainError("session turn create failed");
    return turn;
  }

  // Spec 04 `{turns:[…]}` → `{appended, next_seq}`: all or nothing, in order.
  async addTurns(
    context: ActorContext,
    sessionId: string,
    input: AddSessionTurnsInput,
  ): Promise<{ appended: number; next_seq: number }> {
    const bytes = input.turns.reduce(
      (n, turn) => n + Buffer.byteLength(turn.content) + Buffer.byteLength(turn.speaker ?? ""),
      0,
    );
    if (bytes > SESSION_TURNS_MAX_BYTES) {
      throw new HttpException(
        { code: "payload_too_large", message: "At most 1 MB of turns per call; send the rest in another call." },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    for (const turn of input.turns) refuseSecrets("turn", turn.content);
    await this.requireWritable(context, sessionId);
    const appended = await this.sessionRepository.appendTurns(
      sessionId,
      input.turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
        metadata: {
          ...turn.metadata,
          ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
          ...(turn.t0_ms !== undefined ? { t0_ms: turn.t0_ms } : {}),
          ...(turn.t1_ms !== undefined ? { t1_ms: turn.t1_ms } : {}),
        },
      })),
    );
    const last = appended[appended.length - 1]?.seq ?? 0;
    return { appended: appended.length, next_seq: last + 1 };
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
  ): Promise<{ data: SessionListItem[]; meta: SessionListMeta }> {
    const filters = { status: input.status, limit: input.limit, offset: input.offset };
    if (input.shared) {
      const userId = context.principal.userId;
      if (!userId) throw new NotFoundDomainError("session");
      return this.withRoles(context, await this.sessionRepository.listSharedWith(userId, filters));
    }
    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );
    await this.projectScopeService.requireProjectAccess(context, projectId, "read");
    return this.withRoles(context, await this.sessionRepository.listByProject(projectId, filters));
  }

  // PATCH /v1/sessions/:id — the session's owner renames it and/or moves it
  // into another space they can write; the facts saved in it move with it.
  async update(context: ActorContext, sessionId: string, input: UpdateSessionInput): Promise<SessionRecord> {
    refuseSecrets("session title", input.title);
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundDomainError("session");
    const role = await this.roleOn(context, session);
    if (role !== "owner") throw new ForbiddenDomainError("only the session's owner can change it");

    let target: { projectId: string; orgId: string | null } | null = null;
    if (input.project_id) {
      const projectId = await this.projectScopeService.resolveProjectIdOrSlug(context, input.project_id);
      if (projectId !== session.project_id) {
        const access = await this.projectScopeService.requireProjectAccess(context, projectId, "write");
        target = { projectId, orgId: access.orgId };
      }
    }
    if (!target && input.title === undefined) return session;
    return this.sessionRepository.update(sessionId, {
      ...(target ? { projectId: target.projectId, orgId: target.orgId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  }

  private async withRoles(
    context: ActorContext,
    page: { data: SessionRecord[]; meta: SessionListMeta },
  ): Promise<{ data: SessionListItem[]; meta: SessionListMeta }> {
    const names = await this.sessionRepository.ownerNames(page.data.map((s) => s.owner_user_id));
    const data = await Promise.all(
      page.data.map(async (session) => ({
        ...session,
        my_role: await this.roleOn(context, session),
        owner: { id: session.owner_user_id, name: names.get(session.owner_user_id) ?? null },
      })),
    );
    return { data, meta: page.meta };
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
