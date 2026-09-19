import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { PlatformAdminGuard } from "../../analytics/guards/platform-admin.guard";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { HealthDeepProbeService } from "../services/health-deep-probe.service";

// /v1/internal/health-deep — synchronous probe of every CORE service.
//
// Gated by SupabaseJwtGuard + PlatformAdminGuard (same pattern as
// /v1/internal/rabbitmq-state and /v1/internal/analytics/admin). The
// HealthMonitor cron in apps/worker calls this same probe service
// directly — it doesn't go over HTTP — so the guard only protects the
// human-facing JSON read.
//
// Returns within ~3s even when half the world is on fire: each probe
// is parallel and hard-bounded to a 3s timeout.
@Controller("internal")
@UseGuards(SupabaseJwtGuard, PlatformAdminGuard)
@ApiTags("Internal Health Deep")
@ApiBearerAuth("supabase-bearer")
export class HealthDeepController {
  constructor(private readonly probes: HealthDeepProbeService) {}

  @Get("health-deep")
  @ApiOperation({
    summary:
      "Deep health probe over rds + rabbitmq + memmachine + supabase + " +
      "openai + openrouter. Requires platform-admin allowlist membership.",
  })
  async healthDeep() {
    return okResponse(await this.probes.snapshot());
  }
}
