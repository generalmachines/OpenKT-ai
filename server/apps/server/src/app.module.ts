import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { validateApiEnvironment } from "@openkt/platform-config";
import { buildHttpLoggerConfig } from "@openkt/platform-logging";

import { AppExceptionFilter } from "./common/filters/app-exception.filter";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor";
import { RequestMetadataInterceptor } from "./common/interceptors/request-metadata.interceptor";
import { SnakeCaseResponseInterceptor } from "./common/interceptors/snake-case-response.interceptor";
import { requestIdMiddleware } from "./common/middleware/request-id.middleware";
import { DrizzleModule } from "./db/drizzle.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { RateLimitModule } from "./modules/rate-limit/rate-limit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { BriefingModule } from "./modules/briefing/briefing.module";
import { BriefingsModule } from "./modules/briefings/briefings.module";
import { CaptureModule } from "./modules/capture/capture.module";
import { HealthModule } from "./modules/health/health.module";
import { InternalModule } from "./modules/internal/internal.module";
import { InvitesModule } from "./modules/invites/invites.module";
import { McpModule } from "./modules/mcp/mcp.module";
import { LlmConfigsModule } from "./modules/llm-configs/llm-configs.module";
import { MemoryModule } from "./modules/memory/memory.module";
import { OrgsModule } from "./modules/orgs/orgs.module";
import { ObservabilityModule } from "./modules/observability/observability.module";
import { ProfileModule } from "./modules/profile/profile.module";
import { PrimeModule } from "./modules/prime/prime.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { MemberKnowledgeModule } from "./modules/member-knowledge/member-knowledge.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { PersonalTokensModule } from "./modules/personal-tokens/personal-tokens.module";
import { ConnectorsModule } from "./modules/connectors/connectors.module";
import { OauthModule } from "./modules/oauth/oauth.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { GrantsModule } from "./modules/grants/grants.module";
import { AccessModule } from "./modules/access/access.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { SkillsModule } from "./modules/skills/skills.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateApiEnvironment,
      envFilePath: [".env.local", ".env"],
    }),
    LoggerModule.forRoot(buildHttpLoggerConfig("server")),
    DrizzleModule,
    AuthModule,
    AuditModule,
    HealthModule,
    InternalModule,
    MemoryModule,
    PrimeModule,
    OrgsModule,
    ObservabilityModule,
    ProjectsModule,
    ProfileModule,
    SettingsModule,
    InvitesModule,
    LlmConfigsModule,
    McpModule,
    BriefingsModule,
    BriefingModule,
    CaptureModule,
    MemberKnowledgeModule,
    RateLimitModule,
    AnalyticsModule,
    PersonalTokensModule,
    ConnectorsModule,
    OauthModule,
    SessionsModule,
    GrantsModule,
    SkillsModule,
    AccessModule,
    AccountsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AppExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestMetadataInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
    // Last in the chain so audit + metadata see the internal camel
    // shape, but the response that finally goes out is snake-cased
    // per the v1 wire contract.
    {
      provide: APP_INTERCEPTOR,
      useClass: SnakeCaseResponseInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware).forRoutes("*");
  }
}
