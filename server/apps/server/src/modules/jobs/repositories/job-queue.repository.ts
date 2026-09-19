import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { LEASE_MS, MAX_ATTEMPTS, type JobKind } from "../contracts/job.contract";

export interface JobRecord {
  id: string;
  kind: JobKind;
  project_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
  status: "queued" | "claimed" | "done" | "failed";
  claimed_by: string | null;
  lease_until: string | null;
  attempts: number;
  run_after: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ProcessingSummary {
  queued: number;
  claimed: number;
  failed: number;
  oldest_queued_at: string | null;
  last_done_at: string | null;
  last_done_by: { id: string; name: string } | null;
}

type Executor = Pick<DrizzleDb, "execute">;

/** Timestamps as ISO 8601 (raw SQL hands back Postgres text like "2026-09-19 12:06:27.55+00"). */
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

function toRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    kind: row.kind as JobKind,
    project_id: (row.project_id as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as JobRecord["status"],
    claimed_by: (row.claimed_by as string | null) ?? null,
    lease_until: iso(row.lease_until),
    attempts: Number(row.attempts ?? 0),
    run_after: iso(row.run_after) ?? "",
    result: (row.result ?? null) as Record<string, unknown> | null,
    error: (row.error as string | null) ?? null,
    created_at: iso(row.created_at) ?? "",
    finished_at: iso(row.finished_at),
  };
}

/**
 * The Postgres job queue (Spec 01 §3 `jobs`). Plain SQL; needs only DRIZZLE, so the sessions,
 * pages and jobs modules can each provide it without importing one another.
 */
@Injectable()
export class JobQueueRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Enqueue a job. With a dedupe key, a live job (queued or claimed) with the same key wins and
   * its id is returned instead.
   */
  async enqueue(
    kind: JobKind,
    opts: { projectId: string | null; sessionId?: string | null; payload?: Record<string, unknown>; dedupeKey?: string | null; runAfter?: Date },
    db: Executor = this.db,
  ): Promise<string> {
    const runAfter = opts.runAfter ? sql`${opts.runAfter.toISOString()}::timestamptz` : sql`now()`;
    const inserted = await db.execute(sql`
      insert into jobs (kind, project_id, session_id, payload, dedupe_key, run_after)
      values (${kind}, ${opts.projectId}::uuid, ${opts.sessionId ?? null}::uuid, ${JSON.stringify(opts.payload ?? {})}::jsonb,
              ${opts.dedupeKey ?? null}, ${runAfter})
      on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'claimed') do nothing
      returning id
    `);
    const id = (inserted.rows[0] as { id?: string } | undefined)?.id;
    if (id) return id;
    const existing = await db.execute(sql`
      select id from jobs where dedupe_key = ${opts.dedupeKey ?? null} and status in ('queued', 'claimed') limit 1
    `);
    return String((existing.rows[0] as { id: string }).id);
  }

  /**
   * A closed session is processed once: enqueue `process_session` unless the session already has
   * one (in any state), and only when it holds at least `minChars` of user + assistant text
   * (Spec 02 §2). Returns the job id, or null when nothing was enqueued.
   */
  async enqueueSessionOnce(sessionId: string, minChars: number): Promise<string | null> {
    const result = await this.db.execute(sql`
      insert into jobs (kind, project_id, session_id, dedupe_key)
      select 'process_session', s.project_id, s.id, 'process_session:' || s.id::text
        from kt_sessions s
       where s.id = ${sessionId}::uuid
         and s.status = 'closed'
         and not exists (select 1 from jobs j where j.kind = 'process_session' and j.session_id = s.id)
         and (select coalesce(sum(length(t.content)), 0) from kt_session_turns t
               where t.session_id = s.id and t.role in ('user', 'assistant')) >= ${minChars}
      on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'claimed') do nothing
      returning id
    `);
    return ((result.rows[0] as { id?: string } | undefined)?.id as string | undefined) ?? null;
  }

  /**
   * Claims one job in a space where `userId` may write (owner, org owner/admin, or an
   * editor/owner grant on the space or its org — the same rule as requireProjectAccess "write"),
   * with a 5-minute lease. One statement, FOR UPDATE SKIP LOCKED: two workers never get the same
   * job. A claimed job whose lease ran out is claimable again. A deleted space's jobs are never handed out.
   */
  async claim(userId: string, kinds: readonly JobKind[]): Promise<JobRecord | null> {
    await this.failExhaustedLeases();
    const kindList = sql.join(kinds.map((k) => sql`${k}`), sql`, `);
    const result = await this.db.execute(sql`
      with writable as (
        select p.id from projects p where p.owner_user_id = ${userId}::uuid
        union
        select p.id from projects p join org_members om on om.org_id = p.org_id
         where om.user_id = ${userId}::uuid and om.role in ('owner', 'admin')
        union
        select g.resource_id from grants g
         where g.subject_type = 'user' and g.subject_id = ${userId}::uuid
           and g.resource_type = 'project' and g.role in ('editor', 'owner')
        union
        select p.id from projects p join grants g on g.resource_type = 'org' and g.resource_id = p.org_id
         where g.subject_type = 'user' and g.subject_id = ${userId}::uuid and g.role in ('editor', 'owner')
      )
      update jobs set status = 'claimed', claimed_by = ${userId}::uuid, claimed_at = now(),
             lease_until = now() + (${LEASE_MS} || ' milliseconds')::interval,
             attempts = attempts + 1, updated_at = now()
       where id = (
         select j.id from jobs j
          where j.project_id in (select id from writable)
            and not exists (select 1 from projects d where d.id = j.project_id and d.deleted_at is not null)
            and j.kind in (${kindList})
            and ((j.status = 'queued' and j.run_after <= now())
                 or (j.status = 'claimed' and j.lease_until < now() and j.attempts < ${MAX_ATTEMPTS}))
          order by j.run_after, j.created_at
          for update skip locked
          limit 1
       )
      returning *
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  /** A lease that ran out on the last allowed attempt ends the job. */
  private async failExhaustedLeases(): Promise<void> {
    await this.db.execute(sql`
      update jobs set status = 'failed', error = coalesce(error, 'lease expired on the last attempt'),
             finished_at = now(), updated_at = now()
       where status = 'claimed' and lease_until < now() and attempts >= ${MAX_ATTEMPTS}
    `);
  }

  /** The job, locked for update, if `userId` holds it. */
  async lockHeld(jobId: string, userId: string, db: Executor): Promise<JobRecord | null> {
    const result = await db.execute(sql`
      select * from jobs where id = ${jobId}::uuid and status = 'claimed' and claimed_by = ${userId}::uuid for update
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  /** Extends the lease of a job `userId` holds. Returns the job, or null when they no longer hold it. */
  async heartbeat(jobId: string, userId: string): Promise<JobRecord | null> {
    const result = await this.db.execute(sql`
      update jobs set lease_until = now() + (${LEASE_MS} || ' milliseconds')::interval, updated_at = now()
       where id = ${jobId}::uuid and status = 'claimed' and claimed_by = ${userId}::uuid
      returning *
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  async markDone(jobId: string, result: Record<string, unknown>, db: Executor = this.db): Promise<void> {
    await db.execute(sql`
      update jobs set status = 'done', result = ${JSON.stringify(result)}::jsonb, lease_until = null,
             finished_at = now(), updated_at = now()
       where id = ${jobId}::uuid
    `);
  }

  /**
   * Spec 02 §10: back to `queued` with run_after = now() + 2^attempts minutes, until the sixth
   * attempt; then `failed`. `retry: false` fails it at once.
   */
  async fail(jobId: string, userId: string, error: string, retry: boolean): Promise<JobRecord | null> {
    const result = await this.db.execute(sql`
      update jobs set
             status = case when ${retry} and attempts < ${MAX_ATTEMPTS} then 'queued' else 'failed' end,
             run_after = case when ${retry} and attempts < ${MAX_ATTEMPTS}
                              then now() + (power(2, attempts) || ' minutes')::interval else run_after end,
             finished_at = case when ${retry} and attempts < ${MAX_ATTEMPTS} then null else now() end,
             error = ${error.slice(0, 2000)}, claimed_by = null, lease_until = null, updated_at = now()
       where id = ${jobId}::uuid and status = 'claimed' and claimed_by = ${userId}::uuid
      returning *
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    const result = await this.db.execute(sql`select * from jobs where id = ${jobId}::uuid`);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * What the space page shows about its sessions' processing: waiting for a Mac, being processed,
   * failed, and the last one done (and by whom). Counts sessions (process_session jobs) only.
   */
  async processingSummary(projectId: string): Promise<ProcessingSummary> {
    const result = await this.db.execute(sql`
      select
        count(*) filter (where status = 'queued' or (status = 'claimed' and lease_until < now()))::int as queued,
        count(*) filter (where status = 'claimed' and lease_until >= now())::int as claimed,
        count(*) filter (where status = 'failed')::int as failed,
        min(created_at) filter (where status = 'queued' or (status = 'claimed' and lease_until < now())) as oldest_queued_at,
        (select j.finished_at from jobs j where j.project_id = ${projectId}::uuid and j.kind = 'process_session' and j.status = 'done'
          order by j.finished_at desc limit 1) as last_done_at,
        (select j.claimed_by from jobs j where j.project_id = ${projectId}::uuid and j.kind = 'process_session' and j.status = 'done'
          order by j.finished_at desc limit 1) as last_done_by
      from jobs where project_id = ${projectId}::uuid and kind = 'process_session'
    `);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    let lastBy: ProcessingSummary["last_done_by"] = null;
    if (row.last_done_by) {
      const who = await this.db.execute(sql`
        select coalesce(nullif(display_name, ''), split_part(email, '@', 1), 'A teammate') as name
          from profiles where user_id = ${String(row.last_done_by)}::uuid
      `);
      lastBy = { id: String(row.last_done_by), name: String((who.rows[0] as { name?: string } | undefined)?.name ?? "A teammate") };
    }
    return {
      queued: Number(row.queued ?? 0),
      claimed: Number(row.claimed ?? 0),
      failed: Number(row.failed ?? 0),
      oldest_queued_at: iso(row.oldest_queued_at),
      last_done_at: iso(row.last_done_at),
      last_done_by: lastBy,
    };
  }
}
