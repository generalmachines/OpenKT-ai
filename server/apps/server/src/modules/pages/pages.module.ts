import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { JobQueueRepository } from "../jobs/repositories/job-queue.repository";
import { ProjectsModule } from "../projects/projects.module";
import { PagesController } from "./controllers/pages.controller";
import { PageRepository } from "./repositories/page.repository";
import { PagesApplicationService } from "./services/pages-application.service";

// Living pages and briefs. Written by job results (modules/jobs) and by people (a section edit);
// read over REST, by kt_page / kt_session_start, and by recall.
@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [PagesController],
  providers: [PageRepository, JobQueueRepository, PagesApplicationService],
  exports: [PagesApplicationService, PageRepository],
})
export class PagesModule {}
