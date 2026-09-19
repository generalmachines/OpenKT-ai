// Unit tests for GAP 2: WWW-Authenticate header on /mcp 401 responses.
//
// The AppExceptionFilter sets this header whenever it maps a 401
// UnauthorizedDomainError on a /mcp path. We drive the filter directly
// with minimal stubs — no Nest, no http.

import { UnauthorizedDomainError } from "@openkt/core-errors";
import { ArgumentsHost } from "@nestjs/common";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";

// ── minimal stubs ─────────────────────────────────────────────────────

function makeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(_body: unknown) {
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    get headers() {
      return headers;
    },
    get statusCode() {
      return statusCode;
    },
  };
}

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return {
    originalUrl: url,
    url,
    method: "POST",
    headers,
    get(name: string) {
      if (name === "host") return headers.host ?? "localhost:4100";
      return headers[name];
    },
    protocol: "http",
    requestMetadata: { requestId: "req-test" },
    actorContext: null,
  };
}

function makeHost(request: unknown, response: unknown): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe("AppExceptionFilter — WWW-Authenticate on /mcp 401", () => {
  const filter = new AppExceptionFilter();

  it("sets WWW-Authenticate header on /mcp 401 using request host", () => {
    const res = makeResponse();
    const req = makeRequest("/mcp", { host: "api.openkt.ai" });
    const host = makeHost(req, res);

    filter.catch(new UnauthorizedDomainError("no token"), host);

    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(
      /^Bearer resource_metadata="http:\/\/api\.openkt\.ai\/.well-known\/oauth-protected-resource"$/,
    );
  });

  it("uses x-forwarded-proto + x-forwarded-host for the metadata URL", () => {
    const res = makeResponse();
    const req = makeRequest("/mcp", {
      host: "internal.lb:4100",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "api.openkt.ai",
    });
    const host = makeHost(req, res);

    filter.catch(new UnauthorizedDomainError("no token"), host);

    expect(res.headers["WWW-Authenticate"]).toBe(
      `Bearer resource_metadata="https://api.openkt.ai/.well-known/oauth-protected-resource"`,
    );
  });

  it("also sets the header for /v1/mcp (legacy alias)", () => {
    const res = makeResponse();
    const req = makeRequest("/v1/mcp", { host: "api.openkt.ai" });
    const host = makeHost(req, res);

    filter.catch(new UnauthorizedDomainError("no token"), host);

    expect(res.headers["WWW-Authenticate"]).toMatch(/Bearer resource_metadata=/);
  });

  it("does NOT set WWW-Authenticate for 401s on non-MCP paths", () => {
    const res = makeResponse();
    const req = makeRequest("/v1/me", { host: "api.openkt.ai" });
    const host = makeHost(req, res);

    filter.catch(new UnauthorizedDomainError("no token"), host);

    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
  });

  it("does NOT set WWW-Authenticate for non-401 errors on /mcp", () => {
    const { ForbiddenDomainError } = require("@openkt/core-errors");
    const res = makeResponse();
    const req = makeRequest("/mcp", { host: "api.openkt.ai" });
    const host = makeHost(req, res);

    filter.catch(new ForbiddenDomainError("no access"), host);

    expect(res.statusCode).toBe(403);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
  });
});
