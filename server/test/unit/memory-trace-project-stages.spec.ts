// Unit test for the trace service's new project-scoped stage support.
//
// The memory-trace.service builds its stages list from two queries:
//   1. loadJobs(memoryId)              — memory-scoped (scope: "memory")
//   2. loadProjectScopedJobs(projectId, jobs, memoryCreatedAt)
//                                       — kind in (briefing,
//                                         member_knowledge_synthesis)
//                                         and started_at inside the
//                                         memory's processing window
//                                         ±60s
//                                       — (scope: "project")
//
// We stub the entire DRIZZLE surface and the auth helper so the test
// runs in-process. The DB returns one stage per execute() call, in the
// order the service invokes them.

jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireMemoryReadAccess: jest.fn().mockResolvedValue({
      memoryId: "00000000-0000-0000-0000-0000000000ab",
      orgId: null,
      projectId: "00000000-0000-0000-0000-000000000001",
      ownerUserId: "00000000-0000-0000-0000-0000000000aa",
      visibility: "project",
      via: "owner",
    }),
  };
});

import { MemoryTraceService } from "../../apps/server/src/modules/memory/services/memory-trace.service";

const MEMORY_ID = "00000000-0000-0000-0000-0000000000ab";
const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-0000000000aa";

function buildDb(rowSets: unknown[][]) {
  let cursor = 0;
  return {
    execute: jest.fn().mockImplementation(async () => {
      const rows = rowSets[cursor] ?? [];
      cursor += 1;
      return { rows };
    }),
  };
}

function fakeContext() {
  return {
    principal: {
      type: "user",
      userId: USER_ID,
    },
  } as never;
}

describe("MemoryTraceService — project-scoped stages", () => {
  it("returns project-scoped briefing + member_knowledge stages within the memory window", async () => {
    const memoryRow = [
      {
        id: MEMORY_ID,
        kind: "decision",
        content: "we decided on something important",
        confidence: 0.9,
        created_at: "2026-05-14T10:00:00.000Z",
        owner_user_id: USER_ID,
        project_id: PROJECT_ID,
      },
    ];
    const memoryJobs = [
      {
        id: "j1",
        kind: "preprocess",
        stage: "preprocess",
        status: "done",
        started_at: "2026-05-14T10:00:01.000Z",
        completed_at: "2026-05-14T10:00:01.300Z",
        created_at: "2026-05-14T10:00:00.500Z",
        result: { ok: true },
        error: null,
      },
    ];
    const projectJobs = [
      {
        id: "j-brief",
        kind: "briefing",
        stage: "briefing",
        status: "done",
        // 5 seconds after the memory's last stage — well inside the
        // ±60s window the service uses.
        started_at: "2026-05-14T10:00:06.000Z",
        completed_at: "2026-05-14T10:00:08.000Z",
        created_at: "2026-05-14T10:00:06.000Z",
        result: { summary: "weekly briefing" },
        error: null,
      },
      {
        id: "j-mk",
        kind: "member_knowledge_synthesis",
        stage: "member_knowledge_synthesis",
        status: "done",
        started_at: "2026-05-14T10:00:10.000Z",
        completed_at: "2026-05-14T10:00:11.500Z",
        created_at: "2026-05-14T10:00:10.000Z",
        result: { facts: 3 },
        error: null,
      },
    ];

    // Order of execute() calls inside the service:
    //   1. loadMemory
    //   2. loadTagSlugs (Promise.all)
    //   3. loadJobs    (Promise.all)
    //   4. loadResultingEpisode (Promise.all)
    //   5. loadRelatedMemories (Promise.all)
    //   6. loadLlmCallsByStage (Promise.all)
    //   7. loadSemanticNeighbors (Promise.all)
    //   8. loadProjectScopedJobs (after Promise.all)
    const db = buildDb([
      memoryRow,
      [], // tags
      memoryJobs, // jobs
      [], // episode
      [], // related — empty so shared-episode helper doesn't fire
      [], // llm_calls
      [], // neighbors
      projectJobs, // project-scoped jobs
    ]);

    const svc = new MemoryTraceService(db as never);
    const result = await svc.trace(fakeContext(), MEMORY_ID);

    // Memory-scoped preprocess shows up with scope="memory"
    const preprocess = result.stages.find((s) => s.stage === "preprocess");
    expect(preprocess).toBeDefined();
    expect(preprocess!.scope).toBe("memory");

    // Project-scoped briefing + member_knowledge_synthesis are added,
    // each tagged scope="project".
    const briefing = result.stages.find((s) => s.stage === "briefing");
    expect(briefing).toBeDefined();
    expect(briefing!.scope).toBe("project");
    expect(briefing!.status).toBe("completed");
    expect(briefing!.duration_ms).toBe(2000);

    const memberKnowledge = result.stages.find(
      (s) => s.stage === "member_knowledge_synthesis",
    );
    expect(memberKnowledge).toBeDefined();
    expect(memberKnowledge!.scope).toBe("project");
    expect(memberKnowledge!.duration_ms).toBe(1500);

    // The project-scoped query is the 8th execute call.
    expect(db.execute).toHaveBeenCalledTimes(8);
  });

  it("omits project-scoped stages when none were captured", async () => {
    const memoryRow = [
      {
        id: MEMORY_ID,
        kind: "note",
        content: "trivial",
        confidence: null,
        created_at: "2026-05-14T10:00:00.000Z",
        owner_user_id: USER_ID,
        project_id: PROJECT_ID,
      },
    ];
    const memoryJobs = [
      {
        id: "j1",
        kind: "preprocess",
        stage: "preprocess",
        status: "done",
        started_at: "2026-05-14T10:00:01.000Z",
        completed_at: "2026-05-14T10:00:01.100Z",
        created_at: "2026-05-14T10:00:00.500Z",
        result: null,
        error: null,
      },
    ];
    const db = buildDb([
      memoryRow,
      [],
      memoryJobs,
      [],
      [],
      [],
      [],
      [], // no project-scoped jobs in the window
    ]);

    const svc = new MemoryTraceService(db as never);
    const result = await svc.trace(fakeContext(), MEMORY_ID);

    // Only the memory-scoped preprocess appears.
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].stage).toBe("preprocess");
    expect(result.stages[0].scope).toBe("memory");
  });
});
