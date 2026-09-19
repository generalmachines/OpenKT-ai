import { Module } from "@nestjs/common";

import { PlatformAdminGuard } from "../analytics/guards/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { HealthDeepController } from "./controllers/health-deep.controller";
import { HealthDeepProbeService } from "./services/health-deep-probe.service";

// HealthDeepModule — registers the deep-probe endpoint AND exports the
// probe service so it could be imported elsewhere if a future module
// needs to ask "is everything ok" before doing work.
//
// The worker app reproduces the probe service in its own DI container
// (via the HealthMonitorModule) rather than importing this — keeping
// apps/server and apps/worker independently buildable.
@Module({
  imports: [AuthModule],
  controllers: [HealthDeepController],
  providers: [HealthDeepProbeService, PlatformAdminGuard],
  exports: [HealthDeepProbeService],
})
export class HealthDeepModule {}
