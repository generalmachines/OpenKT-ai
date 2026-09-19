// Unit tests for LlmGatewayService primary → secondary fallback,
// driven by stubbing `global.fetch`.

import { ConfigService } from "@nestjs/config";
import { z } from "zod";

import { LlmGatewayService } from "@openkt/platform-llm";

type FetchMock = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatOk(text: string): Response {
  return jsonResponse({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

describe("LlmGatewayService — fallback chain", () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = jest.fn() as FetchMock;
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses MiniMax when both providers are configured and primary succeeds", async () => {
    fetchSpy.mockResolvedValueOnce(chatOk("primary ok"));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENKT_OPENAI_API_KEY: "openai-key",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result?.text).toBe("primary ok");
    expect(result?.provider).toBe("minimax");
    expect(result?.meta).toEqual({
      fallbackUsed: false,
      providerChain: ["minimax", "openai"],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://api.minimax.villamarket.ai/v1/chat/completions",
    );
  });

  it("falls back to OpenAI when MiniMax returns 502 and exhausts retries", async () => {
    // 3 retries on MiniMax all return 502. 4th call hits OpenAI (200).
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(chatOk("fallback ok"));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENKT_OPENAI_API_KEY: "openai-key",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result?.text).toBe("fallback ok");
    expect(result?.provider).toBe("openai");
    expect(result?.meta).toEqual({
      fallbackUsed: true,
      providerChain: ["minimax", "openai"],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls[3][0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("returns null when both providers fail", async () => {
    // mockImplementation factory so each call gets a fresh Response —
    // Response.text()/.json() consume the body, so a single Response
    // can't satisfy multiple fetches.
    fetchSpy.mockImplementation(async () => jsonResponse({}, 502));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENKT_OPENAI_API_KEY: "openai-key",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toBeNull();
    // 3 retries on each provider.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("does NOT fall back when MiniMax returns a non-retryable 4xx", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 400));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENKT_OPENAI_API_KEY: "openai-key",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toBeNull();
    // No retries, no fallback — caller's input is just bad.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does fall back on 429 (rate-limited counts as retryable)", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(chatOk("openai handled it"));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENKT_OPENAI_API_KEY: "openai-key",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result?.provider).toBe("openai");
    expect(result?.meta.fallbackUsed).toBe(true);
  });

  it("skips an unconfigured fallback gracefully", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({}, 502));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        // OPENAI key missing → openai provider is skipped.
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 3 retries on minimax only.
  });

  it("returns null when neither provider is configured", async () => {
    const gateway = new LlmGatewayService(makeConfig({}));

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the OPENAI_API_KEY (embedding-side) when OPENKT_OPENAI_API_KEY is unset", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 502));
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 502));
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 502));
    fetchSpy.mockResolvedValueOnce(chatOk("ok"));

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENAI_API_KEY: "embedding-side-key",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result?.provider).toBe("openai");
    const headers = fetchSpy.mock.calls[3][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer embedding-side-key");
  });

  it("disables fallback when primary === fallback", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({}, 502));
    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "k",
        OPENKT_DEFAULT_LLM_PROVIDER: "minimax",
        OPENKT_FALLBACK_LLM_PROVIDER: "minimax",
      }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // primary only, 3 retries.
  });

  describe("tryGenerateObject through the chain", () => {
    const schema = z.object({ topic: z.string(), score: z.number() });

    it("returns the parsed object from the fallback provider", async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockResolvedValueOnce(chatOk('{"topic":"tea","score":7}'));

      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_OPENAI_API_KEY: "o",
        }),
      );

      const result = await gateway.tryGenerateObject({
        messages: [{ role: "user", content: "rate" }],
        schema,
      });

      expect(result?.object).toEqual({ topic: "tea", score: 7 });
      expect(result?.provider).toBe("openai");
      expect(result?.meta).toEqual({
        fallbackUsed: true,
        providerChain: ["minimax", "openai"],
      });
    });

    it("appends the JSON nudge to the system message exactly once", async () => {
      fetchSpy.mockResolvedValueOnce(chatOk('{"topic":"x","score":1}'));

      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_OPENAI_API_KEY: "o",
        }),
      );

      await gateway.tryGenerateObject({
        messages: [
          { role: "system", content: "be precise" },
          { role: "user", content: "rate" },
        ],
        schema,
      });

      const body = JSON.parse(
        fetchSpy.mock.calls[0][1]?.body as string,
      ) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toMatch(/be precise/);
      expect(body.messages[0].content).toMatch(/single valid JSON object/);
      // Nudge appears once — not twice.
      const matches = body.messages[0].content.match(/single valid JSON object/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe("observability recorder", () => {
    it("records 'error' for primary and 'fallback_used' for the saved-by-fallback success", async () => {
      const records: Array<{ provider: string; status: string }> = [];
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({}, 502))
        .mockResolvedValueOnce(jsonResponse({}, 502))
        .mockResolvedValueOnce(jsonResponse({}, 502))
        .mockResolvedValueOnce(chatOk("ok"));

      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_OPENAI_API_KEY: "o",
        }),
        {
          record: (input) => {
            records.push({ provider: input.provider, status: input.status });
          },
        },
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result?.meta.fallbackUsed).toBe(true);
      expect(records).toEqual([
        { provider: "minimax", status: "error" },
        { provider: "openai", status: "fallback_used" },
      ]);
    });
  });
});
