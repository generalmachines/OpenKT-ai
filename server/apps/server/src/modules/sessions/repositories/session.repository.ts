import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { sessions, sessionTurns } from "../../../db/schema";
import type {
  CreateSessionInput,
  ListSessionsQuery,
  SessionListMeta,
  SessionRecord,
  SessionTurnRecord,
} from "../contracts/session.contract";

// Spec 04: a turn appended to a closed session is 409 — open a new session.
export const sessionClosed = () =>
  new HttpException(
    { code: "session_closed", message: "This session is closed; open a new session to add turns." },
    HttpStatus.CONFLICT,
  );

type NewTurn = { role: string; content: string; metadata: Record<string, unknown> };

@Injectable()
export class SessionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // null when `(owner, source, external_id)` already names a session (a
  // concurrent create won) — the caller reads that one with findByExternalId.
  async create(
    context: ActorContext,
    projectId: string,
    orgId: string | null,
    input: CreateSessionInput,
  ): Promise<SessionRecord | null> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    const [row] = await this.db
      .insert(sessions)
      .values({
        orgId,
        projectId,
        ownerUserId: userId,
        source: input.source,
        client: input.client ?? null,
        title: input.title ?? null,
        metadata: input.metadata ?? {},
        externalId: input.external_id ?? null,
        externalUrl: input.external_url ?? null,
        status: "open",
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      if (input.external_id) return null;
      throw new ValidationDomainError("session create failed");
    }
    return this.toRecord(row);
  }

  async findByExternalId(ownerUserId: string, source: string, externalId: string): Promise<SessionRecord | null> {
    const row = await this.db.query.sessions.findFirst({
      where: and(
        eq(sessions.ownerUserId, ownerUserId),
        eq(sessions.source, source),
        eq(sessions.externalId, externalId),
      ),
    });
    return row ? this.toRecord(row) : null;
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
    return row ? this.toRecord(row) : null;
  }

  // Which of these sessions belong to this project.
  async idsInProject(sessionIds: string[], projectId: string): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), inArray(sessions.id, sessionIds)));
    return rows.map((row) => row.id);
  }

  async listByProject(
    projectId: string,
    filters: { status?: string; limit: number; offset: number },
  ): Promise<{ data: SessionRecord[]; meta: SessionListMeta }> {
    const conditions = [eq(sessions.projectId, projectId)];
    if (filters.status) conditions.push(eq(sessions.status, filters.status));
    const where = and(...conditions);

    const totalRow = await this.db.select({ n: count() }).from(sessions).where(where);
    const total = Number(totalRow[0]?.n ?? 0);

    const rows = await this.db
      .select()
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.startedAt))
      .limit(filters.limit)
      .offset(filters.offset);

    const data = rows.map((row) => this.toRecord(row));
    return {
      data,
      meta: {
        total,
        offset: filters.offset,
        limit: filters.limit,
        has_more: filters.offset + data.length < total,
      },
    };
  }

  // Appends turns at the next sequence numbers, in order, all or nothing.
  // The session row is locked for the transaction, so concurrent appends
  // take turns and a close cannot slip in between the check and the insert;
  // a closed session is 409 `session_closed`.
  async appendTurns(sessionId: string, turns: NewTurn[]): Promise<SessionTurnRecord[]> {
    const rows = await this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        select status from ${sessions} where id = ${sessionId}::uuid for update
      `);
      const status = (locked.rows[0] as { status?: string } | undefined)?.status;
      if (!status) throw new ValidationDomainError("session not found");
      if (status !== "open") throw sessionClosed();

      const inserted = await tx.execute(sql`
        insert into ${sessionTurns} (session_id, seq, role, content, metadata)
        select ${sessionId}::uuid,
               base.n + t.ord,
               t.elem->>'role',
               t.elem->>'content',
               coalesce(t.elem->'metadata', '{}'::jsonb)
          from (select coalesce(max(seq), 0) as n from ${sessionTurns} where session_id = ${sessionId}::uuid) base,
               jsonb_array_elements(${JSON.stringify(turns)}::jsonb) with ordinality as t(elem, ord)
         order by t.ord
        returning id, session_id, seq, role, content, created_at, metadata
      `);
      await tx
        .update(sessions)
        .set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(sessions.id, sessionId));
      return inserted.rows as Array<{
        id: string;
        session_id: string;
        seq: number;
        role: string;
        content: string;
        created_at: string | Date;
        metadata: unknown;
      }>;
    });

    return rows
      .map((row) => ({
        id: row.id,
        session_id: row.session_id,
        seq: Number(row.seq),
        role: row.role as SessionTurnRecord["role"],
        content: row.content,
        created_at: this.iso(row.created_at),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      }))
      .sort((a, b) => a.seq - b.seq);
  }

  async close(sessionId: string, summary: string | null): Promise<SessionRecord> {
    const [row] = await this.db
      .update(sessions)
      .set({
        status: "closed",
        endedAt: sql`now()`,
        lastActivityAt: sql`now()`,
        // Only overwrite summary when the caller actually supplied one
        // — omitting/null keeps whatever summary (if any) was already
        // set on the session.
        ...(summary !== null ? { summary } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(sessions.id, sessionId))
      .returning();
    if (!row) throw new ValidationDomainError("session close failed");
    return this.toRecord(row);
  }

  async touchActivity(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(sessions.id, sessionId));
  }

  // Idle-close sweep — architecture.md "M1 · Sessions": any session
  // still `open` whose last_activity_at is older than idleMinutes is
  // closed automatically, with a synthesized summary marker so the
  // difference between a model-authored close and an idle timeout is
  // visible in the record. Returns the ids closed, for logging.
  async closeIdleSessions(idleMinutes: number): Promise<string[]> {
    const threshold = sql`now() - (${idleMinutes} || ' minutes')::interval`;
    const result = await this.db
      .update(sessions)
      .set({
        status: "closed",
        endedAt: sql`now()`,
        updatedAt: sql`now()`,
        summary: sql`coalesce(${sessions.summary}, '(closed automatically — idle)')`,
      })
      .where(and(eq(sessions.status, "open"), lt(sessions.lastActivityAt, threshold)))
      .returning({ id: sessions.id });
    return result.map((r) => r.id);
  }

  async turnsForSession(sessionId: string): Promise<SessionTurnRecord[]> {
    const rows = await this.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId))
      .orderBy(sessionTurns.seq);
    return rows.map((row) => ({
      id: row.id,
      session_id: row.sessionId,
      seq: row.seq,
      role: row.role as SessionTurnRecord["role"],
      content: row.content,
      created_at: this.iso(row.createdAt),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  private toRecord(row: typeof sessions.$inferSelect): SessionRecord {
    return {
      id: row.id,
      org_id: row.orgId,
      project_id: row.projectId,
      owner_user_id: row.ownerUserId,
      source: row.source as SessionRecord["source"],
      client: row.client,
      title: row.title,
      summary: row.summary,
      status: row.status as SessionRecord["status"],
      started_at: this.iso(row.startedAt),
      ended_at: row.endedAt ? this.iso(row.endedAt) : null,
      last_activity_at: this.iso(row.lastActivityAt),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      external_id: row.externalId ?? null,
      external_url: row.externalUrl ?? null,
      created_at: this.iso(row.createdAt),
      updated_at: this.iso(row.updatedAt),
    };
  }

  private iso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d);
  }
}
