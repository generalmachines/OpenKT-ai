import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { NotFoundDomainError, UnauthorizedDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { findSecrets } from "../../../common/secrets/find-secrets";
import { embed, toPgVector } from "../../memory/repositories/embedding-bge";
import { PageRepository } from "../../pages/repositories/page.repository";
import { SessionRepository } from "../../sessions/repositories/session.repository";
import {
  BriefResultSchema,
  JOB_KINDS,
  type ClaimJobInput,
  type FailJobInput,
  type JobKind,
  type LookupInput,
} from "../contracts/job.contract";
import { JobQueueRepository, type JobRecord } from "../repositories/job-queue.repository";
import {
  BRIEF_MAX_CHARS,
  CANDIDATE_SECTION_SIMILARITY,
  MAX_CANDIDATE_PAGES,
  PAGE_MAX_SECTIONS,
  SECTION_MAX_CHARS,
  unmapKind,
} from "../rules/living-rules";
import { SessionResultApplier, type ApplyReport } from "./session-result.applier";

const NAME = (alias: string) => sql.raw(`coalesce(nullif(${alias}.display_name, ''), split_part(${alias}.email, '@', 1), 'Someone')`);
const iso = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? String(v ?? "") : d.toISOString();
};

/**
 * The job protocol, server side. The Mac that claims a job gets everything the job needs and
 * nothing more; what it posts back is re-validated by the appliers.
 */
@Injectable()
export class JobsApplicationService {
  private readonly logger = new Logger(JobsApplicationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly jobs: JobQueueRepository,
    private readonly pages: PageRepository,
    private readonly sessions: SessionRepository,
    private readonly sessionApplier: SessionResultApplier,
  ) {}

  private userId(context: ActorContext): string {
    const id = context.principal.userId;
    if (!id) throw new UnauthorizedDomainError("user principal required");
    return id;
  }

  /** Claims the next job the caller may run, with its input. `{job: null}` when there is none. */
  async claim(context: ActorContext, input: ClaimJobInput): Promise<{ job: ReturnType<typeof publicJob> | null; input?: unknown }> {
    const userId = this.userId(context);
    const kinds: readonly JobKind[] = input.kinds ?? JOB_KINDS;
    // A brief whose pages did not change is finished here without a model; try the next job.
    for (let i = 0; i < 5; i++) {
      const job = await this.jobs.claim(userId, kinds);
      if (!job) return { job: null };
      if (job.kind === "process_session") {
        const built = await this.sessionInput(job);
        if (built) return { job: publicJob(job), input: built };
        await this.jobs.markDone(job.id, { skipped: "session_gone" });
        continue;
      }
      if (job.kind === "refresh_brief") {
        const built = await this.briefInput(job);
        if (built) return { job: publicJob(job), input: built };
        continue;
      }
      await this.jobs.fail(job.id, userId, `unknown job kind ${job.kind}`, false);
    }
    return { job: null };
  }

  private async sessionInput(job: JobRecord): Promise<Record<string, unknown> | null> {
    const session = job.session_id ? await this.sessions.findById(job.session_id) : null;
    if (!session || session.project_id !== job.project_id) return null;
    const [turns, meta, vocabulary, sessionFacts] = await Promise.all([
      this.sessions.turnsForSession(session.id),
      this.db.execute(sql`
        select pr.name as space_name, ${NAME("p")} as author_name
          from projects pr left join profiles p on p.user_id = ${session.owner_user_id}::uuid
         where pr.id = ${session.project_id}::uuid
      `),
      this.db.execute(sql`
        select t.slug as tag, count(*)::int as count
          from memory_tags mt join memories m on m.id = mt.memory_id join tags t on t.id = mt.tag_id
         where m.project_id = ${session.project_id}::uuid and m.archived = false
           and t.slug not in ('open-question', 'action', 'idea')
         group by t.slug order by count(*) desc, t.slug limit 60
      `),
      // Facts saved during the session itself (kt_save_memory): they are routed to pages too.
      this.db.execute(sql`
        select m.id, m.content, m.kind::text as kind, m.created_at, ${NAME("p")} as author_name,
               coalesce(array_agg(t.slug) filter (where t.slug is not null), '{}') as tags
          from memories m left join profiles p on p.user_id = m.owner_user_id
          left join memory_tags mt on mt.memory_id = m.id left join tags t on t.id = mt.tag_id
         where m.session_id = ${session.id}::uuid and m.archived = false and m.superseded_by is null
           and m.visibility <> 'personal'
         group by m.id, p.display_name, p.email
         order by m.created_at limit 60
      `),
    ]);
    const row = (meta.rows[0] ?? {}) as { space_name?: string; author_name?: string };
    return {
      space: { id: session.project_id, name: row.space_name ?? "" },
      session: {
        id: session.id,
        title: session.title,
        summary: session.summary,
        source: session.source,
        started_at: session.started_at,
        ended_at: session.ended_at,
        author: { id: session.owner_user_id, name: row.author_name ?? "Someone" },
      },
      turns: turns.filter((t) => t.role !== "system").map((t) => ({ seq: t.seq, role: t.role, content: t.content })),
      vocabulary: (vocabulary.rows as { tag: string; count: number }[]).map((v) => ({ tag: v.tag, count: Number(v.count) })),
      session_facts: (sessionFacts.rows as Record<string, unknown>[]).map((f) => ({
        id: String(f.id),
        statement: String(f.content),
        kind: unmapKind(String(f.kind), (f.tags as string[]) ?? []),
        author: String(f.author_name),
        created_at: iso(f.created_at),
      })),
      limits: { section_max_chars: SECTION_MAX_CHARS, page_max_sections: PAGE_MAX_SECTIONS, brief_max_chars: BRIEF_MAX_CHARS },
    };
  }

  /** The brief's input, or null (and the job finished) when the page summaries did not change. */
  private async briefInput(job: JobRecord): Promise<Record<string, unknown> | null> {
    if (!job.project_id) {
      await this.jobs.markDone(job.id, { skipped: "no_space" });
      return null;
    }
    const [sources, previous, space] = await Promise.all([
      this.pages.briefSources(job.project_id),
      this.pages.brief(job.project_id),
      this.db.execute(sql`select name from projects where id = ${job.project_id}::uuid`),
    ]);
    const hash = sourceHash(sources.pages);
    if (!sources.pages.length || previous?.source_version_hash === hash) {
      await this.jobs.markDone(job.id, { skipped: sources.pages.length ? "unchanged" : "no_pages" });
      return null;
    }
    return {
      space: { id: job.project_id, name: String((space.rows[0] as { name?: string } | undefined)?.name ?? "") },
      pages: sources.pages.map((p) => ({ title: p.title, summary: p.summary, updated_at: p.updated_at })),
      recent_changes: sources.recent_changes,
      previous_brief: previous?.brief_md ?? null,
      source_hash: hash,
      max_chars: BRIEF_MAX_CHARS,
    };
  }

  /**
   * For the worker's dedupe and routing steps (Spec 02 §3, §5): each new fact's nearest facts in
   * the space, and the candidate pages with their sections. Uses the server's embeddings, the same
   * ones the facts are indexed with. Personal facts of other people are never shown. Extends the lease.
   */
  async lookup(context: ActorContext, jobId: string, input: LookupInput) {
    const userId = this.userId(context);
    const job = await this.jobs.heartbeat(jobId, userId);
    if (!job || job.kind !== "process_session" || !job.project_id) throw new NotFoundDomainError("job");

    const vectors: number[][] = [];
    const neighbours: Record<string, unknown[]> = {};
    let embedding: "ok" | "unavailable" = "ok";
    for (const fact of input.facts) {
      const vector = await embed(fact.statement).catch(() => null);
      if (!vector) {
        embedding = "unavailable";
        neighbours[fact.id] = [];
        continue;
      }
      vectors.push(vector);
      const rows = await this.db.execute(sql`
        select m.id, m.content, m.kind::text as kind, m.created_at, m.owner_user_id, m.is_pinned, m.confidence,
               coalesce(array_agg(t.slug) filter (where t.slug is not null), '{}') as tags,
               (1 - (m.embedding <=> ${toPgVector(vector)}::vector))::float as similarity
          from memories m left join memory_tags mt on mt.memory_id = m.id left join tags t on t.id = mt.tag_id
         where m.project_id = ${job.project_id}::uuid and m.archived = false and m.superseded_by is null
           and m.embedding is not null and (m.visibility <> 'personal' or m.owner_user_id = ${userId}::uuid)
         group by m.id
         order by m.embedding <=> ${toPgVector(vector)}::vector
         limit 10
      `);
      neighbours[fact.id] = (rows.rows as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        project_id: job.project_id,
        statement: String(r.content),
        kind: unmapKind(String(r.kind), (r.tags as string[]) ?? []),
        created_at: iso(r.created_at),
        owner_user_id: String(r.owner_user_id),
        is_pinned: Boolean(r.is_pinned),
        confidence: Number(r.confidence),
        similarity: Number(r.similarity),
      }));
    }

    const candidates = await this.pages.candidatePages(job.project_id, vectors, CANDIDATE_SECTION_SIMILARITY, MAX_CANDIDATE_PAGES);
    const sections = await this.pages.sectionsOf(candidates.map((c) => c.page.id));
    return {
      lease_until: job.lease_until,
      embedding,
      neighbours,
      pages: candidates.map(({ page, score }) => ({
        id: page.id,
        title: page.title,
        summary: page.summary,
        score,
        sections: sections
          .filter((s) => s.page_id === page.id)
          .map((s) => ({ id: s.id, heading: s.heading, body_md: s.body_md, locked: s.locked, fact_ids: s.fact_ids })),
      })),
    };
  }

  async complete(context: ActorContext, jobId: string, result: unknown): Promise<{ job_id: string; status: "done"; applied: ApplyReport | Record<string, unknown> }> {
    const userId = this.userId(context);
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundDomainError("job");
    if (job.status !== "claimed" || job.claimed_by !== userId) {
      throw new ConflictException({ code: "lease_lost", message: "This job is no longer yours to complete." });
    }
    if (job.kind === "process_session") {
      const applied = await this.sessionApplier.apply(job, userId, result);
      return { job_id: job.id, status: "done", applied };
    }
    const applied = await this.applyBrief(job, userId, result);
    return { job_id: job.id, status: "done", applied };
  }

  private async applyBrief(job: JobRecord, userId: string, raw: unknown): Promise<Record<string, unknown>> {
    const parsed = BriefResultSchema.safeParse(raw);
    if (!parsed.success) throw new ConflictException({ code: "invalid_result", message: "The job result does not match the protocol.", details: parsed.error.flatten() });
    const brief = parsed.data.brief_md.trim();
    let outcome: Record<string, unknown>;
    await this.db.transaction(async (tx) => {
      const held = await this.jobs.lockHeld(job.id, userId, tx);
      if (!held) throw new ConflictException({ code: "lease_lost", message: "This job is no longer yours to complete." });
      if (!brief) outcome = { kept_previous: true };
      else if (brief.length > BRIEF_MAX_CHARS) outcome = { refused: "too_long" };
      else if (findSecrets(brief).length) outcome = { refused: "secret" };
      else {
        await this.pages.upsertBrief(tx, job.project_id!, brief, parsed.data.source_hash, userId);
        outcome = { written: true, chars: brief.length };
      }
      await this.jobs.markDone(job.id, outcome!, tx);
    });
    return outcome!;
  }

  async fail(context: ActorContext, jobId: string, input: FailJobInput): Promise<{ job_id: string; status: string; run_after: string | null }> {
    const userId = this.userId(context);
    const job = await this.jobs.fail(jobId, userId, input.error, input.retry);
    if (!job) throw new ConflictException({ code: "lease_lost", message: "This job is no longer yours." });
    this.logger.warn(`[jobs] ${job.kind} ${job.id} failed on attempt ${job.attempts}: ${input.error.slice(0, 200)}`);
    return { job_id: job.id, status: job.status, run_after: job.status === "queued" ? job.run_after : null };
  }
}

function publicJob(job: JobRecord) {
  return {
    id: job.id,
    kind: job.kind,
    project_id: job.project_id,
    session_id: job.session_id,
    attempts: job.attempts,
    lease_until: job.lease_until,
  };
}

/** Spec 01 §5: the brief is regenerated when the hash of the space's page summaries changes. */
export function sourceHash(pages: { id: string; title: string; summary: string }[]): string {
  const canonical = [...pages].sort((a, b) => a.id.localeCompare(b.id)).map((p) => [p.id, p.title, p.summary]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
