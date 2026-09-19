/**
 * E2E test for the briefings-v2 worker stage.
 *
 * Stubs WorkerPgService (in-memory SQL dispatcher) and
 * LlmGatewayService (canned object response). Exercises:
 *   - UPSERT semantics: first call inserts, second call updates
 *     and bumps `version`
 *   - Stale detection: a fresh prior row (< FRESH_WINDOW_MS) skips
 *     the LLM and the upsert
 *   - Empty-memory project skips early
 *   - LLM-missing skips with a clear reason
 */

import { BriefingStageService } from "../../apps/worker/src/modules/memory-engine/services/briefing-stage.service";
import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

const NOW = new Date("2026-05-12T15:00:00.000Z");
const ORG_ID = "00000000-0000-0000-0000-000000000111";
const PROJECT_ID = "00000000-0000-0000-0000-000000000222";
const USER_ID = "00000000-0000-0000-0000-000000000333";
const MSG_ID = "11111111-1111-1111-1111-111111111111";

interface CacheRow {
  project_id: string;
  version: number;
  generated_at: string;
  stale_at: string | null;
  memory_count_at_generation: number;
  episode_count_at_generation: number;
  summary: string;
  themes: unknown;
  key_decisions: unknown;
  open_questions: unknown;
  stats: unknown;
}

interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  created_at: string;
}

interface EpisodeRow {
  id: string;
  name: string;
  summary: string | null;
  tags: string[] | null;
  confidence: number | null;
  updated_at: string;
}

interface FakeState {
  project: { id: string; name: string; slug: string; org_id: string | null } | null;
  cache: CacheRow | null;
  memories: MemoryRow[];
  episodes: EpisodeRow[];
}

function buildPgStub(state: FakeState) {
  const exec = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (norm.startsWith("select id, name, slug, org_id from projects")) {
      return state.project ? [state.project] : [];
    }

    if (norm.startsWith("select version, generated_at::text from project_briefing_cache")) {
      return state.cache
        ? [{ version: state.cache.version, generated_at: state.cache.generated_at }]
        : [];
    }

    if (
      norm.startsWith("select id, content, kind, created_at::text from memories")
    ) {
      return state.memories;
    }

    if (
      norm.startsWith(
        "select id, name, summary, tags, confidence, updated_at::text from episodes",
      )
    ) {
      return state.episodes;
    }

    if (
      norm.startsWith("select count(*)::int as n from memories")
    ) {
      return [{ n: state.memories.length }];
    }
    if (
      norm.startsWith("select count(*)::int as n from episodes")
    ) {
      return [{ n: state.episodes.length }];
    }

    if (norm.startsWith("insert into project_briefing_cache")) {
      const [
        project_id,
        memCount,
        epCount,
        summary,
        themesJson,
        decisionsJson,
        questionsJson,
        statsJson,
        staleAfterMs,
      ] = params as [string, number, number, string, string, string, string, string, number];
      const generatedAt = NOW.toISOString();
      const staleAt = new Date(NOW.getTime() + staleAfterMs).toISOString();
      if (!state.cache) {
        state.cache = {
          project_id,
          version: 1,
          generated_at: generatedAt,
          stale_at: staleAt,
          memory_count_at_generation: memCount,
          episode_count_at_generation: epCount,
          summary,
          themes: JSON.parse(themesJson),
          key_decisions: JSON.parse(decisionsJson),
          open_questions: JSON.parse(questionsJson),
          stats: JSON.parse(statsJson),
        };
        return [{ version: 1 }];
      }
      state.cache.version += 1;
      state.cache.generated_at = generatedAt;
      state.cache.stale_at = staleAt;
      state.cache.memory_count_at_generation = memCount;
      state.cache.episode_count_at_generation = epCount;
      state.cache.summary = summary;
      state.cache.themes = JSON.parse(themesJson);
      state.cache.key_decisions = JSON.parse(decisionsJson);
      state.cache.open_questions = JSON.parse(questionsJson);
      state.cache.stats = JSON.parse(statsJson);
      return [{ version: state.cache.version }];
    }

    return [];
  };

  return {
    query: jest.fn((sql: string, params: unknown[] = []) => exec(sql, params)),
    one: jest.fn(async (sql: string, params: unknown[] = []) => {
      const rows = await exec(sql, params);
      return rows[0] ?? null;
    }),
  };
}

function buildLlmStub(opts?: {
  summary?: string;
  themes?: unknown[];
  empty?: boolean;
  nullResponse?: boolean;
}) {
  return {
    tryGenerateObject: jest.fn().mockImplementation(async () => {
      if (opts?.nullResponse) return null;
      return {
        object: {
          summary: opts?.empty ? "" : opts?.summary ?? "Project is consolidating around topic X.",
          themes:
            opts?.themes ??
            [
              {
                name: "Topic X",
                description: "Recent memories converge on X",
                memory_ids: [],
                episode_ids: [],
              },
            ],
          key_decisions: [],
          open_questions: [],
        },
        provider: "minimax",
        model: "MiniMax-M2.5",
      };
    }),
    tryGenerateText: jest.fn(),
    // The stage reads breaker stats when the LLM call exhausts so it
    // can attach provider/state telemetry to the skipped-job result.
    // Tests don't care about the values — we just need the methods to
    // exist so the stage doesn't blow up before writing the placeholder
    // cache row.
    getCircuitBreaker: jest.fn().mockReturnValue({
      getState: jest.fn().mockReturnValue("closed"),
      getStats: jest.fn().mockReturnValue({ lastError: null }),
    }),
  };
}

function buildMessage(overrides: Partial<PipelineCommandMessage> = {}): PipelineCommandMessage {
  return {
    message_id: MSG_ID,
    correlation_id: "corr-1",
    causation_id: null,
    job_type: "project.briefing",
    aggregate_type: "project",
    aggregate_id: PROJECT_ID,
    project_id: PROJECT_ID,
    org_id: ORG_ID,
    user_id: USER_ID,
    version_token: NOW.toISOString(),
    payload: {},
    published_at: NOW.toISOString(),
    ...overrides,
  };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    project: { id: PROJECT_ID, name: "OpenKT", slug: "openkt", org_id: ORG_ID },
    cache: null,
    memories: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        content: "we shipped the topic-exchange RabbitMQ topology",
        kind: "decision",
        created_at: "2026-05-12T10:00:00.000Z",
      },
    ],
    episodes: [],
    ...overrides,
  };
}

function makeStage(state: FakeState, llm: ReturnType<typeof buildLlmStub>) {
  const pg = buildPgStub(state);
  const llmConfigResolver = { resolve: jest.fn().mockResolvedValue(null) } as never;
  const service = new BriefingStageService(pg as never, llm as never, llmConfigResolver);
  return { service, pg };
}

describe("briefings-v2 worker stage", () => {
  let realDateNow: () => number;

  beforeAll(() => {
    realDateNow = Date.now;
    Date.now = () => NOW.getTime();
  });

  afterAll(() => {
    Date.now = realDateNow;
  });

  it("inserts a fresh cache row on first run (version=1)", async () => {
    const state = baseState();
    const llm = buildLlmStub();
    const { service } = makeStage(state, llm);

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      generated: true,
      project_id: PROJECT_ID,
      version: 1,
    });
    expect(state.cache).not.toBeNull();
    expect(state.cache?.version).toBe(1);
    expect(state.cache?.summary).toContain("topic X");
    expect(state.cache?.stale_at).toBeTruthy();
    // stale_at must be in the future relative to generated_at
    expect(Date.parse(state.cache!.stale_at!)).toBeGreaterThan(
      Date.parse(state.cache!.generated_at),
    );
  });

  it("upserts and bumps version on a second run", async () => {
    const state = baseState({
      cache: {
        project_id: PROJECT_ID,
        // Make the prior row OLDER than FRESH_WINDOW_MS so the stage
        // doesn't debounce.
        version: 3,
        generated_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        stale_at: new Date(NOW.getTime() - 60_000).toISOString(),
        memory_count_at_generation: 5,
        episode_count_at_generation: 2,
        summary: "stale",
        themes: [],
        key_decisions: [],
        open_questions: [],
        stats: {},
      },
    });
    const llm = buildLlmStub({ summary: "fresh briefing" });
    const { service } = makeStage(state, llm);

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      generated: true,
      version: 4,
    });
    expect(state.cache?.summary).toBe("fresh briefing");
    expect(state.cache?.version).toBe(4);
  });

  it("debounces back-to-back briefings within FRESH_WINDOW_MS", async () => {
    const state = baseState({
      cache: {
        project_id: PROJECT_ID,
        version: 7,
        // Within the 5-minute freshness window.
        generated_at: new Date(NOW.getTime() - 30_000).toISOString(),
        stale_at: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(),
        memory_count_at_generation: 5,
        episode_count_at_generation: 2,
        summary: "still fresh",
        themes: [],
        key_decisions: [],
        open_questions: [],
        stats: {},
      },
    });
    const llm = buildLlmStub();
    const { service } = makeStage(state, llm);

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      skipped: true,
      reason: "briefing already fresh",
      version: 7,
    });
    expect(llm.tryGenerateObject).not.toHaveBeenCalled();
    // Row should be untouched
    expect(state.cache?.summary).toBe("still fresh");
    expect(state.cache?.version).toBe(7);
  });

  it("skips when there are no memories to brief", async () => {
    const state = baseState({ memories: [] });
    const llm = buildLlmStub();
    const { service } = makeStage(state, llm);

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      skipped: true,
      reason: "no memories to brief",
    });
    expect(llm.tryGenerateObject).not.toHaveBeenCalled();
    expect(state.cache).toBeNull();
  });

  it("skips when the LLM gateway returns null", async () => {
    const state = baseState();
    const llm = buildLlmStub({ nullResponse: true });
    const { service } = makeStage(state, llm);

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      skipped: true,
      reason: expect.stringContaining("no LLM response"),
    });
    // The stage now writes a placeholder cache row (version=0) so the
    // API never has to special-case the empty-cache state, so the
    // post-condition is the fake `INSERT ... ON CONFLICT DO NOTHING`
    // path having run — the test buildPgStub returns [] for this path
    // so state.cache stays null. We assert no real briefing landed.
    expect(state.cache).toBeNull();
  });

  it("skips when the project does not exist", async () => {
    const state = baseState({ project: null });
    const llm = buildLlmStub();
    const { service } = makeStage(state, llm);

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      skipped: true,
      reason: "project not found",
    });
    expect(llm.tryGenerateObject).not.toHaveBeenCalled();
  });
});
