import { randomUUID } from "node:crypto";

import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { findSecrets } from "../../../common/secrets/find-secrets";
import { embed, toPgVector } from "../../memory/repositories/embedding-bge";
import { PageRepository, type PageRecord, type SectionRecord } from "../../pages/repositories/page.repository";
import { SessionRepository } from "../../sessions/repositories/session.repository";
import { SessionResultSchema, type ResultFact, type SessionResult } from "../contracts/job.contract";
import { JobQueueRepository, type JobRecord } from "../repositories/job-queue.repository";
import {
  ASK_AGENT_AT,
  BRIEF_DEBOUNCE_MS,
  DUPLICATE_AT,
  MAX_FACTS_PER_SESSION,
  MAX_TAGS,
  PAGE_MAX_SECTIONS,
  UUID,
  checkAgentSection,
  citedIds,
  confirmedConfidence,
  deterministicAppend,
  extractedConfidence,
  guardSupersede,
  mapKind,
  normaliseForMatch,
  pageTitleOk,
  quoteFound,
  sameHeading,
  slugTag,
  withoutBlocksCiting,
  type SupersedeCandidate,
} from "../rules/living-rules";

type Tx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

interface Neighbour extends SupersedeCandidate {
  similarity: number;
  confidence: number;
}

export interface ApplyReport {
  facts: { saved: number; duplicates: number; superseded: number; dropped: Record<string, number> };
  sections: { written: number; fallback: number; refused: Record<string, number> };
  pages: { created: number; changed: string[] };
  brief_job: string | null;
}

const bump = (counts: Record<string, number>, key: string) => (counts[key] = (counts[key] ?? 0) + 1);

/**
 * Applies a `process_session` result posted by a member's Mac. Deterministic and re-validated:
 * the server never trusts the worker for anything code can check.
 *
 * - A fact is kept only when its quote is found in the session's turns (Spec 01 §5 quote gate)
 *   and neither statement nor quote holds a secret (Spec 02 §9). It is saved as a fact of the
 *   session's own author — never of the worker who processed it.
 * - Duplicate and supersede are arithmetic first (Spec 02 §3), on the server's own embeddings:
 *   ≥ 0.97 is a duplicate whatever the worker said; < 0.82 is new whatever the worker said; in
 *   between the worker's dedupe agent answer is accepted after the supersede guards.
 * - A section write is refused on a locked section, and may cite only facts of this space that
 *   are not personal. A body that fails the checks becomes the deterministic append (Spec 02 §6).
 */
@Injectable()
export class SessionResultApplier {
  private readonly logger = new Logger(SessionResultApplier.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly jobs: JobQueueRepository,
    private readonly pages: PageRepository,
    private readonly sessions: SessionRepository,
  ) {}

  async apply(job: JobRecord, workerUserId: string, raw: unknown): Promise<ApplyReport> {
    const parsed = SessionResultSchema.safeParse(raw);
    if (!parsed.success) throw new ConflictException({ code: "invalid_result", message: "The job result does not match the protocol.", details: parsed.error.flatten() });
    const result: SessionResult = parsed.data;
    const report: ApplyReport = {
      facts: { saved: 0, duplicates: 0, superseded: 0, dropped: {} },
      sections: { written: 0, fallback: 0, refused: {} },
      pages: { created: 0, changed: [] },
      brief_job: null,
    };

    const session = job.session_id ? await this.sessions.findById(job.session_id) : null;
    if (!session || !job.project_id || session.project_id !== job.project_id) {
      await this.jobs.markDone(job.id, { skipped: "session_gone" });
      return report;
    }
    const turns = (await this.sessions.turnsForSession(session.id)).filter((t) => t.role !== "system");
    const turnTexts = turns.map((t) => t.content);

    // ── 1. screen the facts: quote gate, secrets, repeats (no database writes yet) ──
    const screened: { fact: ResultFact; role: string | null }[] = [];
    const dropped = new Set<string>();
    const seen = new Set<string>();
    for (const fact of result.facts) {
      const key = normaliseForMatch(fact.statement).toLowerCase();
      if (screened.length >= MAX_FACTS_PER_SESSION) {
        bump(report.facts.dropped, "over_cap");
        dropped.add(fact.id.toLowerCase());
        continue;
      }
      if (seen.has(key)) {
        bump(report.facts.dropped, "repeated");
        dropped.add(fact.id.toLowerCase());
        continue;
      }
      const quote = quoteFound(fact.quote, turnTexts);
      if (!quote.found) {
        bump(report.facts.dropped, "quote_not_found");
        dropped.add(fact.id.toLowerCase());
        continue;
      }
      if (findSecrets(fact.statement).length || findSecrets(fact.quote).length) {
        bump(report.facts.dropped, "secret");
        dropped.add(fact.id.toLowerCase());
        continue;
      }
      seen.add(key);
      screened.push({ fact, role: quote.turnIndex >= 0 ? (turns[quote.turnIndex]?.role ?? null) : null });
    }

    // ── 2. embeddings for dedupe and search (a network call, so outside the transaction) ──
    const vectors = new Map<string, number[] | null>();
    for (const { fact } of screened) vectors.set(fact.id, await embed(fact.statement).catch(() => null));

    const sectionsToEmbed = new Set<string>();
    await this.db.transaction(async (tx) => {
      const held = await this.jobs.lockHeld(job.id, workerUserId, tx);
      if (!held) throw new ConflictException({ code: "lease_lost", message: "This job is no longer yours to complete." });

      const project = await tx.execute(sql`select org_id from projects where id = ${job.project_id}::uuid`);
      const orgId = ((project.rows[0] as { org_id?: string | null } | undefined)?.org_id ?? null) as string | null;
      const now = new Date().toISOString();

      // ── 3. facts ──
      const idMap = new Map<string, string>(); // worker's id → the id the page may cite
      for (const { fact, role } of screened) {
        const vector = vectors.get(fact.id) ?? null;
        const neighbours = await this.neighbours(tx, job.project_id!, vector, fact.statement);
        const best = neighbours[0];
        const kind = fact.kind;
        let duplicateOf: string | null = null;
        let supersedes: string[] = [];
        if (best && best.similarity >= DUPLICATE_AT) {
          duplicateOf = best.id;
        } else if (vector === null || (best && best.similarity >= ASK_AGENT_AT)) {
          // Grey band (or no embedding to decide with): the worker's dedupe agent answer, guarded.
          const band = vector === null ? neighbours : neighbours.filter((n) => n.similarity >= ASK_AGENT_AT);
          if (fact.duplicate_of && band.some((n) => n.id === fact.duplicate_of!.toLowerCase())) duplicateOf = fact.duplicate_of.toLowerCase();
          else {
            const candidates = vector === null ? await this.candidatesById(tx, job.project_id!, fact.supersedes) : band;
            supersedes = guardSupersede(
              { kind, created_at: now, project_id: job.project_id!, owner_user_id: session.owner_user_id },
              fact.supersedes.map((id) => id.toLowerCase()),
              candidates,
            ).supersedes;
          }
        }

        if (duplicateOf) {
          const existing = neighbours.find((n) => n.id === duplicateOf);
          await tx.execute(sql`
            update memories set
                   source_refs = coalesce(source_refs, '[]'::jsonb) || ${JSON.stringify([{ kind: "also_seen_in", ref: session.id }])}::jsonb,
                   confidence = ${confirmedConfidence(existing?.confidence ?? 0.75)}, updated_at = now()
             where id = ${duplicateOf}::uuid
          `);
          idMap.set(fact.id.toLowerCase(), duplicateOf);
          report.facts.duplicates++;
          continue;
        }

        let id = fact.id.toLowerCase();
        const taken = await tx.execute(sql`select 1 from memories where id = ${id}::uuid`);
        if (!UUID.test(id) || taken.rows.length) id = randomUUID();
        const mapped = mapKind(kind);
        await tx.execute(sql`
          insert into memories (id, org_id, project_id, owner_user_id, content, kind, visibility, confidence, importance,
                                source_refs, archived, session_id, source, quote, valid_from, embedding)
          values (${id}::uuid, ${orgId}::uuid, ${job.project_id}::uuid, ${session.owner_user_id}::uuid, ${fact.statement.trim()},
                  ${mapped.dbKind}::memory_kind, 'project'::memory_visibility, ${extractedConfidence(role)}, 0.5,
                  '[]'::jsonb, false, ${session.id}::uuid, ${session.source}, ${fact.quote}, ${session.started_at}::timestamptz,
                  ${vector ? sql`${toPgVector(vector)}::vector` : sql`null`})
        `);
        await this.attachTags(tx, orgId, id, [...fact.tags, ...mapped.extraTags]);
        for (const old of supersedes) {
          await tx.execute(sql`
            update memories set superseded_by = ${id}::uuid, valid_to = now(), updated_at = now()
             where id = ${old}::uuid and project_id = ${job.project_id}::uuid and superseded_by is null
          `);
          report.facts.superseded++;
        }
        idMap.set(fact.id.toLowerCase(), id);
        report.facts.saved++;
      }

      // ── 4. sections ──
      const newPages = new Map<string, PageRecord>();
      const touchedPages = new Set<string>();
      for (const write of result.sections) {
        const page = await this.resolvePage(tx, job.project_id!, write.page_id, write.new_page_title, newPages, report);
        if (!page) continue;
        const sections = await this.pages.sectionsOf([page.id], tx);
        let section: SectionRecord | undefined = write.section_id
          ? sections.find((s) => s.id === write.section_id!.toLowerCase())
          : sections.find((s) => sameHeading(s.heading, write.heading));
        if (write.section_id && !section) {
          bump(report.sections.refused, "unknown_section");
          continue;
        }
        if (section?.locked) {
          bump(report.sections.refused, "locked");
          continue;
        }
        if (!section) {
          if (sections.length >= PAGE_MAX_SECTIONS) {
            bump(report.sections.refused, "page_full");
            continue;
          }
          section = await this.pages.createSection(tx, page.id, write.heading);
        }

        // Cite what the server kept: the worker's ids → saved (or duplicate) ids; blocks resting on a refused fact go.
        let body = write.body_md.replace(/\[\^f:([0-9a-fA-F-]{36})\]/g, (whole, id: string) => {
          const to = idMap.get(id.toLowerCase());
          return to ? `[^f:${to}]` : whole;
        });
        body = withoutBlocksCiting(body, dropped);
        const citable = await this.citable(tx, job.project_id!, citedIds(body));
        const check = checkAgentSection(body, citable);
        let reason = `agent:${write.mode}`;
        if (!check.ok) {
          // The deterministic append: this job's facts the worker meant for this section, one bullet each.
          const intended = citedIds(write.body_md)
            .map((id) => idMap.get(id))
            .filter((id): id is string => Boolean(id));
          const statements = await this.statements(tx, job.project_id!, [...new Set(intended)]);
          const fresh = statements.filter((s) => !section!.fact_ids.includes(s.id));
          if (!fresh.length) {
            bump(report.sections.refused, check.reason);
            continue;
          }
          body = deterministicAppend(section.body_md, fresh);
          reason = `fallback:${check.reason}`;
          report.sections.fallback++;
          for (const s of fresh) citable.add(s.id);
          for (const id of section.fact_ids) citable.add(id);
        }
        if (body.trim() === section.body_md.trim()) continue;
        await this.pages.writeSection(tx, {
          pageId: page.id,
          sectionId: section.id,
          body,
          citable,
          lock: false,
          actor: "agent:write_section",
          reason: `${reason}; session ${session.id}; worker ${workerUserId}`,
        });
        sectionsToEmbed.add(section.id);
        touchedPages.add(page.id);
        report.sections.written++;
      }
      report.pages.changed = [...touchedPages];

      // ── 5. the session: title and summary from the summarise agent, the extraction record ──
      const summary = result.summary;
      const extraction = {
        facts: report.facts.saved,
        duplicates: report.facts.duplicates,
        dropped_by_reason: report.facts.dropped,
        unrouted: result.unrouted.length,
        sections_written: report.sections.written,
        processed_by: workerUserId,
        processed_at: now,
        model: typeof result.stats.model === "string" ? result.stats.model.slice(0, 80) : null,
        runtime: typeof result.stats.runtime === "string" ? result.stats.runtime.slice(0, 80) : null,
      };
      await tx.execute(sql`
        update kt_sessions set
               title = case when coalesce(title, '') = '' and ${summary?.title ?? ""} <> '' then ${summary?.title ?? ""} else title end,
               summary = case when (summary is null or summary = '' or summary = '(closed automatically — idle)') and ${summary?.summary ?? ""} <> ''
                              then ${summary?.summary ?? ""} else summary end,
               metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ extraction, open_questions: summary?.open_questions ?? [] })}::jsonb,
               updated_at = now()
         where id = ${session.id}::uuid
      `);

      await this.jobs.markDone(job.id, { ...report, extraction }, tx);

      // ── 6. the brief follows the pages, at most once every 10 minutes per space ──
      if (touchedPages.size) {
        const brief = await tx.execute(sql`select updated_at from briefs where project_id = ${job.project_id}::uuid`);
        const last = (brief.rows[0] as { updated_at?: Date | string } | undefined)?.updated_at;
        const earliest = last ? new Date(new Date(last).getTime() + BRIEF_DEBOUNCE_MS) : new Date(0);
        report.brief_job = await this.jobs.enqueue(
          "refresh_brief",
          { projectId: job.project_id, dedupeKey: `brief:${job.project_id}`, runAfter: earliest > new Date() ? earliest : undefined },
          tx,
        );
      }
    });

    for (const id of sectionsToEmbed) await this.pages.embedSection(id).catch(() => false);
    this.logger.log(`[jobs] applied ${job.id}: ${JSON.stringify({ facts: report.facts, sections: report.sections })}`);
    return report;
  }

  /**
   * The 10 nearest facts of this space (Spec 02 §3): not archived, not superseded — and not
   * personal, so a teammate's private note never swallows a fact the whole space should see.
   */
  private async neighbours(tx: Tx, projectId: string, vector: number[] | null, statement: string): Promise<Neighbour[]> {
    const rows = vector
      ? await tx.execute(sql`
          select id, project_id, created_at, owner_user_id, is_pinned, confidence,
                 (1 - (embedding <=> ${toPgVector(vector)}::vector))::float as similarity
            from memories
           where project_id = ${projectId}::uuid and archived = false and superseded_by is null and embedding is not null
             and visibility <> 'personal'
           order by embedding <=> ${toPgVector(vector)}::vector
           limit 10
        `)
      : await tx.execute(sql`
          select id, project_id, created_at, owner_user_id, is_pinned, confidence,
                 (case when lower(content) = lower(${statement.trim()}) then 1 else 0 end)::float as similarity
            from memories
           where project_id = ${projectId}::uuid and archived = false and superseded_by is null
             and visibility <> 'personal' and lower(content) = lower(${statement.trim()})
           limit 10
        `);
    return (rows.rows as Record<string, unknown>[])
      .map((r) => ({
        id: String(r.id),
        project_id: String(r.project_id),
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        owner_user_id: String(r.owner_user_id),
        is_pinned: Boolean(r.is_pinned),
        confidence: Number(r.confidence),
        similarity: Number(r.similarity),
      }))
      .filter((n) => Number.isFinite(n.similarity))
      .sort((a, b) => b.similarity - a.similarity);
  }

  private async candidatesById(tx: Tx, projectId: string, ids: string[]): Promise<Neighbour[]> {
    const valid = ids.map((id) => id.toLowerCase()).filter((id) => UUID.test(id));
    if (!valid.length) return [];
    const list = sql.join(valid.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await tx.execute(sql`
      select id, project_id, created_at, owner_user_id, is_pinned, confidence from memories
       where id in (${list}) and project_id = ${projectId}::uuid and archived = false and superseded_by is null
         and visibility <> 'personal'
    `);
    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      project_id: String(r.project_id),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      owner_user_id: String(r.owner_user_id),
      is_pinned: Boolean(r.is_pinned),
      confidence: Number(r.confidence),
      similarity: 0,
    }));
  }

  /** Facts a page in this space may cite: in the space, not personal, not archived. */
  private async citable(tx: Tx, projectId: string, ids: string[]): Promise<Set<string>> {
    const valid = ids.filter((id) => UUID.test(id));
    if (!valid.length) return new Set();
    const list = sql.join(valid.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await tx.execute(sql`
      select id from memories
       where id in (${list}) and project_id = ${projectId}::uuid and visibility <> 'personal' and archived = false
    `);
    return new Set((rows.rows as { id: string }[]).map((r) => String(r.id)));
  }

  private async statements(tx: Tx, projectId: string, ids: string[]): Promise<{ id: string; statement: string }[]> {
    if (!ids.length) return [];
    const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await tx.execute(sql`
      select id, content from memories
       where id in (${list}) and project_id = ${projectId}::uuid and visibility <> 'personal' and archived = false
    `);
    const byId = new Map((rows.rows as { id: string; content: string }[]).map((r) => [String(r.id), String(r.content)]));
    return ids.filter((id) => byId.has(id)).map((id) => ({ id, statement: byId.get(id)! }));
  }

  private async resolvePage(
    tx: Tx,
    projectId: string,
    pageId: string | null,
    newTitle: string | null,
    created: Map<string, PageRecord>,
    report: ApplyReport,
  ): Promise<PageRecord | null> {
    if (pageId) {
      const page = await this.pages.findPage(pageId.toLowerCase(), tx);
      if (!page || page.project_id !== projectId || page.status !== "active") {
        bump(report.sections.refused, "unknown_page");
        return null;
      }
      return page;
    }
    const title = (newTitle ?? "").trim();
    if (!pageTitleOk(title)) {
      bump(report.sections.refused, "bad_title");
      return null;
    }
    const key = title.toLowerCase();
    const known = created.get(key);
    if (known) return known;
    const existing = await tx.execute(sql`
      select id from pages where project_id = ${projectId}::uuid and status = 'active' and lower(title) = ${key} limit 1
    `);
    const existingId = (existing.rows[0] as { id?: string } | undefined)?.id;
    const page = existingId ? await this.pages.findPage(existingId, tx) : await this.pages.createPage(tx, projectId, title);
    if (!page) return null;
    if (!existingId) report.pages.created++;
    created.set(key, page);
    return page;
  }

  /** Tags by slug (Spec 02 §4 slug rule), at most four plus the kind marker. */
  private async attachTags(tx: Tx, orgId: string | null, memoryId: string, raw: string[]): Promise<void> {
    const markers = new Set(["open-question", "action", "idea"]);
    const slugs: string[] = [];
    for (const r of raw) {
      const slug = markers.has(r) ? r : slugTag(r);
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
    const kept = [...slugs.filter((s) => !markers.has(s)).slice(0, MAX_TAGS), ...slugs.filter((s) => markers.has(s))];
    for (const slug of kept) {
      const found = await tx.execute(sql`select id from tags where slug = ${slug} order by created_at limit 1`);
      let tagId = (found.rows[0] as { id?: string } | undefined)?.id;
      if (!tagId) {
        const made = await tx.execute(sql`
          insert into tags (org_id, owner_user_id, slug, display_name) values (${orgId}::uuid, null, ${slug}, ${slug}) returning id
        `);
        tagId = (made.rows[0] as { id: string }).id;
      }
      await tx.execute(sql`insert into memory_tags (memory_id, tag_id) values (${memoryId}::uuid, ${tagId}::uuid) on conflict do nothing`);
      await tx.execute(sql`update tags set use_count = use_count + 1, updated_at = now() where id = ${tagId}::uuid`);
    }
  }
}
