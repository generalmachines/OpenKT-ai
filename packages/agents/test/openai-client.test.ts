// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmConfigError, LlmTransportError, OpenAiCompatibleClient, clientFromEnv, dedupe } from "../src/index.js";

let server: Server;
let baseUrl: string;
const seen: { url: string; headers: Record<string, unknown>; body: any }[] = [];
let respond: (body: any) => { status?: number; text: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url!, headers: req.headers, body });
      const { status = 200, text } = respond(body);
      res.writeHead(status, { "content-type": "application/json" }).end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const completion = (content: string) => ({
  text: JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
});
const input = { fact: { statement: "a" }, neighbours: [{ id: "f_1", statement: "a", created_at: "2026-01-01" }] };

describe("OpenAiCompatibleClient", () => {
  it("posts to /chat/completions with json_schema, temperature 0, the default model and thinking off", async () => {
    seen.length = 0;
    respond = () => completion('<think>hm</think>{"duplicate_of":"f_1","supersedes":[]}');
    const client = new OpenAiCompatibleClient({ baseUrl: `${baseUrl}/`, apiKey: "sk-test" });
    const result = await dedupe.run(input, client);

    expect(result).toMatchObject({ status: "ok", attempts: 1, output: { duplicate_of: "f_1" }, usage: { total_tokens: 10 } });
    const { url, headers, body } = seen[0]!;
    expect(url).toBe("/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(body).toMatchObject({
      model: "qwen3.5-4b",
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "dedupe", strict: true, schema: dedupe.schema } },
    });
    expect(body.messages[0].content.startsWith("/no_think")).toBe(false);
    expect(body.max_tokens).toBe(200);
  });

  it("makes each thinking switch and the response format optional", () => {
    const client = new OpenAiCompatibleClient({
      baseUrl, model: "gemma-4-e4b", disableThinkingKwarg: false, noThinkPrefix: true, responseFormat: "none", extraBody: { top_k: 1 },
    });
    const body = client.buildBody({ messages: dedupe.buildMessages(input), schema: { name: "dedupe", schema: dedupe.schema } }) as any;
    expect(body.model).toBe("gemma-4-e4b");
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body).not.toHaveProperty("response_format");
    expect(body.top_k).toBe(1);
    expect(body.messages[0].content.startsWith("/no_think\n# dedupe")).toBe(true);
    expect(body.messages[1].content.startsWith("/no_think")).toBe(false);
  });

  it("recovers from a runtime that ignores response_format via the retry", async () => {
    seen.length = 0;
    let n = 0;
    respond = () => completion(n++ === 0 ? "Sure! The fact is a duplicate." : '```json\n{"duplicate_of":null,"supersedes":[]}\n```');
    const result = await dedupe.run(input, new OpenAiCompatibleClient({ baseUrl }));
    expect(result).toMatchObject({ status: "ok", attempts: 2, usage: { total_tokens: 20 } });
    expect(seen[1]!.body.messages).toHaveLength(4);
  });

  it("throws LlmTransportError for HTTP errors, malformed envelopes and unreachable hosts", async () => {
    respond = () => ({ status: 500, text: '{"error":"model not loaded"}' });
    const error = await dedupe.run(input, new OpenAiCompatibleClient({ baseUrl })).catch((e) => e);
    expect(error).toBeInstanceOf(LlmTransportError);
    expect(error).toMatchObject({ status: 500, body: '{"error":"model not loaded"}' });

    respond = () => ({ text: '{"choices":[]}' });
    await expect(dedupe.run(input, new OpenAiCompatibleClient({ baseUrl }))).rejects.toBeInstanceOf(LlmTransportError);
    respond = () => ({ text: "<html>gateway</html>" });
    await expect(dedupe.run(input, new OpenAiCompatibleClient({ baseUrl }))).rejects.toBeInstanceOf(LlmTransportError);

    const dead = new OpenAiCompatibleClient({ baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 2000 });
    await expect(dedupe.run(input, dead)).rejects.toBeInstanceOf(LlmTransportError);
  });

  it("throws LlmConfigError for bad configuration", () => {
    expect(() => new OpenAiCompatibleClient({ baseUrl: "" })).toThrow(LlmConfigError);
    expect(() => new OpenAiCompatibleClient({ baseUrl: "localhost:8080" })).toThrow(LlmConfigError);
    expect(() => clientFromEnv({})).toThrow(/OPENKT_LLM_BASE_URL/);
    expect(() => clientFromEnv({ OPENKT_LLM_BASE_URL: baseUrl, OPENKT_LLM_RESPONSE_FORMAT: "xml" })).toThrow(LlmConfigError);
    const body = clientFromEnv({ OPENKT_LLM_BASE_URL: baseUrl, OPENKT_LLM_MODEL: "m", OPENKT_LLM_NO_THINK_PREFIX: "1", OPENKT_LLM_THINKING_KWARG: "0" })
      .buildBody({ messages: dedupe.buildMessages(input), schema: { name: "dedupe", schema: dedupe.schema } }) as any;
    expect(body.model).toBe("m");
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body.messages[0].content.startsWith("/no_think")).toBe(true);
  });
});
