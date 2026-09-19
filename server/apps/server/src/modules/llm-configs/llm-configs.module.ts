import { Module } from "@nestjs/common";

import { LLM_CONFIG_REPOSITORY } from "@openkt/data-repositories";
import { LlmGatewayService } from "@openkt/platform-llm";

import { AuthModule } from "../auth/auth.module";
import { LlmConfigsController } from "./controllers/llm-configs.controller";
import { DrizzleLlmConfigRepository } from "./repositories/drizzle-llm-config.repository";
import { LlmConfigsApplicationService } from "./services/llm-configs-application.service";

@Module({
  imports: [AuthModule],
  controllers: [LlmConfigsController],
  providers: [
    LlmGatewayService,
    LlmConfigsApplicationService,
    DrizzleLlmConfigRepository,
    {
      provide: LLM_CONFIG_REPOSITORY,
      useExisting: DrizzleLlmConfigRepository,
    },
  ],
  exports: [LlmConfigsApplicationService, LLM_CONFIG_REPOSITORY],
})
export class LlmConfigsModule {}
