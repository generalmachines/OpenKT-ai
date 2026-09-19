import { Module } from "@nestjs/common";

import { ORG_REPOSITORY } from "@openkt/data-repositories";

import { AuthModule } from "../auth/auth.module";
import { OrgsController } from "./controllers/orgs.controller";
import { DrizzleOrgRepository } from "./repositories/drizzle-org.repository";
import { OrgsApplicationService } from "./services/orgs-application.service";

// ORG_REPOSITORY bound to the Drizzle implementation. The historical
// SupabaseOrgRepository is gone — DATABASE_URL controls which
// Postgres the Drizzle layer talks to.
@Module({
  imports: [AuthModule],
  controllers: [OrgsController],
  providers: [
    OrgsApplicationService,
    DrizzleOrgRepository,
    {
      provide: ORG_REPOSITORY,
      useExisting: DrizzleOrgRepository,
    },
  ],
  exports: [OrgsApplicationService, ORG_REPOSITORY],
})
export class OrgsModule {}
