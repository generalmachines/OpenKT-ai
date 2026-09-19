// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { Ajv, type ValidateFunction } from "ajv";
import { parseModelJson } from "./text.js";
import type { AgentResult, ChatMessage, ContentPart, LlmClient, RunOptions, Usage } from "./types.js";

export const MAX_ATTEMPTS = 2;

/** Post-validation either accepts (possibly after repairing and dropping items) or rejects. */
export type PostResult<O> =
  | { ok: true; output: O; dropped?: number; notes?: string[] }
  | { ok: false; error: string };

export interface PostContext {
  attempt: number;
  /** True on the last attempt: repair now if you can, the next stop is the no-op. */
  final: boolean;
}

export interface AgentDefinition<I, O> {
  name: string;
  /** The system prompt, verbatim from prompts/<name>.md. */
  prompt: string;
  /** The output JSON Schema, verbatim from schemas/<name>.json. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Throw AgentInputError when the caller breaks the input contract. */
  checkInput?(input: I): void;
  /** Return an output to answer without calling the model (nothing to decide). */
  shortCircuit?(input: I): O | undefined;
  /** The user message: fenced data only, no instructions taken from the input. */
  render(input: I): string | ContentPart[];
  /** Deterministic checks that a schema cannot express. */
  postValidate?(output: O, input: I, ctx: PostContext): PostResult<O>;
  /** The safe result when the model fails twice. Must change nothing downstream. */
  noop(input: I): O;
}

export interface Agent<I, O> {
  readonly name: string;
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
  /** Exactly what is sent on the first attempt. */
  buildMessages(input: I): ChatMessage[];
  run(input: I, client: LlmClient, options?: RunOptions): Promise<AgentResult<O>>;
}

/** Appended to every system prompt, for runtimes that ignore response_format. */
export function outputInstruction(schema: Record<string, unknown>): string {
  return [
    "## Output",
    "",
    "Reply with one JSON object and nothing else — no prose, no code fence, no reasoning. It must validate against this JSON Schema:",
    "",
    JSON.stringify(schema),
  ].join("\n");
}

const ajv = new Ajv({ allErrors: true, strict: false });

export function defineAgent<I, O>(def: AgentDefinition<I, O>): Agent<I, O> {
  const validate: ValidateFunction = ajv.compile(def.schema);
  const system = `${def.prompt}\n\n${outputInstruction(def.schema)}`;

  const buildMessages = (input: I): ChatMessage[] => [
    { role: "system", content: system },
    { role: "user", content: def.render(input) },
  ];

  async function run(input: I, client: LlmClient, options: RunOptions = {}): Promise<AgentResult<O>> {
    const started = performance.now();
    const errors: string[] = [];
    let usage: Usage | undefined;
    const done = (
      status: "ok" | "noop",
      output: O,
      attempts: number,
      dropped = 0,
      notes: string[] = [],
    ): AgentResult<O> => ({
      output,
      status,
      attempts,
      dropped,
      notes,
      errors,
      ...(usage ? { usage } : {}),
      latency_ms: Math.round(performance.now() - started),
    });

    def.checkInput?.(input);
    const shortcut = def.shortCircuit?.(input);
    if (shortcut !== undefined) return done("ok", shortcut, 0);

    /** Parse → schema → post-validation. Returns the accepted output, or why it was rejected. */
    const check = (text: string, attempt: number): string | { output: O; dropped: number; notes: string[] } => {
      const parsed = parseModelJson(text);
      if (!parsed.ok) return parsed.error;
      if (!validate(parsed.value)) return `schema violation: ${ajv.errorsText(validate.errors, { dataVar: "output" })}`;
      const output = parsed.value as O;
      if (!def.postValidate) return { output, dropped: 0, notes: [] };
      const post = def.postValidate(output, input, { attempt, final: attempt === MAX_ATTEMPTS });
      if (!post.ok) return post.error;
      return { output: post.output, dropped: post.dropped ?? 0, notes: post.notes ?? [] };
    };

    const messages = buildMessages(input);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Transport and config errors propagate: they are the caller's to handle.
      const reply = await client.complete({
        messages,
        schema: { name: def.name, schema: def.schema },
        maxTokens: def.maxTokens,
        signal: options.signal,
      });
      usage = addUsage(usage, reply.usage);

      const checked = check(reply.text, attempt);
      if (typeof checked !== "string") return done("ok", checked.output, attempt, checked.dropped, checked.notes);

      errors.push(`attempt ${attempt}: ${checked}`);
      messages.push(
        { role: "assistant", content: reply.text.slice(0, 4000) || "(empty reply)" },
        {
          role: "user",
          content: `Your reply was rejected: ${checked}\nReply again with one corrected JSON object that validates against the schema. JSON only.`,
        },
      );
    }
    return done("noop", def.noop(input), MAX_ATTEMPTS);
  }

  return { name: def.name, prompt: def.prompt, schema: def.schema, buildMessages, run };
}

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}
