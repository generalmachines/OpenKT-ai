import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { BearerAuthGuard } from "../auth/guards/bearer-auth.guard";
import { GrantsModule } from "../grants/grants.module";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { ProjectsModule } from "../projects/projects.module";
import { SkillsModule } from "../skills/skills.module";
import { AccountsController } from "./controllers/accounts.controller";
import { AccountsService } from "./services/accounts.service";
import { fetchJwksOverHttp } from "../auth/services/jwks-key-cache";
import { GOOGLE_JWKS_FETCHER, GoogleIdTokenVerifier } from "./services/google-id-token-verifier.service";
import { LoginAttemptsService } from "./services/login-attempts.service";

// Built-in accounts — email + password, Google sign-in — behind /v1/auth/*.
// Lives outside AuthModule because it needs PersonalTokensModule (sessions are
// access tokens), which itself imports AuthModule. BearerAuthGuard is provided
// here for the same reason McpModule provides its own: the guard's
// dependencies must resolve in the module that uses it.
@Module({
  imports: [AuthModule, PersonalTokensModule, ProjectsModule, GrantsModule, SkillsModule],
  controllers: [AccountsController],
  providers: [
    AccountsService,
    LoginAttemptsService,
    GoogleIdTokenVerifier,
    // Its own provider so tests can swap in a fetcher that serves a local key.
    { provide: GOOGLE_JWKS_FETCHER, useValue: fetchJwksOverHttp },
    BearerAuthGuard,
  ],
  exports: [AccountsService],
})
export class AccountsModule {}
