import type { ActorContext } from "../../libs/core/context/src/actor-context";
import type {
  LlmConfigRecord,
  LlmConfigRepository,
  LlmConfigSecretRecord,
  LlmConfigUpsertInput,
} from "../../libs/data/repositories/src/llm-config.repository";
import { LlmKeyCipher } from "../../libs/platform/llm/src/llm-key-cipher";
import { LlmConfigsApplicationService } from "../../apps/server/src/modules/llm-configs/services/llm-configs-application.service";

const USER_ID = "00000000-0000-0000-0000-000000000001";

const context = {
  principal: {
    type: "user",
    userId: USER_ID,
    email: "user@example.com",
    displayName: "User",
    authSource: "supabase-jwt",
  },
  request: { requestId: "test", ip: null, userAgent: null },
  sb: {},
  admin: () => ({}),
} as ActorContext;

describe("LLM configs encrypted backend surface", () => {
  const originalSecret = process.env.LLM_CONFIG_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.LLM_CONFIG_ENCRYPTION_KEY = "test-secret-with-at-least-16-chars";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.LLM_CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.LLM_CONFIG_ENCRYPTION_KEY = originalSecret;
    }
    jest.restoreAllMocks();
  });

  it("encrypts API keys before saving and only returns masked metadata", async () => {
    const saved: LlmConfigSecretRecord[] = [];
    const repo = buildRepo(saved);
    const service = new LlmConfigsApplicationService(
      repo,
      { tryGenerateText: jest.fn() } as never,
      stubAuditService(),
    );

    const result = await service.upsert(context, {
      scopeType: "user",
      scopeId: USER_ID,
      provider: "minimax",
      label: "default",
      baseUrl: "https://api.minimax.villamarket.ai/v1",
      model: "MiniMax-M2.7",
      apiKey: "sk-test-secret-value",
      enabled: true,
    });

    expect(result).toMatchObject({
      provider: "minimax",
      maskedApiKey: "sk-t...alue",
    });
    expect(saved[0]!.apiKeyCiphertext).not.toContain("sk-test-secret-value");
    expect(LlmKeyCipher.decrypt(saved[0]!.apiKeyCiphertext)).toBe("sk-test-secret-value");

    const listed = await service.list(context, "user", USER_ID);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("sk-test-secret-value");
    expect(JSON.stringify(listed)).not.toContain(saved[0]!.apiKeyCiphertext);
  });

  it("decrypts the saved key only for provider test calls", async () => {
    const encrypted = LlmKeyCipher.encrypt("sk-provider-secret");
    const saved: LlmConfigSecretRecord[] = [
      {
        id: "00000000-0000-0000-0000-000000000101",
        scopeType: "user",
        scopeId: USER_ID,
        provider: "openai",
        label: "default",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        enabled: true,
        maskedApiKey: "sk-p...cret",
        apiKeyCiphertext: encrypted,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ];
    const gateway = {
      tryGenerateText: jest.fn().mockResolvedValue({
        text: "ok",
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    };
    const service = new LlmConfigsApplicationService(
      buildRepo(saved),
      gateway as never,
      stubAuditService(),
    );

    const result = await service.test(context, saved[0]!.id);

    expect(result).toEqual({ ok: true, provider: "openai", model: "gpt-4o-mini" });
    expect(gateway.tryGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfig: expect.objectContaining({
          apiKey: "sk-provider-secret",
          provider: "openai",
        }),
      }),
    );
  });
});

function stubAuditService() {
  return {
    write: jest.fn().mockResolvedValue(undefined),
    writeFromContext: jest.fn().mockResolvedValue(undefined),
  } as never;
}

function buildRepo(store: LlmConfigSecretRecord[]): LlmConfigRepository {
  return {
    async list(_context, scopeType, scopeId): Promise<LlmConfigRecord[]> {
      return store
        .filter((row) => row.scopeType === scopeType && row.scopeId === scopeId)
        .map(({ apiKeyCiphertext: _secret, ...record }) => record);
    },
    async findById(_context, id) {
      return store.find((row) => row.id === id) ?? null;
    },
    async upsert(_context, input: LlmConfigUpsertInput) {
      const row: LlmConfigSecretRecord = {
        id: "00000000-0000-0000-0000-000000000100",
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        provider: input.provider,
        label: input.label,
        baseUrl: input.baseUrl,
        model: input.model,
        enabled: input.enabled,
        maskedApiKey: input.maskedApiKey,
        apiKeyCiphertext: input.apiKeyCiphertext,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      store.splice(0, store.length, row);
      const { apiKeyCiphertext: _secret, ...record } = row;
      return record;
    },
    async setEnabled(_context, id, enabled) {
      const row = store.find((item) => item.id === id);
      if (!row) return null;
      row.enabled = enabled;
      const { apiKeyCiphertext: _secret, ...record } = row;
      return record;
    },
  };
}
