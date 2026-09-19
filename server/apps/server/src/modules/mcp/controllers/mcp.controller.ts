import {
  All,
  Body,
  Controller,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeController } from "@nestjs/swagger";

import type { Request, Response } from "express";

import type { ActorContext } from "@openkt/core-context";

import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { BearerAuthGuard } from "../../auth/guards/bearer-auth.guard";
import { resolveIssuer } from "../../oauth/controllers/well-known.controller";
import { resolveClientUiSupport } from "../services/mcp-apps";
import { McpServerFactoryService } from "../services/mcp-server-factory.service";

// Streamable HTTP JSON-RPC transport for OpenKT clients. Stateless: a
// fresh McpServer + transport is built per request, closed over the
// caller's ActorContext, and discarded once handleRequest returns.
//
// Auth accepts EITHER a Supabase JWT (CLI device-code, dashboard) OR
// a personal access token `okt_pat_…` (Claude.ai connector, headless
// agents, CI). Both resolve to the same ActorContext via
// BearerAuthGuard so the tool handlers don't care which path was used.
//
// Excluded from public Swagger because clients speak JSON-RPC, not REST,
// and OpenAPI doesn't model it well. The JSON-RPC contract is documented
// upstream by @modelcontextprotocol/sdk and the MCP spec.
@Controller()
@UseGuards(BearerAuthGuard)
@ApiBearerAuth("openkt-bearer")
@ApiExcludeController()
export class McpController {
  constructor(private readonly factory: McpServerFactoryService) {}

  // /mcp, and /v1/mcp for configs written by older CLI builds (both excluded
  // from the global prefix — UNPREFIXED_ROUTES in app.module.ts).
  @All(["mcp", "v1/mcp"])
  async handle(
    @ActorContextParam() context: ActorContext,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    // GET opens the optional server-to-client SSE stream. This server is
    // stateless and never sends unsolicited messages, so it says so with the
    // 405 the transport spec allows, instead of holding an idle stream open
    // until a proxy cuts it and the client reconnects.
    // https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server
    if (req.method === "GET") {
      res.setHeader("Allow", "POST, DELETE");
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server does not offer an SSE stream on GET" }, id: null });
      return;
    }

    const { StreamableHTTPServerTransport } = await this.factory.sdk();
    // MCP Apps: does this client render ui:// cards? Read from the request
    // itself, or from the session id we handed out at initialize — see
    // services/mcp-apps.ts. Only decides which tools are listed.
    const uiSupport = resolveClientUiSupport(body, req.header("mcp-session-id") ?? undefined);
    if (uiSupport.sessionId) res.setHeader("Mcp-Session-Id", uiSupport.sessionId);
    const server = await this.factory.build(context, {
      ui: uiSupport.ui,
      serverUrl: `${resolveIssuer(req)}/mcp`,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // enableJsonResponse: true makes the transport return plain JSON
      // for non-streaming requests (initialize, tools/list, most
      // tools/call results) instead of wrapping them in SSE
      // ("event: message\ndata: {...}").
      //
      // The MCP spec allows both; SSE is the default. But codex (the
      // OpenAI CLI) uses the Rust `rmcp` client, which on initialize
      // tries to deserialize the WHOLE response body into a
      // JsonRpcMessage and chokes on the SSE framing:
      //
      //   MCP startup failed: handshaking with MCP server failed:
      //   ... Deserialize error: data did not match any variant of
      //   untagged enum JsonRpcMessage, when send initialize request
      //
      // Switching to JSON-response mode lets codex parse the body
      // directly. Claude Code, Cursor, OpenCode, and the official
      // TypeScript MCP client all handle both formats (the SDK still
      // requires Accept to include text/event-stream as a precondition,
      // and emits SSE for tool calls that publish progress
      // notifications — so live progress UIs in Claude Code keep
      // working).
      //
      // Tradeoff: with JSON mode, progress notifications during a
      // single tool call are buffered into one final response instead
      // of streamed. The only thing we currently use progress for is
      // the "Embedding query…" / "Ranking memories…" line in
      // kt_recall — useful in Claude Code's "Thinking…" UI but not a
      // hard requirement. Worth the unblock for codex.
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
