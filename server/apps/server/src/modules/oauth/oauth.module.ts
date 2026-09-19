import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { OauthAuthorizeController } from "./controllers/authorize.controller";
import { OauthConsentController } from "./controllers/consent.controller";
import { OauthRegisterController } from "./controllers/register.controller";
import { OauthTokenController } from "./controllers/token.controller";
import { OauthWellKnownController } from "./controllers/well-known.controller";
import { OauthService } from "./services/oauth.service";

// OAuth 2.1 + RFC 7591 Dynamic Client Registration for the MCP server.
// Sole consumer today is Claude.ai's "Add custom MCP" form, which
// requires Client ID + Client Secret fields (it can't ride a static
// bearer header). PATs cover every other client (Claude Code, Cursor,
// VS Code, Codex). See migration 0032_oauth.sql for table layout.
@Module({
  imports: [AuthModule, PersonalTokensModule],
  controllers: [
    OauthWellKnownController,
    OauthRegisterController,
    OauthAuthorizeController,
    OauthConsentController,
    OauthTokenController,
  ],
  providers: [OauthService],
  exports: [OauthService],
})
export class OauthModule {}
