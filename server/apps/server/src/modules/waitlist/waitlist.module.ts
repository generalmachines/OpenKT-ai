import { Module, forwardRef } from "@nestjs/common";

import { PlatformAdminGuard } from "../analytics/guards/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { RateLimitModule } from "../rate-limit/rate-limit.module";
import { AdminWaitlistController } from "./controllers/admin-waitlist.controller";
import { PublicWaitlistController } from "./controllers/public-waitlist.controller";
import { WaitlistService } from "./services/waitlist.service";

// forwardRef on AuthModule because AuthApplicationService (in AuthModule)
// injects WaitlistService for the signup gate, and the admin controller
// here re-uses SupabaseJwtGuard from AuthModule.
@Module({
  imports: [forwardRef(() => AuthModule), RateLimitModule],
  controllers: [PublicWaitlistController, AdminWaitlistController],
  providers: [WaitlistService, PlatformAdminGuard],
  exports: [WaitlistService],
})
export class WaitlistModule {}
