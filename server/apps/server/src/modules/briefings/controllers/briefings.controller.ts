import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  ProjectIdQuerySchema,
  RefreshBriefingBodySchema,
} from "../contracts/briefing.contract";
import { BriefingsApplicationService } from "../services/briefings-application.service";

@Controller("briefings")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Briefings")
@ApiBearerAuth("supabase-bearer")
export class BriefingsController {
  constructor(
    private readonly briefingsApplicationService: BriefingsApplicationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Fetch the current team briefing for a project" })
  async getCurrent(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdQuerySchema, query);
    return okResponse(
      await this.briefingsApplicationService.getCurrent(context, project_id),
    );
  }

  @Post()
  @ApiOperation({ summary: "Regenerate the team briefing for a project" })
  async refresh(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const { project_id } = parseWithSchema(RefreshBriefingBodySchema, body);
    return okResponse(
      await this.briefingsApplicationService.refresh(context, project_id),
    );
  }
}
