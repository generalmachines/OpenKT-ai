import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  ORG_REPOSITORY,
  SETTINGS_REPOSITORY,
  type OrgRepository,
  type SettingsRepository,
} from "@openkt/data-repositories";
import {
  requireOrgAccess,
  requireProjectAccess,
} from "@openkt/auth-authorization";
import { NotFoundDomainError } from "@openkt/core-errors";

@Injectable()
export class SettingsApplicationService {
  constructor(
    @Inject(SETTINGS_REPOSITORY)
    private readonly settingsRepository: SettingsRepository,
    @Inject(ORG_REPOSITORY) private readonly orgRepository: OrgRepository,
  ) {}

  getUser(context: ActorContext) {
    return this.settingsRepository.getUser(context);
  }

  updateUser(context: ActorContext, settings: Record<string, unknown>) {
    return this.settingsRepository.updateUser(context, settings);
  }

  async getProject(context: ActorContext, projectId: string) {
    await requireProjectAccess(context, projectId, "read");
    return this.settingsRepository.getProject(context, projectId);
  }

  async updateProject(
    context: ActorContext,
    projectId: string,
    settings: Record<string, unknown>,
  ) {
    await requireProjectAccess(context, projectId, "admin");
    return this.settingsRepository.updateProject(context, projectId, settings);
  }

  async getOrg(context: ActorContext, orgSlug: string) {
    const orgId = await this.resolveOrgId(context, orgSlug);
    await requireOrgAccess(context, orgId, "read");
    return this.settingsRepository.getOrg(context, orgId);
  }

  async updateOrg(
    context: ActorContext,
    orgSlug: string,
    settings: Record<string, unknown>,
  ) {
    const orgId = await this.resolveOrgId(context, orgSlug);
    await requireOrgAccess(context, orgId, "admin");
    return this.settingsRepository.updateOrg(context, orgId, settings);
  }

  private async resolveOrgId(context: ActorContext, orgSlug: string): Promise<string> {
    const orgId = await this.orgRepository.findIdBySlug(context, orgSlug);
    if (!orgId) {
      throw new NotFoundDomainError("org");
    }
    return orgId;
  }
}
