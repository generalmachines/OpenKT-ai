import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { BearerAuthGuard } from "../auth/guards/bearer-auth.guard";
import { BriefingModule } from "../briefing/briefing.module";
import { MemoryModule } from "../memory/memory.module";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { ProjectsModule } from "../projects/projects.module";
import { SessionsModule } from "../sessions/sessions.module";
import { GrantsModule } from "../grants/grants.module";
import { SkillsModule } from "../skills/skills.module";
import { TeamsModule } from "../teams/teams.module";
import { McpController } from "./controllers/mcp.controller";
import { McpServerFactoryService } from "./services/mcp-server-factory.service";
import { McpUiRendererService } from "./services/mcp-ui-renderer.service";

// Streamable-HTTP MCP transport for OpenKT clients (Claude Code,
// Claude.ai connector, Cursor, Codex, OpenCode, headless agents).
// One canonical URL — api.openkt.ai/mcp — auth via either Supabase JWT
// or `okt_pat_…` personal access token.
//
// BearerAuthGuard is provided HERE (not in AuthModule) so the guard's
// dependencies — PrincipalResolutionService + PersonalTokensService —
// resolve in the same DI scope without circular module imports.
@Module({
  imports: [
    AuthModule,
    PersonalTokensModule,
    MemoryModule,
    ProjectsModule,
    BriefingModule,
    SessionsModule,
    GrantsModule,
    SkillsModule,
    TeamsModule,
  ],
  controllers: [McpController],
  providers: [McpServerFactoryService, McpUiRendererService, BearerAuthGuard],
})
export class McpModule {}
