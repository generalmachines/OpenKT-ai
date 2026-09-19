import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PageRepository } from "../pages/repositories/page.repository";
import { SessionRepository } from "../sessions/repositories/session.repository";
import { JobsController } from "./controllers/jobs.controller";
import { JobQueueRepository } from "./repositories/job-queue.repository";
import { JobsApplicationService } from "./services/jobs-application.service";
import { SessionResultApplier } from "./services/session-result.applier";

// Background work, run on members' Macs (the server stores, shares and serves; the model work of a
// job happens on a device with the local model). The repositories need only the global DRIZZLE
// token, so they are provided here directly rather than imported from their modules.
@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [JobQueueRepository, PageRepository, SessionRepository, SessionResultApplier, JobsApplicationService],
  exports: [JobQueueRepository],
})
export class JobsModule {}
