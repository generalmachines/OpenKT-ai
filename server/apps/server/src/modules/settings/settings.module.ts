import { Module } from "@nestjs/common";

import {
  ORG_REPOSITORY,
  SETTINGS_REPOSITORY,
} from "@openkt/data-repositories";

import { AuthModule } from "../auth/auth.module";
import { DrizzleOrgRepository } from "../orgs/repositories/drizzle-org.repository";
import { SettingsController } from "./controllers/settings.controller";
import { DrizzleSettingsRepository } from "./repositories/drizzle-settings.repository";
import { SettingsApplicationService } from "./services/settings-application.service";

@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [
    SettingsApplicationService,
    DrizzleSettingsRepository,
    DrizzleOrgRepository,
    {
      provide: SETTINGS_REPOSITORY,
      useExisting: DrizzleSettingsRepository,
    },
    {
      provide: ORG_REPOSITORY,
      useExisting: DrizzleOrgRepository,
    },
  ],
  exports: [SettingsApplicationService, SETTINGS_REPOSITORY],
})
export class SettingsModule {}
