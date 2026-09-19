// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { AgentInputError } from "../errors.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { fenceJson } from "../text.js";
import type { Kind } from "../types.js";

export interface RouteInput {
  facts: { id: string; statement: string; kind: Kind }[];
  /** Top-k candidate pages from the same space, at most 8. */
  pages: { id: string; title: string; summary: string; section_titles: string[] }[];
}
export type RouteAction = "append" | "rewrite_section" | "new_page" | "noop";
export interface RouteDecision {
  fact_id: string;
  action: RouteAction;
  page_id: string | null;
  section_title: string | null;
  new_page_title: string | null;
}
export interface RouteOutput {
  decisions: RouteDecision[];
}

export const MAX_PAGES = 8;
export const MAX_FACTS = 20;
/** Spec 02 §5: a page title is a noun phrase, never a sentence. */
export const MAX_TITLE_CHARS = 60;

const noopFor = (fact_id: string): RouteDecision => ({
  fact_id,
  action: "noop",
  page_id: null,
  section_title: null,
  new_page_title: null,
});

export const route = defineAgent<RouteInput, RouteOutput>({
  name: "route",
  prompt: PROMPTS.route,
  schema: SCHEMAS.route,
  maxTokens: 1500,
  checkInput(input) {
    if (input.pages.length > MAX_PAGES) throw new AgentInputError(`route takes at most ${MAX_PAGES} pages, got ${input.pages.length}`);
    if (input.facts.length > MAX_FACTS) throw new AgentInputError(`route takes at most ${MAX_FACTS} facts, got ${input.facts.length}`);
    if (new Set(input.facts.map((f) => f.id)).size !== input.facts.length) throw new AgentInputError("route fact ids must be unique");
  },
  shortCircuit: (input) => (input.facts.length ? undefined : { decisions: [] }),
  render: (input) => `${fenceJson("facts", input.facts)}\n\n${fenceJson("pages", input.pages)}`,
  postValidate(output, input, ctx) {
    // A sentence as a page title gets one retry; after that the decision becomes a noop below.
    const badTitle = output.decisions.find((d) => d.action === "new_page" && d.new_page_title && !titleOk(d.new_page_title.trim()));
    if (badTitle && !ctx.final) {
      return { ok: false, error: `new_page_title ${JSON.stringify(badTitle.new_page_title)} must be a noun phrase like "Subject — aspect", at most ${MAX_TITLE_CHARS} characters, not a sentence` };
    }
    const pages = new Map(input.pages.map((p) => [p.id, p]));
    const byFact = new Map<string, RouteDecision>();
    const notes: string[] = [];
    let dropped = 0;
    const reject = (d: RouteDecision, why: string) => {
      notes.push(`${d.fact_id}: ${why} → noop`);
      dropped++;
      return noopFor(d.fact_id);
    };

    function clean(d: RouteDecision): RouteDecision {
      const page = d.page_id === null ? undefined : pages.get(d.page_id);
      const section = d.section_title?.trim() || null;
      switch (d.action) {
        case "append":
          if (!page) return reject(d, `append to unknown page "${d.page_id}"`);
          if (!section) return reject(d, "append without a section_title");
          return { ...noopFor(d.fact_id), action: "append", page_id: page.id, section_title: matchSection(page.section_titles, section) ?? section };
        case "rewrite_section": {
          if (!page) return reject(d, `rewrite_section on unknown page "${d.page_id}"`);
          const existing = section && matchSection(page.section_titles, section);
          if (!existing) return reject(d, `rewrite_section on unknown section "${d.section_title}"`);
          return { ...noopFor(d.fact_id), action: "rewrite_section", page_id: page.id, section_title: existing };
        }
        case "new_page": {
          const title = d.new_page_title?.trim();
          if (!title) return reject(d, "new_page without a new_page_title");
          if (!titleOk(title)) return reject(d, `new_page_title ${JSON.stringify(title)} is a sentence or too long`);
          return { ...noopFor(d.fact_id), action: "new_page", new_page_title: title };
        }
        default:
          return noopFor(d.fact_id);
      }
    }

    for (const d of output.decisions) {
      if (!input.facts.some((f) => f.id === d.fact_id) || byFact.has(d.fact_id)) {
        notes.push(`dropped decision for unknown or repeated fact "${d.fact_id}"`);
        dropped++;
        continue;
      }
      byFact.set(d.fact_id, clean(d));
    }

    // Exactly one decision per input fact, in input order. A fact the model skipped is a noop.
    const decisions = input.facts.map((f) => {
      const d = byFact.get(f.id);
      if (!d) notes.push(`${f.id}: no decision returned → noop`);
      return d ?? noopFor(f.id);
    });
    return { ok: true, output: { decisions }, dropped, notes };
  },
  noop: (input) => ({ decisions: input.facts.map((f) => noopFor(f.id)) }),
});

const titleOk = (title: string): boolean => title.length <= MAX_TITLE_CHARS && !/[.!?。]$/.test(title);

/** Section titles match exactly, or ignoring case and surrounding space; the page's spelling wins. */
function matchSection(titles: string[], wanted: string): string | undefined {
  const w = wanted.trim().toLowerCase();
  return titles.find((t) => t === wanted) ?? titles.find((t) => t.trim().toLowerCase() === w);
}
