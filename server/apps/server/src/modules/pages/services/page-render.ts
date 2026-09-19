import type { CitedFact, PageRecord, SectionRecord } from "../repositories/page.repository";

export interface RenderedSource {
  n: number;
  /** The session the facts came from; null for a fact saved outside any session. */
  session: { id: string; title: string | null; source: string; started_at: string; author: { id: string; name: string } } | null;
  author: { id: string; name: string } | null;
  facts: { id: string; statement: string; created_at: string; author: { id: string; name: string } }[];
  restricted?: true;
}

export interface RenderedPage {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  summary: string;
  version: number;
  updated_at: string;
  edited_by_human_at: string | null;
  sections: { id: string; heading: string; body_md: string; source_md: string; locked: boolean; updated_at: string; citations: { fact_id: string; n: number }[] }[];
  sources: RenderedSource[];
  session_count: number;
  reach: null;
}

const CITE = /\[\^f:([0-9a-fA-F-]{36})\]/g;

/**
 * A page as people read it (J33): citations numbered by source in order of first appearance,
 * `[^f:<uuid>]` rewritten to `[^n]`, and a source list naming who said it and in which session.
 * A source the reader may not open is `{n, restricted: true}` — no title, no author.
 * `source_md` keeps the raw markdown for editing.
 */
export function renderPage(
  page: PageRecord,
  sections: SectionRecord[],
  facts: CitedFact[],
  canReadSession: (session: NonNullable<CitedFact["session"]>) => boolean,
): RenderedPage {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const numberOf = new Map<string, number>();
  const sources: RenderedSource[] = [];
  const keyOf = (f: CitedFact) => (f.session ? `s:${f.session.id}` : `f:${f.id}`);

  const out = sections.map((s) => {
    const citations: { fact_id: string; n: number }[] = [];
    const body = s.body_md.replace(CITE, (_whole, raw: string) => {
      const fact = byId.get(raw.toLowerCase());
      if (!fact) return "";
      const key = keyOf(fact);
      let n = numberOf.get(key);
      if (n === undefined) {
        n = sources.length + 1;
        numberOf.set(key, n);
        const readable = !fact.session || canReadSession(fact.session);
        sources.push(
          readable
            ? {
                n,
                session: fact.session
                  ? { id: fact.session.id, title: fact.session.title, source: fact.session.source, started_at: fact.session.started_at, author: fact.session.owner }
                  : null,
                author: fact.session ? fact.session.owner : fact.owner,
                facts: [],
              }
            : { n, session: null, author: null, facts: [], restricted: true },
        );
      }
      const source = sources[n - 1]!;
      if (!source.restricted && !source.facts.some((x) => x.id === fact.id)) {
        source.facts.push({ id: fact.id, statement: fact.content, created_at: fact.created_at, author: fact.owner });
      }
      if (!citations.some((c) => c.fact_id === fact.id)) citations.push({ fact_id: fact.id, n });
      return `[^${n}]`;
    });
    return {
      id: s.id,
      heading: s.heading,
      body_md: body.replace(/(\[\^\d+\])(?:\1)+/g, "$1"),
      source_md: s.body_md,
      locked: s.locked,
      updated_at: s.updated_at,
      citations,
    };
  });

  return {
    id: page.id,
    project_id: page.project_id,
    slug: page.slug,
    title: page.title,
    summary: page.summary,
    version: page.version,
    updated_at: page.updated_at,
    edited_by_human_at: page.edited_by_human_at,
    sections: out,
    sources,
    session_count: sources.filter((s) => s.session || s.restricted).length,
    reach: null,
  };
}

/** The page as one markdown document, for kt_page. */
export function pageMarkdown(page: RenderedPage): string {
  const lines = [`# ${page.title}`, ""];
  for (const s of page.sections) {
    lines.push(`## ${s.heading}${s.locked ? " (edited by a person)" : ""}`, "", s.body_md.trim() || "_Empty._", "");
  }
  if (page.sources.length) {
    lines.push("## Sources", "");
    for (const src of page.sources) {
      if (src.restricted) lines.push(`[^${src.n}]: a session you cannot open`);
      else if (src.session) lines.push(`[^${src.n}]: ${src.session.title ?? "Untitled session"} — ${src.session.author.name}, ${src.session.source}, ${src.session.started_at.slice(0, 10)} (session ${src.session.id})`);
      else lines.push(`[^${src.n}]: saved by ${src.author?.name ?? "someone"}`);
    }
  }
  return lines.join("\n").trim();
}
