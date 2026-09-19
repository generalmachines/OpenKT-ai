import { Module } from "@nestjs/common";

import { HealthController } from "./controllers/health.controller";
import { MetaController } from "./controllers/meta.controller";

@Module({
  controllers: [HealthController, MetaController],
})
export class HealthModule {}
