// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "../src/index.js";

/** A fake LlmClient that answers from a script and records what it was sent. */
export class ScriptedClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly replies: unknown[];

  constructor(...replies: unknown[]) {
    this.replies = replies;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Snapshot: the runner appends to the same messages array between attempts.
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    if (!this.replies.length) throw new Error("ScriptedClient ran out of replies");
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return {
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
  }
}

export function textOf(message: ChatMessage | undefined): string {
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((p) => (p.type === "text" ? p.text : `[image ${p.image_url.url.slice(0, 30)}]`)).join("\n");
}
