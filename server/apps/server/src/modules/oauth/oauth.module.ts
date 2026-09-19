import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module";
import { AuthModule } from "../auth/auth.module";
import { BearerAuthGuard } from "../auth/guards/bearer-auth.guard";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { OauthAuthorizeController } from "./controllers/authorize.controller";
import { OauthConsentController } from "./controllers/consent.controller";
import { OauthRegisterController } from "./controllers/register.controller";
import { OauthTokenController } from "./controllers/token.controller";
import { OauthWellKnownController } from "./controllers/well-known.controller";
import { OauthFormTokenService } from "./services/oauth-form-token.service";
import { OauthService } from "./services/oauth.service";

// OAuth 2.1 + PKCE + RFC 7591 Dynamic Client Registration for the MCP
// server, so any MCP client — claude.ai and Cowork custom connectors,
// ChatGPT, Codex, Claude Code, Cursor, VS Code — signs in through the
// browser with no token to paste. The sign-in and consent page is served
// by this server (GET/POST /oauth/authorize) on top of the built-in
// accounts; the issued access tokens are ordinary `okt_pat_…` tokens that
// /mcp and /v1/* accept. See migration 0032_oauth.sql for the tables.
//
// BearerAuthGuard is provided here (as in McpModule) so its dependencies
// resolve without a module cycle.
@Module({
  imports: [AuthModule, PersonalTokensModule, AccountsModule],
  controllers: [
    OauthWellKnownController,
    OauthRegisterController,
    OauthAuthorizeController,
    OauthConsentController,
    OauthTokenController,
  ],
  providers: [OauthService, OauthFormTokenService, BearerAuthGuard],
  exports: [OauthService],
})
export class OauthModule {}
