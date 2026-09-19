// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { AgentInputError } from "../errors.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { CITATION, citedIds, fence, fenceJson, normaliseForMatch } from "../text.js";

export interface WriteSectionInput {
  page_title: string;
  section_title: string;
  /** Current body of the section, without its heading. Empty for a new section. */
  section_md: string;
  /** What `route` chose. Default "append". */
  mode?: "append" | "rewrite_section";
  facts: { id: string; statement: string; author: string; date: string }[];
  /** Facts already cited in the section that this batch made outdated. */
  superseded_ids: string[];
  /** Length cap for the new body. Default 1200 (Spec 01: a section is at most 1,200 characters). */
  max_chars?: number;
}
export interface WriteSectionOutput {
  section_md: string;
}

export const DEFAULT_SECTION_MAX_CHARS = 1200;

/** The only instruction in the user message. Fixed text chosen by code, never taken from the input. */
export const INSTRUCTIONS = {
  append: "Add the facts to the section without changing existing sentences.",
  rewrite_section: "Rewrite the section so that it reads as one current account including the facts.",
} as const;

/** Prose blocks: paragraphs and list items. Headings, rules, tables and code are not prose. */
function proseBlocks(markdown: string): string[] {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)/)
    .map((b) => b.trim())
    .filter((b) => b && !/^(#{1,6}\s|[-*_]{3,}\s*$|\|)/.test(b));
}

const citesAny = (block: string, ids: Set<string>) => [...citedIds(block)].some((id) => ids.has(id));

/** Spec 02 §6: when the model fails twice, one bullet per fact. The page never stalls on a misbehaving model. */
export function deterministicAppend(input: Pick<WriteSectionInput, "section_md" | "facts">): string {
  const bullets = input.facts.map((f) => `- ${f.statement.trim()} [^f:${f.id}]`).join("\n");
  return input.section_md.trim() ? `${input.section_md.trim()}\n\n${bullets}` : bullets;
}

export const writeSection = defineAgent<WriteSectionInput, WriteSectionOutput>({
  name: "write_section",
  prompt: PROMPTS.write_section,
  schema: SCHEMAS.write_section,
  maxTokens: 1200,
  checkInput(input) {
    if (!input.facts.length) throw new AgentInputError("write_section needs at least one fact to fold in");
    const bad = input.facts.find((f) => !/^[^\]\s]+$/.test(f.id));
    if (bad) throw new AgentInputError(`fact id ${JSON.stringify(bad.id)} cannot be cited: ids must not contain spaces or "]"`);
  },
  render: (input) =>
    [
      `<instruction>\n${INSTRUCTIONS[input.mode ?? "append"]}\n</instruction>`,
      fenceJson("context", {
        page_title: input.page_title,
        section_title: input.section_title,
        max_chars: input.max_chars ?? DEFAULT_SECTION_MAX_CHARS,
      }),
      fence("section", input.section_md.trim() || "(empty — this is a new section)"),
      fenceJson("facts", input.facts),
      fenceJson("superseded_ids", input.superseded_ids),
    ].join("\n\n"),
  postValidate(output, input) {
    // Repair: the heading belongs to the page, not to the section body.
    const heading = new RegExp(`^\\s*#{1,6}\\s*${escapeRegExp(input.section_title.trim())}\\s*\\n+`, "i");
    const section_md = output.section_md.replace(heading, "").trim();
    const notes = section_md === output.section_md.trim() ? [] : ["removed the section heading from the body"];
    const fail = (error: string) => ({ ok: false as const, error });

    const max = input.max_chars ?? DEFAULT_SECTION_MAX_CHARS;
    if (section_md.length > max) return fail(`section_md is ${section_md.length} characters; the limit is ${max}`);

    const newIds = new Set(input.facts.map((f) => f.id));
    const superseded = new Set(input.superseded_ids);
    const allowed = new Set([...citedIds(input.section_md), ...newIds, ...superseded]);
    const cited = citedIds(section_md);
    const unknown = [...cited].filter((id) => !allowed.has(id));
    if (unknown.length) return fail(`cites ids that are not in the input: ${unknown.join(", ")}`);

    const missing = [...newIds].filter((id) => !cited.has(id));
    if (missing.length) return fail(`every fact must be cited as [^f:<id>]; not cited: ${missing.join(", ")}`);

    const before = proseBlocks(input.section_md);
    const after = proseBlocks(section_md);

    // Spec 02 §6: every sentence cites a fact. Text a person wrote lives in locked sections, which
    // are never given to this agent, so there is no uncited text here to keep.
    const uncited = after.find((b) => !b.match(CITATION));
    if (uncited) return fail(`every sentence needs a [^f:<id>] citation; none in: ${JSON.stringify(uncited.slice(0, 80))}`);

    // A superseded fact may appear only as "was <old>; since <date> <new>", next to the fact that replaced it.
    const stale = after.find((b) => citesAny(b, superseded) && !(/\bwas\b[\s\S]*;\s*since \d{4}-\d{2}-\d{2}\b/i.test(b) && citesAny(b, newIds)));
    if (stale) return fail(`a superseded fact may only be cited in the form "was X; since YYYY-MM-DD Y" together with the new fact; fix: ${JSON.stringify(stale.slice(0, 80))}`);

    // Append mode adds; it does not edit. Only blocks resting on a superseded fact may change, and
    // an uncited block (which may not be kept, above) may go.
    if ((input.mode ?? "append") === "append") {
      const afterText = normaliseForMatch(section_md);
      const changed = before.find((b) => b.match(CITATION) && !citesAny(b, superseded) && !afterText.includes(normaliseForMatch(b)));
      if (changed) return fail(`existing text must stay unchanged when adding; changed or removed: ${JSON.stringify(changed.slice(0, 80))}`);
    }

    return { ok: true, output: { section_md }, notes };
  },
  noop: (input) => ({ section_md: deterministicAppend(input) }),
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
