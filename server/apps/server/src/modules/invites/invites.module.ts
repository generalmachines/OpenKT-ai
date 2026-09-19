import { Module } from "@nestjs/common";

import { INVITE_REPOSITORY } from "@openkt/data-repositories";

import { AuthModule } from "../auth/auth.module";
import { OrgsModule } from "../orgs/orgs.module";
import { InvitesController } from "./controllers/invites.controller";
import { RequireOrgRoleGuard } from "./guards/require-org-role.guard";
import { DrizzleInviteRepository } from "./repositories/drizzle-invite.repository";
import { InvitesApplicationService } from "./services/invites-application.service";

@Module({
  imports: [AuthModule, OrgsModule],
  controllers: [InvitesController],
  providers: [
    InvitesApplicationService,
    DrizzleInviteRepository,
    RequireOrgRoleGuard,
    {
      provide: INVITE_REPOSITORY,
      useExisting: DrizzleInviteRepository,
    },
  ],
  exports: [InvitesApplicationService, INVITE_REPOSITORY],
})
export class InvitesModule {}
