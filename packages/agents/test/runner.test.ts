// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { LlmTransportError, defineAgent, dedupe, extract, parseModelJson, stripThink, summarise } from "../src/index.js";
import { ScriptedClient, textOf } from "./helpers.js";

const dedupeInput = {
  fact: { statement: "Access tokens last 1 hour." },
  neighbours: [{ id: "f_1", statement: "Access tokens expire after one hour.", created_at: "2026-08-02" }],
};

describe("run loop", () => {
  it("accepts a valid first reply in one attempt", async () => {
    const client = new ScriptedClient({ duplicate_of: "f_1", supersedes: [] });
    const result = await dedupe.run(dedupeInput, client);
    expect(result).toMatchObject({ status: "ok", attempts: 1, dropped: 0, errors: [], output: { duplicate_of: "f_1", supersedes: [] } });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  });

  it("retries once with the validation error appended, then succeeds", async () => {
    const client = new ScriptedClient({ duplicate_of: 42 }, { duplicate_of: null, supersedes: [] });
    const result = await dedupe.run(dedupeInput, client);
    expect(result).toMatchObject({ status: "ok", attempts: 2 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/schema violation/);
    expect(result.usage?.total_tokens).toBe(220);

    const retry = client.requests[1]!.messages;
    expect(retry.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(textOf(retry[2])).toBe('{"duplicate_of":42}');
    expect(textOf(retry[3])).toMatch(/rejected: schema violation: .*supersedes/);
  });

  it("returns the typed safe no-op after two bad replies and never throws for model misbehaviour", async () => {
    const client = new ScriptedClient("I cannot help with that.", '{"duplicate_of": "f_1", "supersedes": "none"}');
    const result = await dedupe.run(dedupeInput, client);
    expect(result).toMatchObject({ status: "noop", attempts: 2, dropped: 0, output: { duplicate_of: null, supersedes: [] } });
    expect(result.errors[0]).toMatch(/not valid JSON/);
    expect(result.errors[1]).toMatch(/schema violation/);
    expect(client.requests).toHaveLength(2);
  });

  it("treats an empty reply as a failed attempt", async () => {
    const result = await dedupe.run(dedupeInput, new ScriptedClient("", "<think>still thinking"));
    expect(result.status).toBe("noop");
    expect(result.errors).toEqual(["attempt 1: empty reply", "attempt 2: empty reply"]);
  });

  it("lets transport errors through", async () => {
    const client = new ScriptedClient(new LlmTransportError("connection refused"));
    await expect(dedupe.run(dedupeInput, client)).rejects.toBeInstanceOf(LlmTransportError);
  });

  it("sends the schema both as response_format material and in the prompt text", async () => {
    const client = new ScriptedClient({ duplicate_of: null, supersedes: [] });
    await dedupe.run(dedupeInput, client);
    const request = client.requests[0]!;
    expect(request.schema).toEqual({ name: "dedupe", schema: dedupe.schema });
    expect(textOf(request.messages[0])).toContain(JSON.stringify(dedupe.schema));
    expect(textOf(request.messages[0]).startsWith(dedupe.prompt)).toBe(true);
  });

  it("answers without a model call when there is nothing to decide", async () => {
    const client = new ScriptedClient();
    expect(await dedupe.run({ ...dedupeInput, neighbours: [] }, client)).toMatchObject({ status: "ok", attempts: 0 });
    expect(await extract.run({ chunk: "  \n", session: {} }, client)).toMatchObject({ status: "ok", attempts: 0, output: { facts: [] } });
    expect(await summarise.run({ chunk: [], session: {} }, client)).toMatchObject({ attempts: 0 });
    expect(client.requests).toHaveLength(0);
  });

  it("supports new agents through defineAgent", async () => {
    const yesNo = defineAgent<{ question: string }, { answer: boolean }>({
      name: "yes_no",
      prompt: "Answer the question in the data block.",
      schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "boolean" } } },
      render: (input) => input.question,
      noop: () => ({ answer: false }),
    });
    expect((await yesNo.run({ question: "?" }, new ScriptedClient({ answer: true }))).output).toEqual({ answer: true });
    expect((await yesNo.run({ question: "?" }, new ScriptedClient({ answer: "yes" }, { answer: 1 }))).status).toBe("noop");
  });
});

describe("think-tag stripping", () => {
  it("strips closed, unclosed and closing-only think blocks", () => {
    expect(stripThink('<think>\nhmm {"a":1}\n</think>\n{"b":2}')).toBe('{"b":2}');
    expect(stripThink('reasoning without an opening tag</think>{"b":2}')).toBe('{"b":2}');
    expect(stripThink('{"b":2}<think>trailing, never closed')).toBe('{"b":2}');
    expect(stripThink("<THINK>x</THINK><think>y</think> ok")).toBe("ok");
  });

  it("parses JSON out of think blocks, code fences and stray prose", () => {
    expect(parseModelJson('<think>{"decoy":true}</think>```json\n{"b":2}\n```')).toEqual({ ok: true, value: { b: 2 } });
    expect(parseModelJson('Here you go: {"b":2} Hope that helps!')).toEqual({ ok: true, value: { b: 2 } });
    expect(parseModelJson("<think>only thoughts</think>")).toEqual({ ok: false, error: "empty reply" });
  });

  it("an agent run ignores JSON that appears only inside a think block", async () => {
    const reply = '<think>Maybe {"duplicate_of":"f_999","supersedes":[]}?</think>\n{"duplicate_of":"f_1","supersedes":[]}';
    const result = await dedupe.run(dedupeInput, new ScriptedClient(reply));
    expect(result).toMatchObject({ status: "ok", attempts: 1, output: { duplicate_of: "f_1" } });
  });
});
