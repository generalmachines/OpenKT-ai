/**
 * E2E test for the knowledge-synthesis stage.
 *
 * This stage promotes raw memories into LLM-summarised "knowledge
 * nodes" (episodes with summary + tags + confidence). The worker pipeline
 * runs preprocess → embed → triage → episode → SYNTHESIZE → pulse →
 * briefing. The synthesize stage owns the decision tree:
 *
 *   create     — no existing knowledge node yet
 *   extend     — refresh an existing node's summary
 *   supersede  — archive old node, create new one
 *   fork       — create a sibling node for a different angle
 *   skip       — leave the knowledge layer untouched
 *
 * Postgres + RabbitMQ + MiniMax are all real in prod. For this test we
 * stub WorkerPgService (in-memory SQL dispatcher) and LlmGatewayService
 * (canned responses keyed by the new memory's content), so the entire
 * decision tree runs end-to-end inside Jest without any docker stack.
 */

import { ConfigService } from "@nestjs/config";

import { SynthesizeStageService } from "../../apps/worker/src/modules/memory-engine/services/synthesize-stage.service";
import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

const NOW = "2026-05-09T12:00:00.000Z";
const ORG_ID = "00000000-0000-0000-0000-000000000111";
const PROJECT_ID = "00000000-0000-0000-0000-000000000222";
const USER_ID = "00000000-0000-0000-0000-000000000333";

const NEW_MEMORY_ID = "00000000-0000-0000-0000-00000000aaaa";
const OLD_POSTGRES_MEMORY_ID = "00000000-0000-0000-0000-00000000bbbb";
const EXISTING_EPISODE_ID = "00000000-0000-0000-0000-00000000eeee";
const NEW_EPISODE_ID = "00000000-0000-0000-0000-00000000eee1";

interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  project_id: string;
  org_id: string | null;
  owner_user_id: string;
  archived: boolean;
  superseded_by: string | null;
  updated_at: string;
  embedding: string | null;
}

interface EpisodeRow {
  id: string;
  project_id: string;
  org_id: string | null;
  name: string;
  summary: string | null;
  tags: string[] | null;
  confidence: number | null;
  synthesized_by: string | null;
  archived_at: string | null;
  updated_at: string;
}

interface FakeState {
  memory: MemoryRow;
  tags: string[];
  related: Array<{ id: string; content: string; kind: string; created_at: string }>;
  episodes: EpisodeRow[];
  episodeMemories: Array<{ episode_id: string; memory_id: string }>;
  newEpisodeIds: string[];
}

// In-memory SQL dispatcher keyed off the substrings the
// SynthesizeStageService uses. Each handler returns a Promise<row[]>;
// `one()` just unwraps `query()[0]`. The point isn't fidelity to
// Postgres — it's that every code path the stage takes is observable
// here without spinning up a real database.
function buildPgStub(state: FakeState) {
  const exec = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();

    // Select the memory we're synthesising
    if (
      norm.startsWith("select id, content, kind, project_id, org_id, owner_user_id")
    ) {
      return params[0] === state.memory.id ? [state.memory] : [];
    }

    // Fetch tags for that memory
    if (norm.startsWith("select t.slug from memory_tags mt")) {
      return state.tags.map((slug) => ({ slug }));
    }

    // Related memories (we don't care which branch the stage takes —
    // they all reach this stub via different SQL flavours; just match
    // any select against `memories m` with a `tag` filter).
    if (
      norm.startsWith("select m.id, m.content, m.kind") &&
      norm.includes("from memories m")
    ) {
      return state.related.map((row) => ({ ...row, similarity: 0.8 }));
    }

    // Find most-recent matching episode
    if (
      norm.startsWith("select id, name, summary, tags, confidence, updated_at")
    ) {
      const active = state.episodes.filter((e) => e.archived_at === null);
      if (active.length === 0) return [];
      return [active[active.length - 1]];
    }

    // Insert a new episode → returns id
    if (norm.startsWith("insert into episodes")) {
      const id = state.newEpisodeIds.shift() ?? NEW_EPISODE_ID;
      const [
        orgId,
        projectId,
        name,
        summary,
        tags,
        confidence,
        synthesizedBy,
      ] = params as [
        string | null,
        string,
        string,
        string,
        string[],
        number,
        string,
      ];
      state.episodes.push({
        id,
        org_id: orgId,
        project_id: projectId,
        name,
        summary,
        tags,
        confidence,
        synthesized_by: synthesizedBy,
        archived_at: null,
        updated_at: NOW,
      });
      return [{ id }];
    }

    // Update an existing episode (extend) — set summary/tags/etc
    if (norm.startsWith("update episodes set summary")) {
      const [id, summary, tags, confidence, synthesizedBy] = params as [
        string,
        string,
        string[],
        number,
        string,
      ];
      const target = state.episodes.find((e) => e.id === id);
      if (target) {
        target.summary = summary;
        target.tags = tags;
        target.confidence = confidence;
        target.synthesized_by = synthesizedBy;
        target.updated_at = NOW;
      }
      return [];
    }

    // Archive an existing episode (supersede)
    if (norm.startsWith("update episodes set archived_at")) {
      const [id] = params as [string];
      const target = state.episodes.find((e) => e.id === id);
      if (target) target.archived_at = NOW;
      return [];
    }

    // Link memory ↔ episode
    if (norm.startsWith("insert into episode_memories")) {
      const [episodeId, memoryId] = params as [string, string];
      const exists = state.episodeMemories.some(
        (e) => e.episode_id === episodeId && e.memory_id === memoryId,
      );
      if (!exists) {
        state.episodeMemories.push({ episode_id: episodeId, memory_id: memoryId });
      }
      return [];
    }

    // Supersede individual raw memories
    if (norm.startsWith("update memories set superseded_by")) {
      return [];
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

function buildLlmStub(decision: {
  action: "create" | "extend" | "supersede" | "fork" | "skip";
  new_summary?: string;
  superseded_memory_ids?: string[];
  confidence?: number;
  reason?: string;
}) {
  return {
    tryGenerateObject: jest.fn().mockResolvedValue({
      object: {
        action: decision.action,
        new_summary: decision.new_summary ?? "",
        superseded_memory_ids: decision.superseded_memory_ids ?? [],
        confidence: decision.confidence ?? 0.9,
        reason: decision.reason ?? "ok",
      },
      provider: "minimax",
      model: "MiniMax-M2.5",
    }),
  };
}

function buildConfigStub(overrides: Partial<Record<string, unknown>> = {}) {
  const defaults: Record<string, unknown> = {
    OPENKT_SYNTHESIZE_ENABLED: true,
    OPENKT_SYNTHESIZE_TOP_K: 5,
    OPENKT_SYNTHESIZE_LOOKBACK_DAYS: 30,
    OPENKT_SYNTHESIZE_CONFIDENCE_THRESHOLD: 0.6,
    OPENKT_SYNTHESIZE_SUPERSEDE_THRESHOLD: 0.75,
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => defaults[key]),
  } as unknown as ConfigService;
}

function buildMessage(overrides: Partial<PipelineCommandMessage> = {}): PipelineCommandMessage {
  return {
    message_id: "msg-1",
    correlation_id: "corr-1",
    causation_id: null,
    job_type: "memory.synthesize",
    aggregate_type: "memory",
    aggregate_id: NEW_MEMORY_ID,
    project_id: PROJECT_ID,
    org_id: ORG_ID,
    user_id: USER_ID,
    version_token: NOW,
    payload: { memory_id: NEW_MEMORY_ID, project_id: PROJECT_ID },
    published_at: NOW,
    ...overrides,
  };
}

function baseMemoryRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: NEW_MEMORY_ID,
    content: "we migrated the production database to MySQL today",
    kind: "decision",
    project_id: PROJECT_ID,
    org_id: ORG_ID,
    owner_user_id: USER_ID,
    archived: false,
    superseded_by: null,
    updated_at: NOW,
    embedding: null,
    ...overrides,
  };
}

function makeStage(state: FakeState, opts: {
  llm: ReturnType<typeof buildLlmStub>;
  config?: ConfigService;
}) {
  const pgStub = buildPgStub(state);
  const llmConfigResolver = { resolve: jest.fn().mockResolvedValue(null) } as never;
  const memMachine = { isEnabled: () => false, namespace: jest.fn(), findCandidates: jest.fn() } as never;
  const service = new SynthesizeStageService(
    pgStub as never,
    opts.llm as never,
    llmConfigResolver,
    memMachine,
    opts.config ?? buildConfigStub(),
  );
  return { service, pg: pgStub };
}

describe("knowledge synthesis stage (e2e)", () => {
  // 1. First memory on a topic → create
  it("creates a fresh knowledge node when no existing episode matches", async () => {
    const state: FakeState = {
      memory: baseMemoryRow(),
      tags: ["database"],
      related: [],
      episodes: [],
      episodeMemories: [],
      newEpisodeIds: [NEW_EPISODE_ID],
    };
    const llm = buildLlmStub({
      action: "create",
      new_summary: "DB choice: project standardised on MySQL.",
      confidence: 0.9,
    });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      action: "create",
      episode_id: NEW_EPISODE_ID,
      downgraded: false,
    });
    expect(state.episodes).toHaveLength(1);
    expect(state.episodes[0]).toMatchObject({
      id: NEW_EPISODE_ID,
      summary: "DB choice: project standardised on MySQL.",
      tags: ["database"],
      archived_at: null,
    });
    expect(state.episodeMemories).toEqual([
      { episode_id: NEW_EPISODE_ID, memory_id: NEW_MEMORY_ID },
    ]);
  });

  // 2. Second related memory, no contradiction → extend
  it("extends an existing episode when LLM picks `extend`", async () => {
    const state: FakeState = {
      memory: baseMemoryRow({
        content: "MySQL 8 performance tuning notes — innodb_buffer_pool set to 8G",
      }),
      tags: ["database"],
      related: [
        {
          id: OLD_POSTGRES_MEMORY_ID,
          content: "DB choice: project standardised on MySQL",
          kind: "decision",
          created_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      episodes: [
        {
          id: EXISTING_EPISODE_ID,
          project_id: PROJECT_ID,
          org_id: ORG_ID,
          name: "DB choice",
          summary: "DB choice: project standardised on MySQL.",
          tags: ["database"],
          confidence: 0.9,
          synthesized_by: "minimax:MiniMax-M2.5",
          archived_at: null,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      episodeMemories: [
        { episode_id: EXISTING_EPISODE_ID, memory_id: OLD_POSTGRES_MEMORY_ID },
      ],
      newEpisodeIds: [],
    };
    const llm = buildLlmStub({
      action: "extend",
      new_summary:
        "DB choice: project standardised on MySQL; tuning notes accumulating.",
      confidence: 0.85,
    });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      action: "extend",
      episode_id: EXISTING_EPISODE_ID,
    });
    expect(state.episodes).toHaveLength(1);
    expect(state.episodes[0].summary).toContain("tuning notes");
    expect(state.episodeMemories).toEqual(
      expect.arrayContaining([
        { episode_id: EXISTING_EPISODE_ID, memory_id: OLD_POSTGRES_MEMORY_ID },
        { episode_id: EXISTING_EPISODE_ID, memory_id: NEW_MEMORY_ID },
      ]),
    );
  });

  // 3. Contradicting memory → supersede
  it("supersedes an existing episode and links the prior raw memory", async () => {
    const state: FakeState = {
      memory: baseMemoryRow({
        content: "Actually, rolling back to Postgres — MySQL ops cost too high",
      }),
      tags: ["database"],
      related: [
        {
          id: OLD_POSTGRES_MEMORY_ID,
          content: "DB choice: project standardised on MySQL",
          kind: "decision",
          created_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      episodes: [
        {
          id: EXISTING_EPISODE_ID,
          project_id: PROJECT_ID,
          org_id: ORG_ID,
          name: "DB choice",
          summary: "DB choice: project standardised on MySQL.",
          tags: ["database"],
          confidence: 0.9,
          synthesized_by: "minimax:MiniMax-M2.5",
          archived_at: null,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      episodeMemories: [
        { episode_id: EXISTING_EPISODE_ID, memory_id: OLD_POSTGRES_MEMORY_ID },
      ],
      newEpisodeIds: [NEW_EPISODE_ID],
    };
    const llm = buildLlmStub({
      action: "supersede",
      new_summary:
        "DB journey: started Postgres → migrated to MySQL → rolled back to Postgres (current).",
      superseded_memory_ids: [OLD_POSTGRES_MEMORY_ID],
      confidence: 0.9,
    });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      action: "supersede",
      episode_id: NEW_EPISODE_ID,
      previous_episode_id: EXISTING_EPISODE_ID,
      superseded_memory_ids: [OLD_POSTGRES_MEMORY_ID],
    });

    const oldEpisode = state.episodes.find((e) => e.id === EXISTING_EPISODE_ID);
    const newEpisode = state.episodes.find((e) => e.id === NEW_EPISODE_ID);
    expect(oldEpisode?.archived_at).toBe(NOW);
    expect(newEpisode?.archived_at).toBeNull();
    expect(newEpisode?.summary).toMatch(/rolled back to Postgres/);
    expect(state.episodeMemories).toContainEqual({
      episode_id: NEW_EPISODE_ID,
      memory_id: NEW_MEMORY_ID,
    });
  });

  // 4. Same-topic different angle → fork
  it("forks a sibling episode without archiving the existing one", async () => {
    const state: FakeState = {
      memory: baseMemoryRow({
        content:
          "DB performance: write throughput peaks at 12k tx/s with batch=200",
      }),
      tags: ["database"],
      related: [],
      episodes: [
        {
          id: EXISTING_EPISODE_ID,
          project_id: PROJECT_ID,
          org_id: ORG_ID,
          name: "DB choice",
          summary: "DB choice: project standardised on MySQL.",
          tags: ["database"],
          confidence: 0.9,
          synthesized_by: "minimax:MiniMax-M2.5",
          archived_at: null,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      episodeMemories: [],
      newEpisodeIds: [NEW_EPISODE_ID],
    };
    const llm = buildLlmStub({
      action: "fork",
      new_summary: "DB performance: 12k tx/s write peak with batch=200.",
      confidence: 0.8,
    });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      action: "fork",
      episode_id: NEW_EPISODE_ID,
      previous_episode_id: EXISTING_EPISODE_ID,
    });
    expect(state.episodes).toHaveLength(2);
    // Existing episode survives untouched
    expect(state.episodes.find((e) => e.id === EXISTING_EPISODE_ID)?.archived_at).toBeNull();
    // Fork has a different summary, same project + tags
    expect(state.episodes.find((e) => e.id === NEW_EPISODE_ID)).toMatchObject({
      summary: "DB performance: 12k tx/s write peak with batch=200.",
      project_id: PROJECT_ID,
    });
  });

  // 5. Weak signal → skip
  it("does not touch the knowledge layer when the LLM picks `skip`", async () => {
    const state: FakeState = {
      memory: baseMemoryRow({ content: "ran the test suite, all green" }),
      tags: ["database"],
      related: [],
      episodes: [],
      episodeMemories: [],
      newEpisodeIds: [],
    };
    const llm = buildLlmStub({ action: "skip", confidence: 0.95 });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({ action: "skip", downgraded: false });
    expect(state.episodes).toHaveLength(0);
    expect(state.episodeMemories).toHaveLength(0);
  });

  // 6. Confidence below threshold → skip (regardless of stated action)
  it("downgrades to skip when confidence is below the global threshold", async () => {
    const state: FakeState = {
      memory: baseMemoryRow(),
      tags: ["database"],
      related: [],
      episodes: [],
      episodeMemories: [],
      newEpisodeIds: [],
    };
    // Says "create" but confidence < 0.6 floor → must downgrade.
    const llm = buildLlmStub({
      action: "create",
      new_summary: "weak signal",
      confidence: 0.4,
    });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      action: "skip",
      requested_action: "create",
      downgraded: true,
    });
    expect(state.episodes).toHaveLength(0);
  });

  // 6b. supersede needs to clear the higher (0.75) bar
  it("downgrades supersede→skip when confidence is below the supersede floor", async () => {
    const state: FakeState = {
      memory: baseMemoryRow({ content: "switching back to Postgres" }),
      tags: ["database"],
      related: [],
      episodes: [
        {
          id: EXISTING_EPISODE_ID,
          project_id: PROJECT_ID,
          org_id: ORG_ID,
          name: "DB choice",
          summary: "DB choice: project standardised on MySQL.",
          tags: ["database"],
          confidence: 0.9,
          synthesized_by: "minimax:MiniMax-M2.5",
          archived_at: null,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      episodeMemories: [],
      newEpisodeIds: [],
    };
    // Above the global 0.6 floor but below the 0.75 supersede floor.
    const llm = buildLlmStub({
      action: "supersede",
      new_summary: "rolled back to Postgres",
      confidence: 0.7,
      superseded_memory_ids: [OLD_POSTGRES_MEMORY_ID],
    });
    const { service } = makeStage(state, { llm });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      action: "skip",
      requested_action: "supersede",
      downgraded: true,
    });
    // The existing episode is preserved (not archived).
    expect(state.episodes.find((e) => e.id === EXISTING_EPISODE_ID)?.archived_at).toBeNull();
  });

  // 7. Kill switch — stage runs but does literally nothing
  it("is a no-op when OPENKT_SYNTHESIZE_ENABLED=false", async () => {
    const state: FakeState = {
      memory: baseMemoryRow(),
      tags: ["database"],
      related: [],
      episodes: [],
      episodeMemories: [],
      newEpisodeIds: [],
    };
    const llm = buildLlmStub({ action: "create", confidence: 0.9 });
    const { service, pg } = makeStage(state, {
      llm,
      config: buildConfigStub({ OPENKT_SYNTHESIZE_ENABLED: false }),
    });

    const result = await service.execute(buildMessage());

    expect(result.result).toMatchObject({
      skipped: true,
      reason: "synthesize disabled",
    });
    // The stage must not have touched the DB or the LLM.
    expect(pg.query).not.toHaveBeenCalled();
    expect(pg.one).not.toHaveBeenCalled();
    expect(llm.tryGenerateObject).not.toHaveBeenCalled();
    expect(state.episodes).toHaveLength(0);
  });
});
