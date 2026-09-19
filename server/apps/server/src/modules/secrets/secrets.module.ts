import { Module } from "@nestjs/common";

import { ORG_REPOSITORY, SECRET_REPOSITORY } from "@openkt/data-repositories";

import { AuthModule } from "../auth/auth.module";
import { DrizzleOrgRepository } from "../orgs/repositories/drizzle-org.repository";
import { SecretsController } from "./controllers/secrets.controller";
import { DrizzleSecretRepository } from "./repositories/drizzle-secret.repository";
import { SecretsApplicationService } from "./services/secrets-application.service";

@Module({
  imports: [AuthModule],
  controllers: [SecretsController],
  providers: [
    SecretsApplicationService,
    DrizzleSecretRepository,
    DrizzleOrgRepository,
    {
      provide: SECRET_REPOSITORY,
      useExisting: DrizzleSecretRepository,
    },
    {
      provide: ORG_REPOSITORY,
      useExisting: DrizzleOrgRepository,
    },
  ],
  exports: [SecretsApplicationService, SECRET_REPOSITORY],
})
export class SecretsModule {}
