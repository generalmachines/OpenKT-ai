import {
  MemberKnowledgeStageService,
  parseRollupJson,
} from "../../apps/worker/src/modules/memory-engine/services/member-knowledge-stage.service";
import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

const MESSAGE: PipelineCommandMessage = {
  message_id: "00000000-0000-0000-0000-000000000001",
  correlation_id: "00000000-0000-0000-0000-000000000001",
  causation_id: null,
  job_type: "memory.member_knowledge",
  aggregate_type: "project",
  aggregate_id: "00000000-0000-0000-0000-0000000000cd",
  project_id: "00000000-0000-0000-0000-0000000000cd",
  org_id: "00000000-0000-0000-0000-0000000000ef",
  user_id: "00000000-0000-0000-0000-0000000000aa",
  version_token: "2026-05-12T00:00:00.000Z",
  payload: {
    project_id: "00000000-0000-0000-0000-0000000000cd",
    memory_id: "00000000-0000-0000-0000-0000000000ab",
    triggered_by_user_id: "00000000-0000-0000-0000-0000000000aa",
  },
  published_at: "2026-05-12T00:00:00.000Z",
};

describe("MemberKnowledgeStageService — contributor detection (unit)", () => {
  it("findStaleContributors passes the project_id, staleness cutoff, and limit through to the query", async () => {
    const queryRows = [
      {
        user_id: "11111111-1111-1111-1111-111111111111",
        display_name: "Maya",
        memory_count: 4,
        episode_count: 0,
        last_memory_at: "2026-05-12T08:00:00.000Z",
        last_synthesized_at: null,
      },
    ];
    const db = {
      one: jest.fn(),
      query: jest.fn().mockResolvedValue(queryRows),
    };
    const llmStub = { tryGenerateText: jest.fn() };
    const resolverStub = { resolve: jest.fn().mockResolvedValue(null) } as never;
    const service = new MemberKnowledgeStageService(
      db as never,
      llmStub as never,
      resolverStub,
    );

    const rows = await service.findStaleContributors(MESSAGE.project_id);

    expect(rows).toEqual(queryRows);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(typeof sql).toBe("string");
    expect(sql).toMatch(/from memories m/);
    expect(sql).toMatch(/left join member_knowledge mk/);
    // Stale predicate: never synthesised OR older than newest memory OR
    // older than the staleness cutoff.
    expect(sql).toMatch(/mk.last_synthesized_at is null/);
    expect(sql).toMatch(/mk.last_synthesized_at < stats.last_memory_at/);
    expect(sql).toMatch(/mk.last_synthesized_at < \$2::timestamptz/);
    // params: [projectId, cutoffIso, maxContributors]
    expect(params[0]).toBe(MESSAGE.project_id);
    expect(typeof params[1]).toBe("string");
    expect(Date.parse(params[1])).toBeLessThan(Date.now());
    expect(Number(params[2])).toBeGreaterThan(0);
  });

  it("execute() skips with 'no stale contributors' when none are returned", async () => {
    const db = {
      one: jest.fn().mockResolvedValue({
        id: MESSAGE.project_id,
        name: "Project Y",
        slug: "project-y",
        org_id: MESSAGE.org_id,
      }),
      query: jest.fn().mockResolvedValueOnce([]), // findStaleContributors
    };
    const llmStub = { tryGenerateText: jest.fn() };
    const resolverStub = { resolve: jest.fn().mockResolvedValue(null) } as never;
    const service = new MemberKnowledgeStageService(
      db as never,
      llmStub as never,
      resolverStub,
    );

    const result = await service.execute(MESSAGE);

    expect(result.eventRoutingKey).toBe("memory.member_knowledge.done");
    expect(result.result).toMatchObject({
      skipped: true,
      reason: "no stale contributors",
    });
    expect(llmStub.tryGenerateText).not.toHaveBeenCalled();
  });

  it("execute() synthesises + upserts each stale contributor", async () => {
    const contributor = {
      user_id: "11111111-1111-1111-1111-111111111111",
      display_name: "Maya",
      memory_count: 2,
      episode_count: 0,
      last_memory_at: "2026-05-12T08:00:00.000Z",
      last_synthesized_at: null,
    };
    const memories = [
      {
        id: "aaa11111-1111-1111-1111-111111111111",
        content: "Decided to move auth to RBAC v2.",
        kind: "decision",
        created_at: "2026-05-12T08:00:00.000Z",
      },
      {
        id: "aaa22222-2222-2222-2222-222222222222",
        content: "Drafted invite tokens spec.",
        kind: "note",
        created_at: "2026-05-11T10:00:00.000Z",
      },
    ];
    const db = {
      one: jest.fn().mockResolvedValue({
        id: MESSAGE.project_id,
        name: "Project Y",
        slug: "project-y",
        org_id: MESSAGE.org_id,
      }),
      query: jest
        .fn()
        // 1) findStaleContributors
        .mockResolvedValueOnce([contributor])
        // 2) fetchMemoriesForContributor
        .mockResolvedValueOnce(memories)
        // 3) upsertRollup
        .mockResolvedValueOnce([]),
    };
    const llmStub = {
      tryGenerateText: jest.fn().mockResolvedValue({
        text: JSON.stringify({
          summary: "Maya led the RBAC v2 + invites work.",
          themes: [
            { tag: "auth", weight: 0.6, memory_count: 1 },
            { tag: "invites", weight: 0.3, memory_count: 1 },
          ],
        }),
        provider: "minimax",
        model: "MiniMax-M2.7",
      }),
    } as never;
    const resolverStub = { resolve: jest.fn().mockResolvedValue(null) } as never;
    const service = new MemberKnowledgeStageService(
      db as never,
      llmStub as never,
      resolverStub,
    );

    const result = await service.execute(MESSAGE);

    expect(result.result).toMatchObject({
      generated: true,
      contributors_scanned: 1,
      contributors_synthesized: 1,
    });
    // 3rd db.query call is the upsert; assert the bound user_id + project_id.
    const [upsertSql, upsertParams] = db.query.mock.calls[2];
    expect(upsertSql).toMatch(/insert into member_knowledge/);
    expect(upsertSql).toMatch(/on conflict \(project_id, user_id\)/);
    expect(upsertParams[0]).toBe(MESSAGE.project_id);
    expect(upsertParams[2]).toBe(contributor.user_id);
    expect(upsertParams[3]).toBe("Maya led the RBAC v2 + invites work.");
  });

  it("execute() returns skipped='project not found' when the project does not exist", async () => {
    const db = {
      one: jest.fn().mockResolvedValue(null),
      query: jest.fn(),
    };
    const service = new MemberKnowledgeStageService(
      db as never,
      { tryGenerateText: jest.fn() } as never,
      { resolve: jest.fn() } as never,
    );

    const result = await service.execute(MESSAGE);

    expect(result.result).toMatchObject({
      skipped: true,
      reason: "project not found",
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("parseRollupJson", () => {
  it("returns null when no JSON object is present", () => {
    expect(parseRollupJson("not json")).toBeNull();
  });

  it("returns null when summary is missing", () => {
    expect(parseRollupJson('{"themes": []}')).toBeNull();
  });

  it("clamps weights to [0,1] and sorts themes by weight desc", () => {
    const parsed = parseRollupJson(
      JSON.stringify({
        summary: "A summary",
        themes: [
          { tag: "low", weight: 0.1, memory_count: 1 },
          { tag: "high", weight: 4.2, memory_count: 9 },
          { tag: "mid", weight: 0.5, memory_count: 3 },
        ],
      }),
    );

    expect(parsed?.summary).toBe("A summary");
    expect(parsed?.themes.map((t) => t.tag)).toEqual(["high", "mid", "low"]);
    expect(parsed?.themes[0].weight).toBe(1);
  });

  it("drops malformed theme entries", () => {
    const parsed = parseRollupJson(
      JSON.stringify({
        summary: "Hi",
        themes: [
          { tag: "good", weight: 0.5 },
          { tag: "", weight: 0.9 },
          { weight: 0.7 },
          "garbage",
        ],
      }),
    );

    expect(parsed?.themes).toHaveLength(1);
    expect(parsed?.themes[0]).toMatchObject({ tag: "good", weight: 0.5 });
  });
});
