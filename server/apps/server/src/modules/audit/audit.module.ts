import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { RequireOrgRoleGuard } from "../invites/guards/require-org-role.guard";
import { AuditController } from "./controllers/audit.controller";
import { AuditQueryService } from "./services/audit-query.service";
import { AuditService } from "./services/audit.service";

// AuditModule is `@Global()` so any other module can inject
// `AuditService` without re-importing it. The query side
// (`AuditController` + `AuditQueryService`) is self-contained.
//
// We also re-provide `RequireOrgRoleGuard` here because the controller
// uses it directly; the guard's only state is a Drizzle handle which
// is global, so providing it again is safe.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService, AuditQueryService, RequireOrgRoleGuard],
  exports: [AuditService],
})
export class AuditModule {}
