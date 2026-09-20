import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { ProjectGrantsController } from "./controllers/project-grants.controller";
import { SessionGrantsController } from "./controllers/session-grants.controller";
import { GrantRepository } from "./repositories/grant.repository";
import { GrantsApplicationService } from "./services/grants-application.service";

@Module({
  imports: [AuthModule, AccessModule],
  controllers: [ProjectGrantsController, SessionGrantsController],
  providers: [GrantRepository, GrantsApplicationService],
  exports: [GrantRepository, GrantsApplicationService],
})
export class GrantsModule {}
