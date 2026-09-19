import { Module } from "@nestjs/common";

import { LlmGatewayService } from "@openkt/platform-llm";

import { AuthModule } from "../auth/auth.module";
import { ProjectsModule } from "../projects/projects.module";
import { BriefingController } from "./controllers/briefing.controller";
import { BriefingCacheRepository } from "./repositories/briefing-cache.repository";
import { BriefingService } from "./services/briefing.service";
import { ChangelogService } from "./services/changelog.service";

// Briefings v2 — live-view briefing + changelog endpoints.
// Distinct from the legacy `BriefingsModule` (plural) which serves
// /v1/briefings on the older `team_briefings` schema.
@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [BriefingController],
  providers: [
    BriefingCacheRepository,
    BriefingService,
    ChangelogService,
    LlmGatewayService,
  ],
  exports: [BriefingService, ChangelogService],
})
export class BriefingModule {}
