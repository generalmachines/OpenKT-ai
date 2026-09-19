import { Module } from "@nestjs/common";

import { LlmGatewayService } from "@openkt/platform-llm";

import { AuthModule } from "../auth/auth.module";
import { BearerAuthGuard } from "../auth/guards/bearer-auth.guard";
import { MemoryModule } from "../memory/memory.module";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { RateLimitModule } from "../rate-limit/rate-limit.module";
import { CaptureController } from "./controllers/capture.controller";
import { CaptureService } from "./services/capture.service";

/**
 * CaptureModule — wires the /v1/capture endpoint used by the
 * openkt-cli's capture.py hook (Stage 2 LLM classify+extract).
 *
 * Dependencies:
 *   - AuthModule + PersonalTokensModule → BearerAuthGuard is registered
 *     locally here (same pattern as McpModule) so the cycle between
 *     AuthModule and PersonalTokensModule stays broken.
 *   - MemoryModule       → MemoryCommandsApplicationService (the save path)
 *   - RateLimitModule    → @RateLimit decorator support
 *
 * LlmGatewayService is registered directly as a provider (same pattern
 * as BriefingsModule) — the @openkt/platform-llm package exports the
 * service class, not a module wrapper.
 */
@Module({
  imports: [AuthModule, PersonalTokensModule, MemoryModule, RateLimitModule],
  controllers: [CaptureController],
  providers: [LlmGatewayService, CaptureService, BearerAuthGuard],
})
export class CaptureModule {}
