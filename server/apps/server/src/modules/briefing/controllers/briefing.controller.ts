import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  ChangelogQuerySchema,
  ProjectIdParamSchema,
} from "../contracts/briefing.contract";
import { BriefingService } from "../services/briefing.service";
import { ChangelogService } from "../services/changelog.service";

// Briefings-v2 controller — the live view + changelog surface.
//
//   GET /v1/projects/:project_id/briefing
//     -> cached briefing row, with `stale: true` when a refresh has
//        been enqueued in the background
//
//   GET /v1/projects/:project_id/changelog?since=<iso8601>
//     -> "what's new since X" — memories, episodes, and an LLM
//        paragraph summarising the window

@Controller("projects/:project_id")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Briefing")
@ApiBearerAuth("supabase-bearer")
export class BriefingController {
  constructor(
    private readonly briefing: BriefingService,
    private readonly changelog: ChangelogService,
  ) {}

  @Get("briefing")
  @ApiOperation({
    summary: "Get the current live-view briefing for a project",
    description:
      "Returns the cached briefing row. When `stale_at` has passed, a refresh " +
      "job is enqueued in the background and the response is tagged " +
      "`stale: true` — the UI never blocks on regeneration.",
  })
  @ApiParam({ name: "project_id", schema: { type: "string", format: "uuid" } })
  async getBriefing(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdParamSchema, params);
    return okResponse(await this.briefing.getBriefing(context, project_id));
  }

  @Get("changelog")
  @ApiOperation({
    summary: "Get the changelog of what's new since a timestamp",
    description:
      "Composes new memories, archived memories, new episodes, and superseded " +
      "episodes since `since`, plus an LLM-generated paragraph summarising the " +
      "window. The summary is cached for 5 minutes keyed by (project_id, " +
      "since-bucketed-to-hour).",
  })
  @ApiParam({ name: "project_id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "since", required: true, schema: { type: "string", format: "date-time" } })
  async getChangelog(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdParamSchema, params);
    const { since } = parseWithSchema(ChangelogQuerySchema, query);
    return okResponse(await this.changelog.getChangelog(context, project_id, since));
  }
}
