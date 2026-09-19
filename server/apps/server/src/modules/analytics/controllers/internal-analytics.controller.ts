import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { AdminAnalyticsQuerySchema } from "../contracts/analytics.contract";
import { PlatformAdminGuard } from "../guards/platform-admin.guard";
import { AnalyticsQueryService } from "../services/analytics-query.service";

// /v1/internal/analytics/admin — aggregate across all orgs. Gated by
// SupabaseJwtGuard (must be a real user) + PlatformAdminGuard (must
// be in the OPENKT_PLATFORM_ADMIN_USER_IDS env allowlist).
@Controller("internal/analytics")
@UseGuards(SupabaseJwtGuard, PlatformAdminGuard)
@ApiTags("Internal Analytics")
@ApiBearerAuth("supabase-bearer")
export class InternalAnalyticsController {
  constructor(private readonly analyticsQuery: AnalyticsQueryService) {}

  @Get("admin")
  @ApiOperation({
    summary:
      "Platform-wide analytics aggregate. Requires OPENKT_PLATFORM_ADMIN_USER_IDS membership.",
  })
  async admin(@Query() query: unknown) {
    const input = parseWithSchema(AdminAnalyticsQuerySchema, query);
    return okResponse(await this.analyticsQuery.adminDailyStats(input));
  }
}
