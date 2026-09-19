import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  ORG_REPOSITORY,
  type CreateOrgRecord,
  type OrgRepository,
} from "@openkt/data-repositories";
import { NotFoundDomainError } from "@openkt/core-errors";
import { requireOrgAccess } from "@openkt/auth-authorization";

@Injectable()
export class OrgsApplicationService {
  constructor(
    @Inject(ORG_REPOSITORY) private readonly orgRepository: OrgRepository,
  ) {}

  create(context: ActorContext, input: CreateOrgRecord) {
    return this.orgRepository.create(context, input);
  }

  listMine(context: ActorContext) {
    return this.orgRepository.listMine(context);
  }

  async getBySlug(context: ActorContext, slug: string) {
    const org = await this.orgRepository.findBySlug(context, slug);
    if (!org) {
      throw new NotFoundDomainError("org");
    }
    return org;
  }

  async listMembers(context: ActorContext, slug: string) {
    const orgId = await this.orgRepository.findIdBySlug(context, slug);
    if (!orgId) {
      throw new NotFoundDomainError("org");
    }
    await requireOrgAccess(context, orgId, "read");
    const members = await this.orgRepository.listMembers(context, orgId);
    return {
      orgId,
      members,
    };
  }
}
