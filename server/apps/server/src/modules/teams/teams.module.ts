import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { GrantsModule } from "../grants/grants.module";
import { ProjectsModule } from "../projects/projects.module";
import { JoinController, ProjectJoinLinksController } from "./controllers/join-links.controller";
import { JoinLinkRepository } from "./repositories/join-link.repository";
import { TeamsService } from "./services/teams.service";

// Teams = shared spaces people join by link. REST under /v1/projects/:id/
// join-links and /v1/join; MCP tools in ./mcp/team-tools.ts; the zero-install
// pages (/join/<code>, /connect) in modules/web.
@Module({
  imports: [AuthModule, GrantsModule, ProjectsModule],
  controllers: [ProjectJoinLinksController, JoinController],
  providers: [JoinLinkRepository, TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
