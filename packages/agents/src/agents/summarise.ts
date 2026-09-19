// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { chunkText, fence, renderChunk, renderMeta, words } from "../text.js";
import type { SessionChunk, SessionMeta } from "../types.js";

export interface SummariseInput {
  chunk: SessionChunk;
  session: SessionMeta;
}
export interface SummariseOutput {
  title: string;
  summary: string;
  open_questions: string[];
}

export const MAX_TITLE_WORDS = 8;
export const MAX_SUMMARY_WORDS = 80;

const EMPTY: SummariseOutput = { title: "", summary: "", open_questions: [] };

export const summarise = defineAgent<SummariseInput, SummariseOutput>({
  name: "summarise",
  prompt: PROMPTS.summarise,
  schema: SCHEMAS.summarise,
  maxTokens: 600,
  shortCircuit: (input) => (chunkText(input.chunk).trim() ? undefined : { ...EMPTY }),
  render: (input) => `${renderMeta(input.session)}\n\n${fence("session", renderChunk(input.chunk))}`,
  postValidate(output, _input, ctx) {
    const notes: string[] = [];
    let title = output.title.trim().replace(/^["'“‘]+|["'”’.]+$/g, "");
    if (words(title).length > MAX_TITLE_WORDS) {
      title = words(title).slice(0, MAX_TITLE_WORDS).join(" ");
      notes.push(`title cut to ${MAX_TITLE_WORDS} words`);
    }
    let summary = output.summary.trim();
    const count = words(summary).length;
    if (count > MAX_SUMMARY_WORDS) {
      if (!ctx.final) return { ok: false, error: `summary is ${count} words; the limit is ${MAX_SUMMARY_WORDS}` };
      summary = cutToWords(summary, MAX_SUMMARY_WORDS);
      notes.push(`summary cut to ${MAX_SUMMARY_WORDS} words`);
    }
    if (!title || !summary) return { ok: false, error: "title and summary must not be blank" };
    const open_questions = [...new Set(output.open_questions.map((q) => q.trim()).filter(Boolean))];
    return { ok: true, output: { title, summary, open_questions }, dropped: output.open_questions.length - open_questions.length, notes };
  },
  noop: () => ({ ...EMPTY }),
});

/** Cuts at the word limit, then back to the last sentence end if one is reasonably close. */
function cutToWords(text: string, limit: number): string {
  const cut = words(text).slice(0, limit).join(" ");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("। "));
  return end > cut.length * 0.6 ? cut.slice(0, end + 1) : `${cut}…`;
}
