/**
 * M6 "Proof test" — encodes v0.1's whole promise in one place:
 *
 *   "What one person saved reaches a teammate's AI tool over MCP
 *    alone, and a stranger cannot see it."
 *
 * DB-integration test against a real Postgres (same `describeIfDb`
 * pattern as test/e2e/audit-immutability.e2e-spec.ts — skipped when
 * DATABASE_URL isn't set, e.g. plain CI without a live Postgres).
 * Services are instantiated directly against a real Drizzle client
 * (not through Nest's DI container — the "scripted test against the
 * service layer with a test database" fallback the task spec allows),
 * so every assertion below is a REAL SQL round-trip through the exact
 * repositories/services production code paths use. Inputs go through
 * the real zod contracts (`CreateMemorySchema.parse` /
 * `RecallRequestSchema.parse`) so defaults match production exactly.
 *
 * Scenario A — cross-user recall through a grant:
 *   1. User A saves a fact in project P inside a session (source
 *      'claude-code').
 *   2. User B, granted 'reader' on P, recalls it — over a REAL MCP
 *      JSON-RPC round-trip (McpServerFactoryService + the SDK's
 *      in-memory Client/Server transport, calling the exact
 *      `kt_recall` tool a real client would) — and gets it back with
 *      A as the author.
 *   3. User C, with no grant at all, recalls the same project and
 *      gets nothing (project access denied before the query runs).
 *
 * Scenario B — personal-space privacy, including the grants nuance:
 *   4. A fact A saves in a PRIVATE session inside A's own personal
 *      space is invisible to B even when B is separately granted
 *      'reader' on A's whole personal project — visibility:'personal'
 *      is owner-only unless the SPECIFIC SESSION is granted
 *      (architecture.md §3).
 *   5. Granting B a session-level grant on that exact session makes
 *      the personal-visibility fact visible to B's recall — proving
 *      the escape hatch, not just the default-deny.
 */
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";

import * as schema from "../../apps/server/src/db/schema";
import { CreateMemorySchema, RecallRequestSchema } from "../../apps/server/src/modules/memory/contracts/memory.contract";
import { MemoryRepository } from "../../apps/server/src/modules/memory/repositories/memory.repository";
import { MemoryCommandsApplicationService } from "../../apps/server/src/modules/memory/services/memory-commands.application.service";
import { MemoryQueriesApplicationService } from "../../apps/server/src/modules/memory/services/memory-queries.application.service";
import { MemoryRecallService } from "../../apps/server/src/modules/memory/services/memory-recall.service";
import { LocalMemoryEngine } from "../../apps/server/src/modules/memory/services/local-memory-engine.service";
import { KnowledgeRepository } from "../../apps/server/src/modules/memory/repositories/knowledge.repository";
import { ProjectScopeService } from "../../apps/server/src/modules/projects/services/project-scope.service";
import { CreateSessionSchema } from "../../apps/server/src/modules/sessions/contracts/session.contract";
import { SessionRepository } from "../../apps/server/src/modules/sessions/repositories/session.repository";
import { SessionsApplicationService } from "../../apps/server/src/modules/sessions/services/sessions-application.service";
import { GrantRepository } from "../../apps/server/src/modules/grants/repositories/grant.repository";
import { GrantsApplicationService } from "../../apps/server/src/modules/grants/services/grants-application.service";
import { AccessScopeService } from "../../apps/server/src/modules/access/services/access-scope.service";
import { McpServerFactoryService } from "../../apps/server/src/modules/mcp/services/mcp-server-factory.service";
import { McpUiRendererService } from "../../apps/server/src/modules/mcp/services/mcp-ui-renderer.service";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// ── stub-only collaborators (not exercised by this scenario) ───────
const configServiceStub = { get: () => undefined } as never;
const outboxStub = { publishCreated: jest.fn().mockResolvedValue(undefined) } as never;
const auditStub = { writeFromContext: jest.fn().mockResolvedValue(undefined) } as never;
const synthesisOffStub = { tryDedup: jest.fn().mockResolvedValue(null) } as never;
const projectsAppStub = {
  listVisible: jest.fn(),
  getById: jest.fn(),
  getBySlug: jest.fn(),
  create: jest.fn(),
} as never;
const briefingStub = { getBriefing: jest.fn().mockResolvedValue(null) } as never;
const personalTokensStub = {
  create: jest.fn(),
  list: jest.fn(),
  revoke: jest.fn(),
  verify: jest.fn(),
} as never;

function actorContextFor(userId: string): ActorContext {
  return {
    principal: {
      type: "user",
      userId,
      email: `${userId}@test.local`,
      displayName: null,
      authSource: "supabase-jwt",
      tokenId: null,
      serviceName: null,
    },
    request: {
      requestId: "proof-test",
      ip: "127.0.0.1",
      userAgent: "jest",
      referer: null,
      origin: null,
      sessionId: null,
      surface: "mcp",
      actorKind: "agent",
    },
    // Every code path exercised here resolves access via the local-pg
    // pool inside @openkt/auth-authorization (DATABASE_URL is set), so
    // `sb`/`admin` are never actually invoked. Throwing stubs make
    // that assumption loud if it's ever wrong.
    sb: new Proxy(
      {},
      {
        get() {
          throw new Error("unexpected Supabase client access in DB-integration proof test");
        },
      },
    ) as ActorContext["sb"],
    admin: () => {
      throw new Error("unexpected Supabase admin client access in DB-integration proof test");
    },
  };
}

describeIfDb("Proof: OpenKT v0.1 context-cloud promise (DB integration)", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let memoryRepository: MemoryRepository;
  let sessionRepository: SessionRepository;
  let grantRepository: GrantRepository;
  let projectScopeService: ProjectScopeService;
  let accessScopeService: AccessScopeService;
  let memoryEngine: LocalMemoryEngine;
  let memoryCommands: MemoryCommandsApplicationService;
  let memoryRecall: MemoryRecallService;
  let sessionsApp: SessionsApplicationService;
  let grantsApp: GrantsApplicationService;
  let mcpFactory: McpServerFactoryService;

  const userA = randomUUID();
  const userB = randomUUID();
  const userC = randomUUID();
  let projectP: string;
  let personalProjectA: string;

  const createdMemoryIds: string[] = [];
  const createdSessionIds: string[] = [];
  const createdProjectIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool, { schema });

    memoryRepository = new MemoryRepository(db as never);
    sessionRepository = new SessionRepository(db as never);
    grantRepository = new GrantRepository(db as never);
    projectScopeService = new ProjectScopeService(db as never);
    accessScopeService = new AccessScopeService(db as never);
    memoryEngine = new LocalMemoryEngine(db as never, configServiceStub);
    const knowledgeRepository = new KnowledgeRepository(db as never);

    memoryCommands = new MemoryCommandsApplicationService(
      memoryRepository,
      projectScopeService,
      outboxStub,
      memoryEngine,
      auditStub,
      synthesisOffStub,
      sessionRepository,
    );
    const memoryQueries = new MemoryQueriesApplicationService(
      memoryRepository,
      projectScopeService,
      memoryEngine,
      accessScopeService,
    );
    memoryRecall = new MemoryRecallService(
      memoryEngine,
      projectScopeService,
      knowledgeRepository,
      memoryRepository,
      sessionRepository,
      accessScopeService,
    );
    sessionsApp = new SessionsApplicationService(
      sessionRepository,
      projectScopeService,
      memoryRepository,
      grantRepository,
    );
    grantsApp = new GrantsApplicationService(grantRepository);
    mcpFactory = new McpServerFactoryService(
      memoryCommands,
      memoryQueries,
      memoryRecall,
      projectsAppStub,
      projectScopeService,
      briefingStub,
      new McpUiRendererService(),
      sessionsApp,
      personalTokensStub,
    );

    // Fixture profiles — memories.owner_user_id FKs to profiles.
    await db.insert(schema.profiles).values([
      { userId: userA, email: `${userA}@test.local`, displayName: "User A" },
      { userId: userB, email: `${userB}@test.local`, displayName: "User B" },
    ]);

    // Project P — A owns it, no org (grants are the only path in for
    // anyone else, exactly what M4 is proving).
    const [p] = await db
      .insert(schema.projects)
      .values({ slug: `proof-p-${randomUUID()}`, name: "Proof project", visibility: "org", ownerUserId: userA })
      .returning({ id: schema.projects.id });
    projectP = p.id;
    createdProjectIds.push(projectP);
  });

  afterAll(async () => {
    for (const id of createdMemoryIds) {
      await db.delete(schema.memories).where(eq(schema.memories.id, id)).catch(() => undefined);
    }
    for (const id of createdSessionIds) {
      await db
        .delete(schema.sessionTurns)
        .where(eq(schema.sessionTurns.sessionId, id))
        .catch(() => undefined);
      await db.delete(schema.sessions).where(eq(schema.sessions.id, id)).catch(() => undefined);
    }
    await db.delete(schema.grants).where(eq(schema.grants.resourceId, projectP)).catch(() => undefined);
    if (personalProjectA) {
      await db
        .delete(schema.grants)
        .where(eq(schema.grants.resourceId, personalProjectA))
        .catch(() => undefined);
    }
    for (const id of createdProjectIds) {
      await db.delete(schema.projects).where(eq(schema.projects.id, id)).catch(() => undefined);
    }
    await db.delete(schema.profiles).where(eq(schema.profiles.userId, userA)).catch(() => undefined);
    await db.delete(schema.profiles).where(eq(schema.profiles.userId, userB)).catch(() => undefined);
    await pool.end();
  });

  it("A saves a fact in a session inside project P", async () => {
    const contextA = actorContextFor(userA);
    const session = await sessionsApp.start(
      contextA,
      CreateSessionSchema.parse({
        project_id: projectP,
        source: "claude-code",
        client: "claude-code/proof",
        title: "proof session",
      }),
    );
    createdSessionIds.push(session.id);
    expect(session.status).toBe("open");
    expect(session.project_id).toBe(projectP);

    const created = await memoryCommands.create(
      contextA,
      CreateMemorySchema.parse({
        content: "Staging Redis runs on port 7001, not the default 6379.",
        kind: "fact",
        project_id: projectP,
        visibility: "project",
        session_id: session.id,
      }),
    );
    if ("id" in created) createdMemoryIds.push(created.id);
    if (!("id" in created)) throw new Error("expected a MemoryRecord, got a gate suggestion");
    expect(created.session_id).toBe(session.id);
    expect(created.source).toBe("claude-code");
    expect(created.owner.user_id).toBe(userA);
  });

  it("B, granted reader on P, recalls A's fact via the MCP tool path and sees A as author", async () => {
    await grantsApp.put(actorContextFor(userA), "project", projectP, userB, "reader");

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const contextB = actorContextFor(userB);
    const server = await mcpFactory.build(contextB);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "proof-client", version: "0.0.1" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "kt_recall",
        arguments: { project_id: projectP, query: "Redis port" },
      });
      const textBlock = (result.content as Array<{ type: string; text?: string }>).find(
        (block) => block.type === "text",
      );
      expect(textBlock).toBeDefined();
      const payload = JSON.parse(textBlock!.text!) as {
        data: Array<{ content: string; owner: { user_id: string } }>;
      };
      expect(payload.data.length).toBeGreaterThan(0);
      const hit = payload.data.find((row) => row.content.includes("Redis"));
      expect(hit).toBeDefined();
      expect(hit!.owner.user_id).toBe(userA);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("C, with no grant at all, gets nothing recalling the same project", async () => {
    const contextC = actorContextFor(userC);
    await expect(
      memoryRecall.recall(
        contextC,
        RecallRequestSchema.parse({ project_id: projectP, query: "Redis port" }),
      ),
    ).rejects.toThrow();
  });

  it("a fact saved by A in a private session in A's personal space is invisible to B", async () => {
    const contextA = actorContextFor(userA);
    personalProjectA = await projectScopeService.resolvePersonalProjectId(contextA);

    const privateSession = await sessionsApp.start(
      contextA,
      CreateSessionSchema.parse({ source: "note", title: "private thoughts" }),
    );
    createdSessionIds.push(privateSession.id);
    expect(privateSession.project_id).toBe(personalProjectA);

    const privateMemory = await memoryCommands.create(
      contextA,
      CreateMemorySchema.parse({
        content: "Personal note: asking for a 185k salary in the next negotiation.",
        kind: "note",
        project_id: personalProjectA,
        visibility: "personal",
        session_id: privateSession.id,
      }),
    );
    if ("id" in privateMemory) createdMemoryIds.push(privateMemory.id);
    if (!("id" in privateMemory)) throw new Error("expected a MemoryRecord, got a gate suggestion");

    // Even without ANY grant, B can't reach the personal project at all.
    const contextB = actorContextFor(userB);
    await expect(
      memoryRecall.recall(
        contextB,
        RecallRequestSchema.parse({ project_id: personalProjectA, query: "salary negotiation" }),
      ),
    ).rejects.toThrow();

    // Now open the *project* itself to B (the harder case) — the
    // personal-visibility memory must STILL be excluded, because its
    // session was never granted.
    await grantsApp.put(contextA, "project", personalProjectA, userB, "reader");
    const afterProjectGrant = await memoryRecall.recall(
      contextB,
      RecallRequestSchema.parse({ project_id: personalProjectA, query: "salary negotiation" }),
    );
    expect(afterProjectGrant.data.some((row) => row.id === privateMemory.id)).toBe(false);

    // Granting the SPECIFIC SESSION is the escape hatch — now it
    // becomes visible to B's recall.
    await grantsApp.put(contextA, "session", privateSession.id, userB, "reader");
    const afterSessionGrant = await memoryRecall.recall(
      contextB,
      RecallRequestSchema.parse({ project_id: personalProjectA, query: "salary negotiation" }),
    );
    expect(afterSessionGrant.data.some((row) => row.id === privateMemory.id)).toBe(true);
  });
});
