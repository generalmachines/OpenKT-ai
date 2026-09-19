import { LlmKeyCipher } from "../../libs/platform/llm/src/llm-key-cipher";
import { WorkerLlmConfigResolverService } from "../../apps/worker/src/modules/memory-engine/services/worker-llm-config-resolver.service";
import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

const MESSAGE: PipelineCommandMessage = {
  message_id: "00000000-0000-0000-0000-000000000001",
  correlation_id: "00000000-0000-0000-0000-000000000001",
  causation_id: null,
  job_type: "project.briefing",
  aggregate_type: "project",
  aggregate_id: "00000000-0000-0000-0000-000000000010",
  project_id: "00000000-0000-0000-0000-000000000010",
  org_id: "00000000-0000-0000-0000-000000000020",
  user_id: "00000000-0000-0000-0000-000000000030",
  version_token: "2026-05-08T00:00:00.000Z",
  payload: {},
  published_at: "2026-05-08T00:00:00.000Z",
};

describe("WorkerLlmConfigResolverService", () => {
  const originalSecret = process.env.LLM_CONFIG_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.LLM_CONFIG_ENCRYPTION_KEY = "worker-secret-with-at-least-16-chars";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.LLM_CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.LLM_CONFIG_ENCRYPTION_KEY = originalSecret;
    }
  });

  it("prefers project config and decrypts the provider key", async () => {
    const db = {
      one: jest.fn().mockResolvedValueOnce({
        provider: "minimax",
        base_url: "https://api.minimax.io/v1",
        model: "MiniMax-M2.7",
        api_key_ciphertext: LlmKeyCipher.encrypt("project-secret"),
      }),
    };
    const resolver = new WorkerLlmConfigResolverService(db as never);

    await expect(resolver.resolve(MESSAGE)).resolves.toEqual({
      provider: "minimax",
      apiKey: "project-secret",
      baseUrl: "https://api.minimax.io/v1",
      model: "MiniMax-M2.7",
    });
    expect(db.one).toHaveBeenCalledTimes(1);
  });

  it("falls through project then org then user scopes", async () => {
    const db = {
      one: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          provider: "openai",
          base_url: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          api_key_ciphertext: LlmKeyCipher.encrypt("user-secret"),
        }),
    };
    const resolver = new WorkerLlmConfigResolverService(db as never);

    await expect(resolver.resolve(MESSAGE)).resolves.toMatchObject({
      provider: "openai",
      apiKey: "user-secret",
    });
    expect(db.one).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ["project", MESSAGE.project_id],
    );
    expect(db.one).toHaveBeenNthCalledWith(2, expect.any(String), ["org", MESSAGE.org_id]);
    expect(db.one).toHaveBeenNthCalledWith(3, expect.any(String), ["user", MESSAGE.user_id]);
  });
});
