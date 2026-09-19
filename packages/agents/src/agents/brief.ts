// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { AgentInputError } from "../errors.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { fenceJson } from "../text.js";

export interface BriefInput {
  space: string;
  pages: { title: string; summary: string; updated_at?: string }[];
  recent_changes: { date: string; page_title: string; change: string }[];
  /** Hard character budget for brief_md. Default 1500. */
  max_chars?: number;
}
export interface BriefOutput {
  brief_md: string;
}

export const DEFAULT_BRIEF_MAX_CHARS = 1500;
export const EMPTY_BRIEF = "Nothing recorded in this space yet.";

const budget = (input: BriefInput) => input.max_chars ?? DEFAULT_BRIEF_MAX_CHARS;

export const brief = defineAgent<BriefInput, BriefOutput>({
  name: "brief",
  prompt: PROMPTS.brief,
  schema: SCHEMAS.brief,
  maxTokens: 1200,
  checkInput(input) {
    if (budget(input) < 200) throw new AgentInputError("brief max_chars must be at least 200");
  },
  shortCircuit: (input) => (input.pages.length || input.recent_changes.length ? undefined : { brief_md: EMPTY_BRIEF }),
  render: (input) =>
    [
      fenceJson("context", { space: input.space, max_chars: budget(input) }),
      fenceJson("pages", input.pages),
      fenceJson("recent_changes", input.recent_changes),
    ].join("\n\n"),
  postValidate(output, input, ctx) {
    const max = budget(input);
    const brief_md = output.brief_md.trim();
    if (brief_md.length <= max) return { ok: true, output: { brief_md } };
    if (!ctx.final) return { ok: false, error: `brief_md is ${brief_md.length} characters; the hard budget is ${max}. Drop the least important bullets.` };

    // Last attempt: the budget still holds. Keep whole lines from the top; never end on a heading.
    const lines = brief_md.split("\n");
    const kept: string[] = [];
    let size = 0;
    for (const line of lines) {
      if (size + line.length + (kept.length ? 1 : 0) > max) break;
      size += line.length + (kept.length ? 1 : 0);
      kept.push(line);
    }
    while (kept.length && (!kept.at(-1)!.trim() || /^#{1,6}\s/.test(kept.at(-1)!))) kept.pop();
    if (!kept.length) return { ok: false, error: `brief_md cannot be cut to ${max} characters on a line boundary` };
    const dropped = lines.filter((l) => l.trim()).length - kept.filter((l) => l.trim()).length;
    return { ok: true, output: { brief_md: kept.join("\n") }, dropped, notes: [`cut ${dropped} line(s) to fit ${max} characters`] };
  },
  // No brief is better than a wrong one: the caller keeps the previous brief.
  noop: () => ({ brief_md: "" }),
});
