// Unit tests for /.well-known/oauth-authorization-server (RFC 8414)
// and /.well-known/oauth-protected-resource (RFC 9728).
//
// The controller is a pure derivation off `req.headers` /
// `req.protocol`, so we drive it directly with a hand-rolled Request
// stub. No Nest, no http, no DI.

import { OauthWellKnownController } from "../../apps/server/src/modules/oauth/controllers/well-known.controller";

import type { Request } from "express";

function fakeRequest(opts: {
  protocol?: string;
  host?: string;
  forwardedProto?: string;
  forwardedHost?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.forwardedProto) headers["x-forwarded-proto"] = opts.forwardedProto;
  if (opts.forwardedHost) headers["x-forwarded-host"] = opts.forwardedHost;
  return {
    protocol: opts.protocol ?? "http",
    headers,
    get(name: string) {
      if (name.toLowerCase() === "host") return opts.host ?? "localhost:4100";
      return undefined;
    },
  } as unknown as Request;
}

describe("OauthWellKnownController — oauth-authorization-server (RFC 8414)", () => {
  const controller = new OauthWellKnownController();

  it("returns issuer + endpoint URLs derived from the request host", () => {
    const result = controller.metadata(
      fakeRequest({ protocol: "https", host: "api.openkt.ai" }),
    );
    expect(result).toEqual({
      issuer: "https://api.openkt.ai",
      authorization_endpoint: "https://api.openkt.ai/oauth/authorize",
      token_endpoint: "https://api.openkt.ai/oauth/token",
      registration_endpoint: "https://api.openkt.ai/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "none",
      ],
      scopes_supported: ["read", "write"],
    });
  });

  it("honours x-forwarded-proto and x-forwarded-host (Cloudflare / ALB)", () => {
    const result = controller.metadata(
      fakeRequest({
        protocol: "http", // raw socket is http (behind a TLS terminator)
        host: "internal.lb.openkt:4100",
        forwardedProto: "https",
        forwardedHost: "api.openkt.ai",
      }),
    );
    expect(result.issuer).toBe("https://api.openkt.ai");
    expect(result.token_endpoint).toBe("https://api.openkt.ai/oauth/token");
    expect(result.authorization_endpoint).toBe(
      "https://api.openkt.ai/oauth/authorize",
    );
    expect(result.registration_endpoint).toBe(
      "https://api.openkt.ai/oauth/register",
    );
  });

  it("falls back to the raw host for dev environments", () => {
    const result = controller.metadata(
      fakeRequest({ protocol: "http", host: "localhost:4100" }),
    );
    expect(result.issuer).toBe("http://localhost:4100");
    expect(result.token_endpoint).toBe("http://localhost:4100/oauth/token");
  });

  it("takes the first value from a comma-separated x-forwarded-* header", () => {
    const result = controller.metadata(
      fakeRequest({
        protocol: "http",
        host: "internal:80",
        forwardedProto: "https, http",
        forwardedHost: "api.openkt.ai, internal",
      }),
    );
    expect(result.issuer).toBe("https://api.openkt.ai");
  });
});

describe("OauthWellKnownController — oauth-protected-resource (RFC 9728)", () => {
  const controller = new OauthWellKnownController();

  it("returns resource=/mcp and authorization_servers=[issuer] for the api host", () => {
    const result = controller.protectedResource(
      fakeRequest({ protocol: "https", host: "api.openkt.ai" }),
    );
    expect(result).toEqual({
      resource: "https://api.openkt.ai/mcp",
      authorization_servers: ["https://api.openkt.ai"],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("honours x-forwarded-host behind ALB/Cloudflare", () => {
    const result = controller.protectedResource(
      fakeRequest({
        protocol: "http",
        host: "internal.lb:4100",
        forwardedProto: "https",
        forwardedHost: "mcp.openkt.ai",
      }),
    );
    expect(result.resource).toBe("https://mcp.openkt.ai/mcp");
    expect(result.authorization_servers).toEqual(["https://mcp.openkt.ai"]);
  });

  it("falls back to localhost for dev", () => {
    const result = controller.protectedResource(
      fakeRequest({ protocol: "http", host: "localhost:4100" }),
    );
    expect(result.resource).toBe("http://localhost:4100/mcp");
    expect(result.authorization_servers).toEqual(["http://localhost:4100"]);
    expect(result.bearer_methods_supported).toEqual(["header"]);
  });

  it("takes the first value from comma-separated x-forwarded-* headers", () => {
    const result = controller.protectedResource(
      fakeRequest({
        protocol: "http",
        host: "internal:80",
        forwardedProto: "https, http",
        forwardedHost: "api.openkt.ai, internal",
      }),
    );
    expect(result.resource).toBe("https://api.openkt.ai/mcp");
    expect(result.authorization_servers[0]).toBe("https://api.openkt.ai");
  });
});
