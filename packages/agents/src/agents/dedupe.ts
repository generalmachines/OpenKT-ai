// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { AgentInputError } from "../errors.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { fenceJson } from "../text.js";

export interface DedupeInput {
  fact: { statement: string; created_at?: string };
  /** The nearest existing facts, at most 10. */
  neighbours: { id: string; statement: string; created_at: string }[];
}
export interface DedupeOutput {
  duplicate_of: string | null;
  supersedes: string[];
}

export const MAX_NEIGHBOURS = 10;
/** Spec 02 §3: more supersessions than this from one fact is suspicious; all are ignored. */
export const MAX_SUPERSEDES = 3;

export const dedupe = defineAgent<DedupeInput, DedupeOutput>({
  name: "dedupe",
  prompt: PROMPTS.dedupe,
  schema: SCHEMAS.dedupe,
  maxTokens: 200,
  checkInput(input) {
    if (input.neighbours.length > MAX_NEIGHBOURS) {
      throw new AgentInputError(`dedupe takes at most ${MAX_NEIGHBOURS} neighbours, got ${input.neighbours.length}`);
    }
  },
  shortCircuit: (input) => (input.neighbours.length ? undefined : { duplicate_of: null, supersedes: [] }),
  render: (input) => `${fenceJson("new_fact", input.fact)}\n\n${fenceJson("neighbours", input.neighbours)}`,
  postValidate(output, input) {
    const known = new Set(input.neighbours.map((n) => n.id));
    const notes: string[] = [];
    let dropped = 0;

    let duplicate_of = output.duplicate_of;
    if (duplicate_of !== null && !known.has(duplicate_of)) {
      notes.push(`duplicate_of "${duplicate_of}" is not a neighbour id`);
      duplicate_of = null;
      dropped++;
    }
    // A duplicate is never stored, so it cannot supersede anything.
    const candidates = duplicate_of === null ? [...new Set(output.supersedes)] : [];
    // A fact may only supersede facts older than itself.
    const at = input.fact.created_at ? Date.parse(input.fact.created_at) : NaN;
    const older = (id: string) => Number.isNaN(at) || !(Date.parse(input.neighbours.find((n) => n.id === id)!.created_at) > at);
    let supersedes = candidates.filter((id) => known.has(id) && older(id));
    if (supersedes.length > MAX_SUPERSEDES) {
      notes.push(`suspicious_supersede: ${supersedes.length} ids, all ignored`);
      supersedes = [];
    }
    const removed = output.supersedes.length - supersedes.length;
    if (removed) notes.push(`removed ${removed} supersedes id(s): unknown, repeated, newer than the fact, alongside a duplicate, or too many`);
    return { ok: true, output: { duplicate_of, supersedes }, dropped: dropped + removed, notes };
  },
  noop: () => ({ duplicate_of: null, supersedes: [] }),
});
