import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  OrgAnalyticsParamsSchema,
  OrgAnalyticsQuerySchema,
  SelfAnalyticsQuerySchema,
} from "../contracts/analytics.contract";
import { AnalyticsQueryService } from "../services/analytics-query.service";

@Controller()
@UseGuards(SupabaseJwtGuard)
@ApiTags("Analytics")
@ApiBearerAuth("supabase-bearer")
export class AnalyticsController {
  constructor(private readonly analyticsQuery: AnalyticsQueryService) {}

  @Get("analytics/me")
  @ApiOperation({
    summary:
      "Caller's per-day analytics rollup for the last N days (default 30, max 180).",
  })
  async me(@ActorContextParam() context: ActorContext, @Query() query: unknown) {
    const input = parseWithSchema(SelfAnalyticsQuerySchema, query);
    return okResponse(await this.analyticsQuery.selfDailyStats(context, input));
  }

  @Get("orgs/:org_id/analytics")
  @ApiOperation({
    summary:
      "Per-org daily rollup. include=user_breakdown adds a per-user " +
      "table for org owners + admins.",
  })
  async org(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { org_id } = parseWithSchema(OrgAnalyticsParamsSchema, params);
    const input = parseWithSchema(OrgAnalyticsQuerySchema, query);
    return okResponse(
      await this.analyticsQuery.orgDailyStats(context, org_id, input),
    );
  }
}
