import { Module } from "@nestjs/common";

import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { GrantsModule } from "../grants/grants.module";
import { ProjectsModule } from "../projects/projects.module";
import { SkillsController } from "./controllers/skills.controller";
import { SkillRepository } from "./repositories/skill.repository";
import { SkillsApplicationService } from "./services/skills-application.service";

// Skills: shared, versioned folders of text files (a SKILL.md plus optional
// references), granted like a space. McpModule imports this for the kt_*_skill
// tools; AccountsModule for the starter skill every new account gets.
@Module({
  imports: [AuthModule, ProjectsModule, AccessModule, GrantsModule],
  controllers: [SkillsController],
  providers: [SkillRepository, SkillsApplicationService],
  exports: [SkillsApplicationService],
})
export class SkillsModule {}
