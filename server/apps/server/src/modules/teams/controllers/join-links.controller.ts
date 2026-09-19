import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  CodeParamsSchema,
  CreateJoinLinkBodySchema,
  JoinBodySchema,
  ProjectCodeParamsSchema,
  ProjectIdParamsSchema,
} from "../contracts/join-link.contract";
import { TeamsService } from "../services/teams.service";

// Join links on a space ("team"). Creating one needs edit access; listing and
// deleting are for the owner. Joining turns into an ordinary grant.
@Controller("projects/:id/join-links")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Teams")
@ApiBearerAuth("supabase-bearer")
export class ProjectJoinLinksController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Make a join link for a space (owner or editor): anyone who opens it and signs in joins with `role`. " +
      "Returns `{code, url}`; the link expires after `expires_in_days` (default 30) or `max_uses` joins.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["reader", "editor"], default: "editor" },
        expires_in_days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        max_uses: { type: "integer", minimum: 1, nullable: true },
      },
    },
  })
  async create(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(ProjectIdParamsSchema, params);
    const input = parseWithSchema(CreateJoinLinkBodySchema, body ?? {});
    return okResponse(await this.teams.createLink(context, id, input));
  }

  @Get()
  @ApiOperation({ summary: "List a space's join links, used-up and expired ones included (owner only)." })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async list(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(ProjectIdParamsSchema, params);
    return okResponse(await this.teams.listLinks(context, id));
  }

  @Delete(":code")
  @ApiOperation({ summary: "Delete a join link (owner only). People who already joined keep their access." })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "code", schema: { type: "string" } })
  async remove(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id, code } = parseWithSchema(ProjectCodeParamsSchema, params);
    return okResponse(await this.teams.revokeLink(context, id, code));
  }
}

@Controller("join")
@ApiTags("Teams")
export class JoinController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseJwtGuard)
  @ApiBearerAuth("supabase-bearer")
  @ApiOperation({
    summary:
      "Join a space with a join link's code (or the whole link). Returns `{space: {id, name}, role}`. " +
      "404 when the link does not exist, expired or is used up.",
  })
  @ApiBody({ schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } })
  async join(@ActorContextParam() context: ActorContext, @Body() body: unknown) {
    const { code } = parseWithSchema(JoinBodySchema, body);
    return okResponse(await this.teams.join(context, code));
  }

  @Get(":code/preview")
  @ApiOperation({
    summary: "What a join link leads to, without signing in: `{space_name, inviter_name, role}`, or 404.",
  })
  @ApiParam({ name: "code", schema: { type: "string" } })
  async preview(@Param() params: unknown) {
    const { code } = parseWithSchema(CodeParamsSchema, params);
    return okResponse(await this.teams.preview(code));
  }
}
