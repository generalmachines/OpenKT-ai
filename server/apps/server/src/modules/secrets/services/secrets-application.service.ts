import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  ORG_REPOSITORY,
  SECRET_REPOSITORY,
  type OrgRepository,
  type SecretRepository,
} from "@openkt/data-repositories";
import { requireOrgAccess } from "@openkt/auth-authorization";
import { NotFoundDomainError } from "@openkt/core-errors";

@Injectable()
export class SecretsApplicationService {
  constructor(
    @Inject(SECRET_REPOSITORY)
    private readonly secretRepository: SecretRepository,
    @Inject(ORG_REPOSITORY) private readonly orgRepository: OrgRepository,
  ) {}

  async listOrgSecrets(context: ActorContext, orgSlug: string) {
    const orgId = await this.orgRepository.findIdBySlug(context, orgSlug);
    if (!orgId) {
      throw new NotFoundDomainError("org");
    }
    await requireOrgAccess(context, orgId, "admin");
    return this.secretRepository.listOrgSecretMetadata(context, orgId);
  }
}
