import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { embed, toPgVector } from "../../memory/repositories/embedding-bge";
import { citedIds, pageSlug, pageSummary, stripCitations } from "../../jobs/rules/living-rules";

type Executor = Pick<DrizzleDb, "execute">;

/** Timestamps as ISO 8601 (raw SQL hands back Postgres text like "2026-09-19 12:06:27.55+00"). */
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

export interface SectionRecord {
  id: string;
  page_id: string;
  seq: number;
  heading: string;
  body_md: string;
  locked: boolean;
  version: number;
  updated_at: string;
  fact_ids: string[];
}

export interface PageRecord {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  summary: string;
  status: "active" | "archived";
  version: number;
  edited_by_human_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageListItem extends PageRecord {
  section_count: number;
  session_count: number;
}

export interface CitedFact {
  id: string;
  project_id: string;
  content: string;
  visibility: string;
  archived: boolean;
  superseded_by: string | null;
  created_at: string;
  owner: { id: string; name: string };
  session: { id: string; title: string | null; source: string; project_id: string; started_at: string; owner: { id: string; name: string } } | null;
}

export interface SectionHit {
  id: string;
  page_id: string;
  page_title: string;
  project_id: string;
  project_name: string;
  heading: string;
  body_md: string;
  locked: boolean;
  updated_at: string;
  score: number;
  similarity: number | null;
}

const NAME = (alias: string) =>
  sql.raw(`coalesce(nullif(${alias}.display_name, ''), split_part(${alias}.email, '@', 1), 'Someone')`);

function toPage(row: Record<string, unknown>): PageRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    slug: String(row.slug),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    status: row.status as PageRecord["status"],
    version: Number(row.version),
    edited_by_human_at: iso(row.edited_by_human_at),
    created_at: iso(row.created_at) ?? "",
    updated_at: iso(row.updated_at) ?? "",
  };
}

function toSection(row: Record<string, unknown>): SectionRecord {
  return {
    id: String(row.id),
    page_id: String(row.page_id),
    seq: Number(row.seq),
    heading: String(row.heading),
    body_md: String(row.body_md ?? ""),
    locked: Boolean(row.locked),
    version: Number(row.version),
    updated_at: iso(row.updated_at) ?? "",
    fact_ids: Array.isArray(row.fact_ids) ? (row.fact_ids as string[]).filter(Boolean) : [],
  };
}

/** Pages (T2) and briefs (T3). Plain SQL; needs only DRIZZLE, so several modules can provide it. */
@Injectable()
export class PageRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── reads ────────────────────────────────────────────────────────────

  async listByProject(projectId: string): Promise<PageListItem[]> {
    const result = await this.db.execute(sql`
      select p.*,
             (select count(*) from page_sections s where s.page_id = p.id)::int as section_count,
             (select count(distinct m.session_id) from page_sections s
                join page_section_facts f on f.section_id = s.id
                join memories m on m.id = f.memory_id
               where s.page_id = p.id and m.session_id is not null)::int as session_count
        from pages p
       where p.project_id = ${projectId}::uuid and p.status = 'active'
       order by p.updated_at desc
       limit 200
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      ...toPage(row),
      section_count: Number(row.section_count ?? 0),
      session_count: Number(row.session_count ?? 0),
    }));
  }

  async findPage(pageId: string, db: Executor = this.db): Promise<PageRecord | null> {
    const result = await db.execute(sql`select * from pages where id = ${pageId}::uuid`);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toPage(row) : null;
  }

  async findPageByTitle(projectId: string, title: string): Promise<PageRecord | null> {
    const result = await this.db.execute(sql`
      select * from pages where project_id = ${projectId}::uuid and status = 'active'
         and (lower(title) = lower(${title.trim()}) or slug = ${pageSlug(title)})
       order by updated_at desc limit 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toPage(row) : null;
  }

  async sectionsOf(pageIds: string[], db: Executor = this.db): Promise<SectionRecord[]> {
    if (!pageIds.length) return [];
    const ids = sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `);
    const result = await db.execute(sql`
      select s.id, s.page_id, s.seq, s.heading, s.body_md, s.locked, s.version, s.updated_at,
             coalesce(array_agg(f.memory_id::text) filter (where f.memory_id is not null), '{}') as fact_ids
        from page_sections s
        left join page_section_facts f on f.section_id = s.id
       where s.page_id in (${ids})
       group by s.id
       order by s.page_id, s.seq
    `);
    return (result.rows as Record<string, unknown>[]).map(toSection);
  }

  /** Facts as a page cites them: statement, author, and the session they came from. */
  async factsByIds(ids: string[], db: Executor = this.db): Promise<CitedFact[]> {
    if (!ids.length) return [];
    const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const result = await db.execute(sql`
      select m.id, m.project_id, m.content, m.visibility::text as visibility, m.archived, m.superseded_by, m.created_at,
             m.owner_user_id, ${NAME("op")} as owner_name,
             s.id as session_id, s.title as session_title, s.source as session_source, s.project_id as session_project_id,
             s.started_at as session_started_at, s.owner_user_id as session_owner_id, ${NAME("sp")} as session_owner_name
        from memories m
        left join profiles op on op.user_id = m.owner_user_id
        left join kt_sessions s on s.id = m.session_id
        left join profiles sp on sp.user_id = s.owner_user_id
       where m.id in (${list})
    `);
    return (result.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      project_id: String(r.project_id),
      content: String(r.content),
      visibility: String(r.visibility),
      archived: Boolean(r.archived),
      superseded_by: (r.superseded_by as string | null) ?? null,
      created_at: iso(r.created_at) ?? "",
      owner: { id: String(r.owner_user_id), name: String(r.owner_name) },
      session: r.session_id
        ? {
            id: String(r.session_id),
            title: (r.session_title as string | null) ?? null,
            source: String(r.session_source),
            project_id: String(r.session_project_id),
            started_at: iso(r.session_started_at) ?? "",
            owner: { id: String(r.session_owner_id), name: String(r.session_owner_name) },
          }
        : null,
    }));
  }

  /**
   * Spec 02 §5 step 1: sections of this space with cosine similarity ≥ `minSimilarity` to any of
   * the vectors, grouped by page, the `limit` pages with the highest summed similarity. Pages are
   * then filled up to `limit` with the space's most recently changed pages, so a small space's
   * router always sees every page it has.
   */
  async candidatePages(projectId: string, vectors: number[][], minSimilarity: number, limit: number): Promise<{ page: PageRecord; score: number }[]> {
    const scores = new Map<string, number>();
    for (const vector of vectors) {
      const result = await this.db.execute(sql`
        select s.page_id, (1 - (s.embedding <=> ${toPgVector(vector)}::vector))::float as similarity
          from page_sections s join pages p on p.id = s.page_id
         where p.project_id = ${projectId}::uuid and p.status = 'active' and s.embedding is not null
         order by s.embedding <=> ${toPgVector(vector)}::vector
         limit 20
      `);
      for (const row of result.rows as { page_id: string; similarity: number }[]) {
        const sim = Number(row.similarity);
        if (Number.isFinite(sim) && sim >= minSimilarity) scores.set(row.page_id, (scores.get(row.page_id) ?? 0) + sim);
      }
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const recent = await this.db.execute(sql`
      select * from pages where project_id = ${projectId}::uuid and status = 'active' order by updated_at desc limit ${limit + ranked.length}
    `);
    const byId = new Map((recent.rows as Record<string, unknown>[]).map((r) => [String(r.id), toPage(r)]));
    const missing = ranked.filter(([id]) => !byId.has(id)).map(([id]) => id);
    for (const id of missing) {
      const page = await this.findPage(id);
      if (page) byId.set(id, page);
    }
    const out: { page: PageRecord; score: number }[] = [];
    for (const [id, score] of ranked) {
      const page = byId.get(id);
      if (page) out.push({ page, score });
    }
    for (const page of byId.values()) {
      if (out.length >= limit) break;
      if (!out.some((o) => o.page.id === page.id)) out.push({ page, score: 0 });
    }
    return out;
  }

  // ── writes (inside the caller's transaction) ────────────────────────────

  async createPage(db: Executor, projectId: string, title: string): Promise<PageRecord> {
    const base = pageSlug(title);
    for (let n = 1; n < 50; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const result = await db.execute(sql`
        insert into pages (project_id, slug, title, version) values (${projectId}::uuid, ${slug}, ${title.trim()}, 0)
        on conflict (project_id, slug) do nothing
        returning *
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (row) return toPage(row);
    }
    throw new Error("could not find a free page slug");
  }

  async createSection(db: Executor, pageId: string, heading: string): Promise<SectionRecord> {
    const result = await db.execute(sql`
      insert into page_sections (page_id, seq, heading, body_md, version)
      select ${pageId}::uuid, coalesce(max(seq), 0) + 1, ${heading.trim()}, '', 0 from page_sections where page_id = ${pageId}::uuid
      returning *
    `);
    return toSection(result.rows[0] as Record<string, unknown>);
  }

  /** Writes a section body, its citations, bumps the page version and summary, and records the revision. */
  async writeSection(
    db: Executor,
    input: { pageId: string; sectionId: string; heading?: string; body: string; citable: Set<string>; lock: boolean; actor: string; reason: string },
  ): Promise<{ version: number }> {
    await db.execute(sql`
      update page_sections set body_md = ${input.body}, heading = coalesce(${input.heading ?? null}, heading),
             locked = locked or ${input.lock}, version = version + 1, updated_at = now(), embedding = null
       where id = ${input.sectionId}::uuid
    `);
    await db.execute(sql`delete from page_section_facts where section_id = ${input.sectionId}::uuid`);
    const cites = citedIds(input.body).filter((id) => input.citable.has(id));
    if (cites.length) {
      const values = sql.join(cites.map((id) => sql`(${input.sectionId}::uuid, ${id}::uuid)`), sql`, `);
      await db.execute(sql`insert into page_section_facts (section_id, memory_id) values ${values} on conflict do nothing`);
    }
    const first = await db.execute(sql`
      select body_md from page_sections where page_id = ${input.pageId}::uuid and body_md <> '' order by seq limit 1
    `);
    const summary = pageSummary(String((first.rows[0] as { body_md?: string } | undefined)?.body_md ?? ""));
    const bumped = await db.execute(sql`
      update pages set version = version + 1, summary = ${summary}, updated_at = now(),
             edited_by_human_at = case when ${input.lock} then now() else edited_by_human_at end
       where id = ${input.pageId}::uuid
      returning version
    `);
    const version = Number((bumped.rows[0] as { version: number }).version);
    await this.insertRevision(db, input.pageId, version, input.sectionId, input.actor, input.reason);
    return { version };
  }

  async insertRevision(db: Executor, pageId: string, version: number, sectionId: string | null, actor: string, reason: string): Promise<void> {
    const page = await this.findPage(pageId, db);
    const sections = await this.sectionsOf([pageId], db);
    const snapshot = {
      title: page?.title ?? "",
      summary: page?.summary ?? "",
      sections: sections.map((s) => ({ id: s.id, seq: s.seq, heading: s.heading, body_md: s.body_md, locked: s.locked, fact_ids: s.fact_ids })),
    };
    await db.execute(sql`
      insert into page_revisions (page_id, version, section_id, snapshot, reason, actor)
      values (${pageId}::uuid, ${version}, ${sectionId}::uuid, ${JSON.stringify(snapshot)}::jsonb, ${reason.slice(0, 500)}, ${actor})
    `);
  }

  /** Re-embeds a section after it changed (outside any transaction: a network call). Best effort. */
  async embedSection(sectionId: string): Promise<boolean> {
    const row = await this.db.execute(sql`select heading, body_md from page_sections where id = ${sectionId}::uuid`);
    const r = row.rows[0] as { heading: string; body_md: string } | undefined;
    if (!r) return false;
    const vector = await embed(`${r.heading}\n${stripCitations(r.body_md)}`).catch(() => null);
    if (!vector) return false;
    await this.db.execute(sql`update page_sections set embedding = ${toPgVector(vector)}::vector where id = ${sectionId}::uuid`);
    return true;
  }

  async revisions(pageId: string, limit = 20): Promise<{ version: number; actor: string; reason: string; created_at: string }[]> {
    const result = await this.db.execute(sql`
      select version, actor, reason, created_at from page_revisions where page_id = ${pageId}::uuid order by version desc, created_at desc limit ${limit}
    `);
    return (result.rows as Record<string, unknown>[]).map((r) => ({
      version: Number(r.version),
      actor: String(r.actor),
      reason: String(r.reason ?? ""),
      created_at: iso(r.created_at) ?? "",
    }));
  }

  // ── recall ───────────────────────────────────────────────────────────

  /**
   * Page sections for recall (Spec 01 §4 lists C and D): vector and keyword candidates over the
   * given spaces only, fused by reciprocal rank. The caller passes only spaces the asker may read.
   */
  async searchSections(projectIds: string[], query: string, vector: number[] | null, limit: number): Promise<SectionHit[]> {
    if (!projectIds.length || !query.trim()) return [];
    const ids = sql.join(projectIds.map((id) => sql`${id}::uuid`), sql`, `);
    const v = vector ? toPgVector(vector) : null;
    const result = await this.db.execute(sql`
      with scoped as (
        select s.*, p.title as page_title, p.project_id, pr.name as project_name
          from page_sections s join pages p on p.id = s.page_id join projects pr on pr.id = p.project_id
         where p.project_id in (${ids}) and p.status = 'active' and s.body_md <> ''
      ),
      vec as (
        ${v
          ? sql`select id, row_number() over (order by embedding <=> ${v}::vector) as rnk from scoped where embedding is not null
                order by embedding <=> ${v}::vector limit 40`
          : sql`select null::uuid as id, 0::bigint as rnk where false`}
      ),
      kw as (
        select id, row_number() over (order by ts_rank_cd(tsv, websearch_to_tsquery('simple', ${query})) desc) as rnk
          from scoped where tsv @@ websearch_to_tsquery('simple', ${query})
         order by ts_rank_cd(tsv, websearch_to_tsquery('simple', ${query})) desc limit 40
      ),
      fused as (
        select id, sum(1.0 / (60 + rnk)) as score from (select * from vec union all select * from kw) u group by id
      )
      select sc.id, sc.page_id, sc.page_title, sc.project_id, sc.project_name, sc.heading, sc.body_md, sc.locked, sc.updated_at,
             f.score::float as score,
             ${v ? sql`(1 - (sc.embedding <=> ${v}::vector))::float` : sql`null::float`} as similarity
        from fused f join scoped sc on sc.id = f.id
       order by f.score * (case when sc.locked then 1.10 else 1.0 end) desc
       limit ${limit}
    `);
    return (result.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      page_id: String(r.page_id),
      page_title: String(r.page_title),
      project_id: String(r.project_id),
      project_name: String(r.project_name),
      heading: String(r.heading),
      body_md: String(r.body_md),
      locked: Boolean(r.locked),
      updated_at: iso(r.updated_at) ?? "",
      score: Number(r.score),
      similarity: r.similarity === null || r.similarity === undefined ? null : Number(r.similarity),
    }));
  }

  // ── briefs ───────────────────────────────────────────────────────────

  async brief(projectId: string): Promise<{ brief_md: string; source_version_hash: string | null; updated_at: string } | null> {
    const result = await this.db.execute(sql`select brief_md, source_version_hash, updated_at from briefs where project_id = ${projectId}::uuid`);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row
      ? { brief_md: String(row.brief_md), source_version_hash: (row.source_version_hash as string | null) ?? null, updated_at: iso(row.updated_at) ?? "" }
      : null;
  }

  async upsertBrief(db: Executor, projectId: string, briefMd: string, hash: string, writtenBy: string): Promise<void> {
    await db.execute(sql`
      insert into briefs (project_id, brief_md, source_version_hash, written_by, updated_at)
      values (${projectId}::uuid, ${briefMd}, ${hash}, ${writtenBy}::uuid, now())
      on conflict (project_id) do update set brief_md = excluded.brief_md, source_version_hash = excluded.source_version_hash,
             written_by = excluded.written_by, updated_at = now()
    `);
  }

  /** Input for the brief agent: the space's page summaries and what changed recently. */
  async briefSources(projectId: string): Promise<{
    pages: { id: string; title: string; summary: string; version: number; updated_at: string }[];
    recent_changes: { date: string; page_title: string; change: string }[];
  }> {
    const pages = await this.db.execute(sql`
      select id, title, summary, version, updated_at from pages
       where project_id = ${projectId}::uuid and status = 'active' order by updated_at desc limit 30
    `);
    const changes = await this.db.execute(sql`
      select r.created_at, p.title, r.reason, r.actor from page_revisions r join pages p on p.id = r.page_id
       where p.project_id = ${projectId}::uuid and r.created_at > now() - interval '14 days'
       order by r.created_at desc limit 20
    `);
    return {
      pages: (pages.rows as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        title: String(r.title),
        summary: String(r.summary ?? ""),
        version: Number(r.version),
        updated_at: iso(r.updated_at) ?? "",
      })),
      recent_changes: (changes.rows as Record<string, unknown>[]).map((r) => ({
        date: (iso(r.created_at) ?? "").slice(0, 10),
        page_title: String(r.title),
        change: String(r.actor).startsWith("user:") ? "edited by a person" : "updated from a session",
      })),
    };
  }
}
