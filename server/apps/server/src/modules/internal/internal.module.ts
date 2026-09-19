import { Module } from "@nestjs/common";

import { CronController } from "./controllers/cron.controller";
import { HealthController } from "./controllers/health.controller";
import { ObservabilityController } from "./controllers/observability.controller";

@Module({
  controllers: [HealthController, CronController, ObservabilityController],
})
export class InternalModule {}
