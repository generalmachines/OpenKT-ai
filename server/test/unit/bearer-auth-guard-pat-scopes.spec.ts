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
