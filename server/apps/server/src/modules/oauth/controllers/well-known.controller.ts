import { Controller, Get, NotFoundException, Param, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

// RFC 8414 — OAuth 2.0 Authorization Server Metadata, served at
// `/.well-known/oauth-authorization-server`. Claude.ai's MCP connector
// hits this URL on the bare host (no /v1 prefix) before the user even
// finishes typing the server URL, so the controller is excluded from
// the global v1 prefix in main.ts.
//
// RFC 9728 — OAuth 2.0 Protected Resource Metadata, served at
// `/.well-known/oauth-protected-resource`. MCP clients that speak the
// 2025 spec discover the authorization server via this document first
// (before even hitting the well-known authorization-server doc). It
// points to the resource URL (/mcp) and the authorization server(s).

@Controller(".well-known")
@ApiTags("OAuth (Claude.ai / DCR clients)")
export class OauthWellKnownController {
  @Get("oauth-authorization-server")
  @ApiOperation({
    summary: "RFC 8414 metadata discovery",
    description:
      "Returns the authorization server's metadata so MCP clients can " +
      "find /oauth/authorize, /oauth/token, /oauth/register. Honours " +
      "x-forwarded-proto / x-forwarded-host so the URLs match the public " +
      "origin. Path is `/.well-known/oauth-authorization-server` (no /v1 prefix).",
  })
  @ApiResponse({
    status: 200,
    description: "Authorization server metadata (RFC 8414)",
    schema: {
      type: "object",
      properties: {
        issuer: { type: "string", example: "https://api.openkt.ai" },
        authorization_endpoint: { type: "string" },
        token_endpoint: { type: "string" },
        registration_endpoint: { type: "string" },
        response_types_supported: { type: "array", items: { type: "string" } },
        grant_types_supported: { type: "array", items: { type: "string" } },
        code_challenge_methods_supported: { type: "array", items: { type: "string" } },
        token_endpoint_auth_methods_supported: { type: "array", items: { type: "string" } },
        scopes_supported: { type: "array", items: { type: "string" } },
      },
    },
  })
  metadata(@Req() req: Request) {
    return authorizationServerMetadata(resolveIssuer(req));
  }

  // OpenID Connect discovery location. Some MCP clients try it when (or
  // before) the RFC 8414 document; it carries the same OAuth metadata. There
  // is no ID token, so no jwks_uri or id_token claims are advertised.
  @Get("openid-configuration")
  @ApiOperation({ summary: "Same authorization server metadata at the OIDC discovery path" })
  openidConfiguration(@Req() req: Request) {
    return authorizationServerMetadata(resolveIssuer(req));
  }

  // RFC 9728 — OAuth 2.0 Protected Resource Metadata.
  //
  // MCP clients (specifically the 2025-03-26 and later spec revisions)
  // read this document first to discover which authorization server
  // protects the resource, then follow up with the authorization-server
  // metadata doc. Without it, clients that implement the newer discovery
  // flow receive a 404 and fall back to guessing or fail entirely.
  //
  // `resource` is the canonical URL of the MCP endpoint itself.
  // `authorization_servers` lists the issuer(s) that can grant access.
  // Both are derived from the same Host/x-forwarded-host logic as the
  // authorization-server metadata so they are consistent across ALB /
  // Cloudflare TLS termination.
  @Get("oauth-protected-resource")
  @ApiOperation({
    summary: "RFC 9728 protected resource metadata",
    description:
      "Returns metadata about the /mcp protected resource so MCP clients " +
      "can discover the authorization server automatically. Honours " +
      "x-forwarded-proto / x-forwarded-host. Path is " +
      "`/.well-known/oauth-protected-resource` (no /v1 prefix).",
  })
  @ApiResponse({
    status: 200,
    description: "Protected resource metadata (RFC 9728)",
    schema: {
      type: "object",
      properties: {
        resource: { type: "string", example: "https://api.openkt.ai/mcp" },
        authorization_servers: {
          type: "array",
          items: { type: "string" },
          example: ["https://api.openkt.ai"],
        },
        scopes_supported: { type: "array", items: { type: "string" } },
        bearer_methods_supported: { type: "array", items: { type: "string" } },
      },
    },
  })
  protectedResource(@Req() req: Request) {
    return protectedResourceMetadata(resolveIssuer(req), "/mcp");
  }

  // RFC 9728 §3.1: the metadata of the resource https://host/mcp lives at
  // /.well-known/oauth-protected-resource/mcp (path inserted after the
  // well-known segment). Clients that build the URL themselves fetch this one.
  @Get("oauth-protected-resource/{*path}")
  @ApiOperation({ summary: "RFC 9728 path-suffixed protected resource metadata (/mcp, /v1/mcp)" })
  protectedResourceForPath(@Param("path") path: string | string[], @Req() req: Request, @Res() res: Response) {
    const suffix = `/${(Array.isArray(path) ? path.join("/") : path).replace(/^\/+|\/+$/g, "")}`;
    if (suffix !== "/mcp" && suffix !== "/v1/mcp") throw new NotFoundException("no protected resource at that path");
    res.json(protectedResourceMetadata(resolveIssuer(req), suffix));
  }
}

// RFC 8414 metadata. Token endpoint auth: public clients (PKCE only,
// "none") and confidential clients with the secret in the body or in HTTP
// Basic — the three methods MCP clients register with.
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["read", "write"],
    service_documentation: `${issuer}/connect`,
  };
}

export function protectedResourceMetadata(issuer: string, path: string) {
  return {
    resource: `${issuer}${path}`,
    authorization_servers: [issuer],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "OpenKT",
    resource_documentation: `${issuer}/connect`,
  };
}

export function resolveIssuer(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    req.protocol ??
    "http";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ??
    req.get("host") ??
    "localhost";
  return `${proto}://${host}`;
}
