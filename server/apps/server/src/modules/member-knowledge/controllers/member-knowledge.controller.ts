import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  MembersListQuerySchema,
  MembersMixQuerySchema,
  ProjectIdParamSchema,
  ProjectMemberParamsSchema,
} from "../contracts/member-knowledge.contract";
import { MemberKnowledgeApplicationService } from "../services/member-knowledge-application.service";

// Per-contributor knowledge endpoints. Mounted under the global `/v1`
// prefix (see main.ts) — the real routes are
//   GET /v1/projects/:project_id/members
//   GET /v1/projects/:project_id/members/mix
//   GET /v1/projects/:project_id/members/:user_id/knowledge
//
// `mix` is listed BEFORE `:user_id/knowledge` so Nest's path matcher
// doesn't try to coerce the literal string "mix" into a UUID parameter.
@Controller("projects/:project_id/members")
@UseGuards(SupabaseJwtGuard)
@ApiTags("MemberKnowledge")
@ApiBearerAuth("supabase-bearer")
export class MemberKnowledgeController {
  constructor(private readonly app: MemberKnowledgeApplicationService) {}

  @Get()
  @ApiOperation({
    summary: "List contributors in a project with per-member summary stats",
  })
  async list(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdParamSchema, params);
    const { limit } = parseWithSchema(MembersListQuerySchema, query);
    return okResponse(await this.app.listMembers(context, project_id, limit));
  }

  @Get("mix")
  @ApiOperation({
    summary: "List memories scoped to a subset of contributors (user_ids=a,b,c)",
  })
  async mix(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdParamSchema, params);
    const { user_ids, limit } = parseWithSchema(MembersMixQuerySchema, query);
    return okResponse(await this.app.mixMembers(context, project_id, user_ids, limit));
  }

  @Get(":user_id/knowledge")
  @ApiOperation({ summary: "Detail view of one contributor's project knowledge" })
  async detail(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const { project_id, user_id } = parseWithSchema(ProjectMemberParamsSchema, params);
    return okResponse(await this.app.getMember(context, project_id, user_id));
  }
}
