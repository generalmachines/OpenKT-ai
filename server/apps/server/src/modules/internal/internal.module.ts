import { Module } from "@nestjs/common";

import { CronController } from "./controllers/cron.controller";
import { HealthController } from "./controllers/health.controller";

@Module({
  controllers: [HealthController, CronController],
})
export class InternalModule {}
