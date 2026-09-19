// Routing facts to pages (Spec 02 §5 step 3): the route agent proposes where
// each fact goes; code enforces the rules. Field names are `section_title` and
// `new_page_title`, exactly as in packages/agents/schemas/route.json; absent
// and null proposal fields are treated the same.

import type { FactRef } from "./types.js";

export interface Proposal {
  fact_id: string;
  action: "append" | "rewrite_section" | "new_page" | "noop";
  page_id?: string | null;
  section_title?: string | null;
  new_page_title?: string | null;
}

export interface Route {
  fact_id: string;
  action: "append" | "rewrite_section" | "new_page";
  page_id?: string;
  section_title?: string;
  new_page_title?: string;
  redirected_from_locked?: boolean;
}

export interface GuardRoutesInput {
  facts: (FactRef & { age_days: number })[];
  proposals: Proposal[];
  pages: { id: string; sections: { title: string; locked: boolean }[] }[];
  unroutedTitles: string[];
  titleSimilarity: (a: string, b: string) => number;
}

export function guardRoutes(input: GuardRoutesInput): {
  routes: Route[];
  unrouted: { fact_id: string; reason: string }[];
} {
  const { facts, proposals, pages, unroutedTitles, titleSimilarity } = input;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const pagesById = new Map(pages.map((p) => [p.id, p]));

  const routes: Route[] = [];
  const unrouted: { fact_id: string; reason: string }[] = [];

  // new_page groups, in first-seen order.
  const newPageGroups: { title: string; factIds: string[] }[] = [];

  for (const proposal of proposals) {
    const fact = byId.get(proposal.fact_id);
    if (!fact) continue; // unknown fact_id → ignore

    if (fact.confidence < 0.4) {
      unrouted.push({ fact_id: fact.id, reason: "low_confidence" });
      continue;
    }
    if ((fact.kind === "action" || fact.kind === "question") && fact.age_days > 30) {
      unrouted.push({ fact_id: fact.id, reason: "stale" });
      continue;
    }

    if (proposal.action === "noop") {
      unrouted.push({ fact_id: fact.id, reason: "noop" });
      continue;
    }

    if (proposal.action === "new_page") {
      const title = proposal.new_page_title ?? "";
      const validTitle =
        title.length <= 60 && title.includes(" — ") && !/[.?!]$/.test(title.trim());
      if (!validTitle) {
        unrouted.push({ fact_id: fact.id, reason: "bad_title" });
        continue;
      }
      // Merge titles with similarity ≥ 0.85 into the first one seen.
      let group = newPageGroups.find((g) => titleSimilarity(title, g.title) >= 0.85);
      if (!group) {
        group = { title, factIds: [] };
        newPageGroups.push(group);
      }
      group.factIds.push(fact.id);
      continue;
    }

    // append / rewrite_section
    const page = pagesById.get(proposal.page_id ?? "");
    if (!page) {
      unrouted.push({ fact_id: fact.id, reason: "unknown_page" });
      continue;
    }

    let action = proposal.action;
    let title = proposal.section_title ?? "";
    let redirected = false;

    const target = page.sections.find((s) => s.title === title);
    if (target?.locked) {
      // Locked target → redirect to the page's `Updates` section. If `Updates`
      // is itself locked, the fact stays unrouted (Spec 02 §5).
      const updates = page.sections.find((s) => s.title === "Updates");
      if (updates?.locked) {
        unrouted.push({ fact_id: fact.id, reason: "locked" });
        continue;
      }
      action = "append";
      title = "Updates";
      redirected = true;
    } else if (!target) {
      // Unknown section on a known page → append to a new section with that title.
      action = "append";
    }

    routes.push({
      fact_id: fact.id,
      action,
      page_id: page.id,
      section_title: title,
      ...(redirected ? { redirected_from_locked: true } : {}),
    });
  }

  // new_page groups: allowed with ≥ 3 facts (or unrouted titles) or any decision.
  for (const group of newPageGroups) {
    const support =
      group.factIds.length +
      unroutedTitles.filter(
        (t) => t === group.title || titleSimilarity(t, group.title) >= 0.85,
      ).length;
    const hasDecision = group.factIds.some(
      (id) => byId.get(id)?.kind === "decision",
    );
    if (support >= 3 || hasDecision) {
      for (const id of group.factIds) {
        routes.push({ fact_id: id, action: "new_page", new_page_title: group.title });
      }
    } else {
      for (const id of group.factIds) {
        unrouted.push({ fact_id: id, reason: "waiting_for_more" });
      }
    }
  }

  return { routes, unrouted };
}
