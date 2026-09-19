import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { PlatformAdminGuard } from "../../analytics/guards/platform-admin.guard";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RabbitMqStateService } from "../services/rabbitmq-state.service";

// /v1/internal/rabbitmq-state — live broker snapshot for the platform-
// admin dashboard. Gated by SupabaseJwtGuard (must be a real user) +
// PlatformAdminGuard (must be in the OPENKT_PLATFORM_ADMIN_USER_IDS
// env allowlist). Same dual-guard pattern as /v1/internal/analytics.
//
// The endpoint NEVER 5xx's — when the broker is unreachable, the
// service returns broker_reachable=false with empty arrays so the
// admin dashboard can render a "broker unreachable" state instead of
// blowing up.
@Controller("internal")
@UseGuards(SupabaseJwtGuard, PlatformAdminGuard)
@ApiTags("Internal Observability")
@ApiBearerAuth("supabase-bearer")
export class RabbitMqStateController {
  constructor(private readonly rabbitMqStateService: RabbitMqStateService) {}

  @Get("rabbitmq-state")
  @ApiOperation({
    summary:
      "Live RabbitMQ broker state — exchanges, queues, consumers. Requires " +
      "platform-admin allowlist membership.",
  })
  async state() {
    return okResponse(await this.rabbitMqStateService.snapshot());
  }
}
