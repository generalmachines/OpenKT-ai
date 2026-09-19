import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

import {
  extractBearerToken,
  mapRequestMetadata,
} from "@openkt/auth-principal";
import { ForbiddenDomainError, UnauthorizedDomainError } from "@openkt/core-errors";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { PersonalTokensService } from "../../personal-tokens/services/personal-tokens.service";
import { ActorContextFactory } from "../services/actor-context.factory";
import { PrincipalResolutionService } from "../services/principal-resolution.service";
import { buildUserPrincipal } from "@openkt/auth-principal";

// MCP tool names that mutate state. Everything else registered by
// McpServerFactoryService (kt_recall, kt_search_memories,
// kt_list_projects, kt_project_brief) is read-only. Used only to scope
// a `read`-only PAT off JSON-RPC tools/call — every other JSON-RPC
// method (initialize, tools/list, ping, …) is inherently read-only.
const MCP_WRITE_TOOLS = new Set([
  "kt_save_memory",
  "kt_forget_memory",
  "kt_session_start",
  "kt_session_end",
  "kt_setup",
]);

// BearerAuthGuard — accepts EITHER a Supabase JWT (used by the dashboard
// and `kt` CLI device-code flow) OR an `okt_pat_…` personal access token
// (used by Claude.ai's MCP connector, headless agents, CI jobs).
//
// Discrimination is by the token prefix: tokens that start with
// `okt_pat_` go through PersonalTokensService.verify; everything else
// is handed to PrincipalResolutionService.resolveJwt (Supabase-only
// JWKS verification). This is the SAME entry point SupabaseJwtGuard
// uses, so the actor context downstream code sees is identical
// regardless of which auth method was used.
//
// We share this guard with the MCP controller so the same Bearer
// header works against /v1/* REST + /v1/mcp JSON-RPC, with no
// per-protocol auth split.
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly principalResolutionService: PrincipalResolutionService,
    private readonly personalTokens: PersonalTokensService,
    private readonly actorContextFactory: ActorContextFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const bearerToken = extractBearerToken(request.header("authorization") ?? null);

    if (!bearerToken) {
      throw new UnauthorizedDomainError("authorization bearer token required");
    }

    const requestMetadata = request.requestMetadata ?? mapRequestMetadata(request);

    if (bearerToken.startsWith("okt_pat_")) {
      const { userId, tokenId, scopes } = await this.personalTokens.verify(bearerToken);
      this.enforcePatScope(request, scopes);
      request.actorContext = this.actorContextFactory.createUserContext({
        principal: buildUserPrincipal(
          {
            userId,
            email: null,
            displayName: null,
            oauthIdentity: null,
          },
          "mcp-token",
          tokenId,
          scopes,
        ),
        request: requestMetadata,
        // PAT-issued sessions don't carry a Supabase JWT; downstream
        // code that needs Supabase-only operations (e.g. signOut) is
        // restricted to JWT-auth paths anyway.
        jwt: null,
      });
      return true;
    }

    request.actorContext = await this.principalResolutionService.resolveJwt(
      requestMetadata,
      bearerToken,
    );
    return true;
  }

  // architecture.md §3: "Access tokens carry scopes that are actually
  // enforced (context:read, context:write, admin)." Stored PAT scopes
  // are `read` | `write` | `admin` (PersonalTokensService); `admin`
  // implies both. A Supabase JWT session is never scope-restricted —
  // this only runs for `okt_pat_…` tokens.
  //
  // REST: GET/HEAD is `read`, every other verb is `write`.
  // MCP (/mcp, always POST JSON-RPC): only a `tools/call` against a
  // known-mutating tool name requires `write`; every other JSON-RPC
  // method (initialize, tools/list, ping, resources/*, and read-only
  // tool calls) only requires `read`.
  private enforcePatScope(request: RequestWithContext, scopes: string[]): void {
    if (scopes.includes("admin")) return;

    const requiredScope = this.requiredScopeFor(request);
    if (!scopes.includes(requiredScope)) {
      throw new ForbiddenDomainError(
        `personal access token is missing the '${requiredScope}' scope`,
      );
    }
  }

  private requiredScopeFor(request: RequestWithContext): "read" | "write" {
    const isMcp = (request.path ?? request.originalUrl ?? "").includes("/mcp");
    if (!isMcp) {
      const method = request.method?.toUpperCase() ?? "GET";
      return method === "GET" || method === "HEAD" || method === "OPTIONS" ? "read" : "write";
    }

    const body = request.body as
      | { method?: string; params?: { name?: string } }
      | undefined;
    if (body?.method === "tools/call" && body.params?.name && MCP_WRITE_TOOLS.has(body.params.name)) {
      return "write";
    }
    return "read";
  }
}
