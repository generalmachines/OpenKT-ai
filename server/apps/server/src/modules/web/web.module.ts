import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module";
import { AuthModule } from "../auth/auth.module";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { TeamsModule } from "../teams/teams.module";
import { WebController } from "./controllers/web.controller";
import { WebSessionService } from "./services/web-session.service";

// Server-rendered pages for people with no app installed: join a team by
// link (/join/<code>) and connect an AI tool (/connect). See WebController.
@Module({
  imports: [AuthModule, AccountsModule, PersonalTokensModule, TeamsModule],
  controllers: [WebController],
  providers: [WebSessionService],
})
export class WebModule {}
