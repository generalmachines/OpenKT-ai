import { Global, Module } from "@nestjs/common";

import { RateLimitGuard } from "./guards/rate-limit.guard";
import { RateLimitService } from "./services/rate-limit.service";

// @Global — RateLimitGuard is referenced via @UseGuards in many
// controllers; making it global means no controller has to import
// the module.
@Global()
@Module({
  providers: [RateLimitService, RateLimitGuard],
  exports: [RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
