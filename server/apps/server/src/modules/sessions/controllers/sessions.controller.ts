import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { pagedResponse } from "../../../common/http/paged-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";

import {
  AddSessionTurnSchema,
  CloseSessionSchema,
  CreateSessionSchema,
  ListSessionsQuerySchema,
  SessionIdParamsSchema,
} from "../contracts/session.contract";
import { SessionsApplicationService } from "../services/sessions-application.service";

// REST surface for sessions (T0, architecture.md §2). Mirrors the MCP
// tool contract 1:1 (kt_session_start / kt_session_end) so the
// dashboard and any REST client get the exact same session lifecycle
// coding agents get over MCP.
@Controller("sessions")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Sessions")
@ApiBearerAuth("supabase-bearer")
export class SessionsController {
  constructor(private readonly sessionsApplicationService: SessionsApplicationService) {}

  @Post()
  @ApiOperation({ summary: "Open a session" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        project_id: { type: "string", maxLength: 256 },
        source: {
          type: "string",
          enum: ["claude-code", "chatgpt", "claude", "mcp", "voice", "meeting", "screenshot", "note", "connector"],
          default: "mcp",
        },
        client: { type: "string", maxLength: 120, nullable: true },
        title: { type: "string", maxLength: 200, nullable: true },
        metadata: { type: "object" },
      },
    },
  })
  @RateLimit({ key: "user", name: "session_start", capacity: 60, refillPerSec: 1 })
  async start(@ActorContextParam() context: ActorContext, @Body() body: unknown) {
    const input = parseWithSchema(CreateSessionSchema, body);
    return okResponse(await this.sessionsApplicationService.start(context, input));
  }

  @Post(":id/turns")
  @ApiOperation({ summary: "Append a turn to an open session" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
        content: { type: "string", minLength: 1, maxLength: 50000 },
        metadata: { type: "object" },
      },
      required: ["role", "content"],
    },
  })
  @RateLimit({ key: "user", name: "session_turn", capacity: 600, refillPerSec: 10 })
  async addTurn(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWithSchema(SessionIdParamsSchema, params);
    const input = parseWithSchema(AddSessionTurnSchema, body);
    return okResponse(await this.sessionsApplicationService.addTurn(context, id, input));
  }

  @Post(":id/close")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Close a session with the model's own summary" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      properties: { summary: { type: "string", maxLength: 20000, nullable: true } },
    },
  })
  @RateLimit({ key: "user", name: "session_close", capacity: 60, refillPerSec: 1 })
  async close(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWithSchema(SessionIdParamsSchema, params);
    const input = parseWithSchema(CloseSessionSchema, body ?? {});
    return okResponse(await this.sessionsApplicationService.close(context, id, input));
  }

  @Get()
  @ApiOperation({ summary: "List sessions for a project" })
  @ApiQuery({ name: "project_id", required: false, schema: { type: "string" } })
  @ApiQuery({ name: "status", required: false, schema: { type: "string", enum: ["open", "closed"] } })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } })
  @ApiQuery({ name: "offset", required: false, schema: { type: "integer", minimum: 0, default: 0 } })
  async list(@ActorContextParam() context: ActorContext, @Query() query: unknown) {
    const input = parseWithSchema(ListSessionsQuerySchema, query);
    const result = await this.sessionsApplicationService.list(context, input);
    return pagedResponse(result.data, result.meta);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a session with its facts and my_role; turns only for an editor or owner" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async getById(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(SessionIdParamsSchema, params);
    return okResponse(await this.sessionsApplicationService.get(context, id));
  }
}
