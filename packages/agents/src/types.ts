// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0

export const KINDS = ["decision", "fact", "how-to", "question", "action", "idea", "issue"] as const;
export type Kind = (typeof KINDS)[number];

/** One turn of a conversation or one segment of a transcript. */
export interface Turn {
  role: string;
  speaker?: string;
  text: string;
}

/** A session chunk is either structured turns or plain transcript text. */
export type SessionChunk = Turn[] | string;

export interface SessionMeta {
  /** ISO date (or datetime) of the session; relative dates are resolved against it. */
  date?: string;
  title?: string;
  /** Connector the session came from: "claude-code", "meeting", "voice-note", … */
  source?: string;
  /** The person who owns the session; "I" in a user turn means them. */
  author?: string;
  participants?: string[];
  space?: string;
}

// ── LLM client ───────────────────────────────────────────────────────────────

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LlmRequest {
  messages: ChatMessage[];
  /** Name + JSON Schema the reply must satisfy; sent as response_format where supported. */
  schema: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  /** Raw assistant text. May still contain <think> blocks or code fences. */
  text: string;
  usage?: Usage;
}

/** The only thing an agent needs from a runtime. Throw for transport and config errors. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// ── Agent runs ───────────────────────────────────────────────────────────────

export interface AgentResult<O> {
  output: O;
  /** "ok": validated model output (or a deterministic short-circuit). "noop": the safe fallback. */
  status: "ok" | "noop";
  /** Model calls made: 0 (short-circuit), 1, or 2. */
  attempts: number;
  /** Items removed by deterministic post-validation (facts, ids, tags, decisions, lines). */
  dropped: number;
  /** What post-validation repaired or dropped, in words. */
  notes: string[];
  /** Why each failed attempt failed. */
  errors: string[];
  usage?: Usage;
  latency_ms: number;
}

export interface RunOptions {
  signal?: AbortSignal;
}
