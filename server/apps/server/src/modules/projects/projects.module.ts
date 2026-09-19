import { Module } from "@nestjs/common";

import { ORG_REPOSITORY, PROJECT_REPOSITORY } from "@openkt/data-repositories";

import { AuthModule } from "../auth/auth.module";
import { DrizzleOrgRepository } from "../orgs/repositories/drizzle-org.repository";
import { ProjectsController } from "./controllers/projects.controller";
import { DrizzleProjectRepository } from "./repositories/drizzle-project.repository";
import { ProjectsApplicationService } from "./services/projects-application.service";
import { ProjectScopeService } from "./services/project-scope.service";

@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsApplicationService,
    ProjectScopeService,
    DrizzleProjectRepository,
    DrizzleOrgRepository,
    {
      provide: PROJECT_REPOSITORY,
      useExisting: DrizzleProjectRepository,
    },
    {
      provide: ORG_REPOSITORY,
      useExisting: DrizzleOrgRepository,
    },
  ],
  exports: [ProjectsApplicationService, ProjectScopeService, PROJECT_REPOSITORY],
})
export class ProjectsModule {}
