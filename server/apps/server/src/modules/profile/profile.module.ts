import { Module } from "@nestjs/common";

import { PROFILE_REPOSITORY } from "@openkt/data-repositories";

import { AuthModule } from "../auth/auth.module";
import {
  ProfileController,
  ProfileMeController,
} from "./controllers/profile.controller";
import { DrizzleProfileRepository } from "./repositories/drizzle-profile.repository";
import { ProfileApplicationService } from "./services/profile-application.service";

@Module({
  imports: [AuthModule],
  controllers: [ProfileController, ProfileMeController],
  providers: [
    ProfileApplicationService,
    DrizzleProfileRepository,
    {
      provide: PROFILE_REPOSITORY,
      useExisting: DrizzleProfileRepository,
    },
  ],
  exports: [ProfileApplicationService, PROFILE_REPOSITORY],
})
export class ProfileModule {}
