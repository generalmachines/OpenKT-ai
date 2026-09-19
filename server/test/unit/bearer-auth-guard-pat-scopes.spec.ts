// Unit tests for M4 "Enforce stored PAT scopes (read vs write) in the
// bearer guard". Exercises BearerAuthGuard.canActivate directly with
// stubbed collaborators — no Nest bootstrap needed since the guard's
// dependencies are simple, mockable services.
import type { ExecutionContext } from "@nestjs/common";

import { BearerAuthGuard } from "../../apps/server/src/modules/auth/guards/bearer-auth.guard";

const RAW_TOKEN = "okt_pat_" + "a".repeat(64);
const USER_ID = "00000000-0000-0000-0000-0000000000aa";

function buildGuard(scopes: string[]) {
  const personalTokens = {
    verify: jest.fn().mockResolvedValue({ userId: USER_ID, tokenId: "tok-1", scopes }),
  };
  const principalResolutionService = { resolveJwt: jest.fn() };
  const actorContextFactory = {
    createUserContext: jest.fn().mockReturnValue({ stub: true }),
  };
  const guard = new BearerAuthGuard(
    principalResolutionService as never,
    personalTokens as never,
    actorContextFactory as never,
  );
  return { guard, personalTokens, actorContextFactory };
}

function fakeExecutionContext(req: {
  path?: string;
  method?: string;
  body?: unknown;
}): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {
    path: req.path ?? "/v1/memories",
    method: req.method ?? "GET",
    body: req.body,
    header: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${RAW_TOKEN}` : null),
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("BearerAuthGuard — PAT scope enforcement", () => {
  it("answers 403 insufficient_scope (Spec 04), not a bare forbidden", async () => {
    const { guard } = buildGuard(["read"]);
    const { context } = fakeExecutionContext({ method: "POST", path: "/v1/memories" });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: "insufficient_scope",
      details: { required_scope: "write" },
    });
  });

  it.each(["kt_save_skill", "kt_save_memory", "kt_forget_memory", "kt_session_start", "kt_session_end", "kt_setup", "kt_commit_save", "kt_mark_used", "kt_create_team", "kt_invite_link", "kt_join_team", "kt_some_future_tool"])(
    "MCP: a read-only token may not call %s (deny by default)",
    async (name) => {
      const { guard } = buildGuard(["read"]);
      const { context } = fakeExecutionContext({ method: "POST", path: "/mcp", body: { method: "tools/call", params: { name } } });
      await expect(guard.canActivate(context)).rejects.toThrow(/write/);
    },
  );

  it.each(["kt_recall", "kt_search_memories", "kt_list_projects", "kt_project_brief", "kt_list_skills", "kt_get_skill", "kt_save_card", "kt_search_card", "kt_session_card"])(
    "MCP: a read-only token may call the read-only %s",
    async (name) => {
      const { guard } = buildGuard(["read"]);
      const { context } = fakeExecutionContext({ method: "POST", path: "/mcp", body: { method: "tools/call", params: { name } } });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    },
  );

  it("allows a read-scoped token on a GET request", async () => {
    const { guard } = buildGuard(["read"]);
    const { context } = fakeExecutionContext({ method: "GET", path: "/v1/memories" });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects a read-only token on a POST (write) request", async () => {
    const { guard } = buildGuard(["read"]);
    const { context } = fakeExecutionContext({ method: "POST", path: "/v1/memories" });
    await expect(guard.canActivate(context)).rejects.toThrow(/write/);
  });

  it("allows a read+write token on a POST request", async () => {
    const { guard } = buildGuard(["read", "write"]);
    const { context } = fakeExecutionContext({ method: "POST", path: "/v1/memories" });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("an admin-scoped token bypasses the read/write check entirely", async () => {
    const { guard } = buildGuard(["admin"]);
    const { context } = fakeExecutionContext({ method: "DELETE", path: "/v1/memories/1" });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("MCP: a read-only token can call the read-only kt_recall tool", async () => {
    const { guard } = buildGuard(["read"]);
    const { context } = fakeExecutionContext({
      method: "POST",
      path: "/mcp",
      body: { method: "tools/call", params: { name: "kt_recall" } },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("MCP: a read-only token is rejected calling the mutating kt_save_memory tool", async () => {
    const { guard } = buildGuard(["read"]);
    const { context } = fakeExecutionContext({
      method: "POST",
      path: "/mcp",
      body: { method: "tools/call", params: { name: "kt_save_memory" } },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(/write/);
  });

  it("MCP: a read-only token can still call non-tools/call JSON-RPC methods (initialize, tools/list)", async () => {
    const { guard } = buildGuard(["read"]);
    const { context } = fakeExecutionContext({
      method: "POST",
      path: "/mcp",
      body: { method: "tools/list" },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("MCP: read+write token can call kt_save_memory", async () => {
    const { guard } = buildGuard(["read", "write"]);
    const { context } = fakeExecutionContext({
      method: "POST",
      path: "/mcp",
      body: { method: "tools/call", params: { name: "kt_save_memory" } },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
