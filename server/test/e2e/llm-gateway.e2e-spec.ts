import { ConfigService } from "@nestjs/config";
import { z } from "zod";

import { LlmGatewayService } from "@openkt/platform-llm";

type FetchMock = jest.Mock<
  ReturnType<typeof fetch>,
  Parameters<typeof fetch>
>;

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("LlmGatewayService", () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = jest.fn() as FetchMock;
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("provider resolution", () => {
    it("returns null without calling fetch when OPENKT_DEFAULT_LLM_KEY is unset", async () => {
      const gateway = new LlmGatewayService(makeConfig({}));

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("defaults to minimax provider with MiniMax-M2.7 model and the MiniMax base URL", async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse("hello back"));
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "key-123" }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result).toEqual(
        expect.objectContaining({
          text: "hello back",
          provider: "minimax",
          model: "MiniMax-M2.7",
        }),
      );
      expect(result?.meta).toEqual({
        fallbackUsed: false,
        providerChain: ["minimax"],
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.minimax.io/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer key-123",
      );
      const parsed = JSON.parse(init?.body as string) as { model: string };
      expect(parsed.model).toBe("MiniMax-M2.7");
    });

    it("routes to openai when OPENKT_DEFAULT_LLM_PROVIDER=openai", async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_DEFAULT_LLM_PROVIDER: "openai",
          OPENKT_DEFAULT_LLM_BASE_URL:
            "https://llm.example.com/v1",
          OPENKT_DEFAULT_LLM_MODEL: "deepseek.v3.2",
        }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result?.provider).toBe("openai");
      expect(result?.model).toBe("deepseek.v3.2");
      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://llm.example.com/v1/chat/completions",
      );
    });

    it("routes to openrouter when OPENKT_DEFAULT_LLM_PROVIDER=openrouter", async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_DEFAULT_LLM_PROVIDER: "openrouter",
        }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result?.provider).toBe("openrouter");
      expect(result?.model).toBe("anthropic/claude-haiku-4.5");
      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
    });

    it("uses OPENKT_DEFAULT_LLM_BASE_URL override and trims trailing slashes", async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_DEFAULT_LLM_BASE_URL: "https://proxy.example.com/v1/",
        }),
      );

      await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://proxy.example.com/v1/chat/completions",
      );
    });

    it("uses OPENKT_DEFAULT_LLM_MODEL override (e.g. swap M2.7 → M2.5)", async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_DEFAULT_LLM_MODEL: "MiniMax-M2.5",
        }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result?.model).toBe("MiniMax-M2.5");
      const body = JSON.parse(
        fetchSpy.mock.calls[0][1]?.body as string,
      ) as { model: string };
      expect(body.model).toBe("MiniMax-M2.5");
    });

    it("per-call model override wins over env model", async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
      const gateway = new LlmGatewayService(
        makeConfig({
          OPENKT_DEFAULT_LLM_KEY: "k",
          OPENKT_DEFAULT_LLM_MODEL: "MiniMax-M2.5",
        }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
        model: "MiniMax-M2.7",
      });

      expect(result?.model).toBe("MiniMax-M2.7");
    });
  });

  describe("error handling", () => {
    it("returns null on non-2xx HTTP responses", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("nope", { status: 500 }),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result).toBeNull();
    });

    it("returns null when fetch throws (network/timeout)", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("boom"));
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result).toBeNull();
    });

    it("returns null when response body has no extractable text", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result).toBeNull();
    });
  });

  describe("tryGenerateObject", () => {
    const schema = z.object({ topic: z.string(), score: z.number() });

    it("parses a JSON object from the response and validates with the schema", async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse('{"topic":"tea","score":7}'),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateObject({
        messages: [{ role: "user", content: "rate" }],
        schema,
      });

      expect(result?.object).toEqual({ topic: "tea", score: 7 });
      expect(result?.provider).toBe("minimax");
      expect(result?.model).toBe("MiniMax-M2.7");
    });

    it("extracts the JSON object even when surrounded by prose/markdown", async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(
          'Here is the answer: ```json\n{"topic":"tea","score":7}\n``` — done.',
        ),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateObject({
        messages: [{ role: "user", content: "rate" }],
        schema,
      });

      expect(result?.object).toEqual({ topic: "tea", score: 7 });
    });

    it("returns null when the parsed JSON does not match the schema", async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse('{"topic":"tea","score":"not-a-number"}'),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateObject({
        messages: [{ role: "user", content: "rate" }],
        schema,
      });

      expect(result).toBeNull();
    });

    it("appends the JSON-only nudge to the first system message", async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse('{"topic":"tea","score":7}'),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      await gateway.tryGenerateObject({
        messages: [
          { role: "system", content: "You are a sommelier." },
          { role: "user", content: "rate" },
        ],
        schema,
      });

      const body = JSON.parse(
        fetchSpy.mock.calls[0][1]?.body as string,
      ) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toContain("You are a sommelier.");
      expect(body.messages[0].content).toMatch(/single valid JSON object/);
    });

    it("inserts a system nudge when none is provided", async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse('{"topic":"tea","score":7}'),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      await gateway.tryGenerateObject({
        messages: [{ role: "user", content: "rate" }],
        schema,
      });

      const body = JSON.parse(
        fetchSpy.mock.calls[0][1]?.body as string,
      ) as { messages: Array<{ role: string }> };
      expect(body.messages[0].role).toBe("system");
      expect(body.messages.length).toBe(2);
    });
  });

  describe("response shape variants", () => {
    it("extracts text when content is an array of {type,text} parts", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: "text", text: "hello " },
                    { type: "text", text: "world" },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result?.text).toBe("hello world");
    });

    it("falls back to reasoning_content when content is empty", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  reasoning_content: "thinking out loud",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const gateway = new LlmGatewayService(
        makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      );

      const result = await gateway.tryGenerateText({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result?.text).toBe("thinking out loud");
    });
  });
});
