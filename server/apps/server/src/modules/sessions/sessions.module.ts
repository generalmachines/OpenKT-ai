import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ProjectsModule } from "../projects/projects.module";
import { AccessModule } from "../access/access.module";
import { GrantsModule } from "../grants/grants.module";
import { JobQueueRepository } from "../jobs/repositories/job-queue.repository";
import { MemoryRepository } from "../memory/repositories/memory.repository";
import { SessionsController } from "./controllers/sessions.controller";
import { SessionRepository } from "./repositories/session.repository";
import { SessionIdleSweepService } from "./services/session-idle-sweep.service";
import { SessionsApplicationService } from "./services/sessions-application.service";

// SessionsModule provides MemoryRepository directly (not via
// MemoryModule) so GET /v1/sessions/:id can hydrate its "distilled
// memories" list without importing MemoryModule — which itself needs
// SessionRepository (for save-time session stamping in
// MemoryCommandsApplicationService / MemoryRecallService) and would
// create a module-level import cycle. Both repositories only need the
// globally-provided DRIZZLE token, so providing the class directly in
// each module (rather than importing the other module) is safe and
// matches the "single repository, global DRIZZLE" pattern already
// used across the codebase.
@Module({
  imports: [AuthModule, ProjectsModule, AccessModule, GrantsModule],
  controllers: [SessionsController],
  providers: [
    SessionRepository,
    MemoryRepository,
    SessionsApplicationService,
    SessionIdleSweepService,
    JobQueueRepository,
  ],
  exports: [SessionRepository, SessionsApplicationService],
})
export class SessionsModule {}
