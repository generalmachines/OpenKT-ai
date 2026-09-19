import { Module } from "@nestjs/common";

import { LlmGatewayService } from "@openkt/platform-llm";

import { AuthModule } from "../auth/auth.module";
import { LocalPgPool } from "../data/local-pg-pool.provider";
import { BriefingsController } from "./controllers/briefings.controller";
import { LocalPgBriefingRepository } from "./repositories/local-pg-briefing.repository";
import { BriefingsApplicationService } from "./services/briefings-application.service";

@Module({
  imports: [AuthModule],
  controllers: [BriefingsController],
  providers: [
    LocalPgPool,
    LocalPgBriefingRepository,
    LlmGatewayService,
    BriefingsApplicationService,
  ],
  exports: [BriefingsApplicationService],
})
export class BriefingsModule {}
