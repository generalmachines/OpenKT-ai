import { SetMetadata } from "@nestjs/common";

import type { OrgRole } from "@openkt/data-repositories";

export const ORG_ROLE_METADATA_KEY = "openkt:require-org-role";

// Marks a route handler as requiring at least the given org role
// (hierarchy: owner > admin > member). Used by RequireOrgRoleGuard
// which also resolves the target org from body / params.
export const RequireOrgRole = (role: OrgRole): MethodDecorator & ClassDecorator =>
  SetMetadata(ORG_ROLE_METADATA_KEY, role);
