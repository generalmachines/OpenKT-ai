import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  ORG_REPOSITORY,
  PROJECT_REPOSITORY,
  type CreateProjectRecord,
  type OrgRepository,
  type ProjectListFilters,
  type ProjectRepository,
} from "@openkt/data-repositories";
import { requireOrgAccess } from "@openkt/auth-authorization";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

@Injectable()
export class ProjectsApplicationService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(ORG_REPOSITORY) private readonly orgRepository: OrgRepository,
  ) {}

  async create(context: ActorContext, input: CreateProjectRecord) {
    if (input.visibility === "personal" && input.orgId !== null) {
      throw new ValidationDomainError("personal projects must not include orgId");
    }
    if (input.visibility === "org" && !input.orgId) {
      throw new ValidationDomainError("org projects require orgId");
    }
    if (input.orgId) {
      await requireOrgAccess(context, input.orgId, "write");
    }
    return this.projectRepository.create(context, input);
  }

  listVisible(context: ActorContext, filters: ProjectListFilters) {
    return this.projectRepository.listVisible(context, filters);
  }

  async getById(context: ActorContext, projectId: string) {
    const project = await this.projectRepository.findById(context, projectId);
    if (!project) {
      throw new NotFoundDomainError("project");
    }

    const viewerRole = await this.projectRepository.findViewerRole(context, projectId);
    return {
      ...project,
      viewerRole,
    };
  }

  async getBySlug(
    context: ActorContext,
    accountSlug: string,
    projectSlug: string,
  ) {
    const project = await this.projectRepository.findBySlug(context, accountSlug, projectSlug);
    if (!project) {
      throw new NotFoundDomainError("project");
    }

    const viewerRole = await this.projectRepository.findViewerRole(context, project.id);
    const orgId = project.orgId
      ? await this.orgRepository.findIdBySlug(context, accountSlug)
      : null;

    return {
      ...project,
      viewerRole,
      accountSlug,
      orgId,
    };
  }
}
