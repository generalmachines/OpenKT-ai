import { Injectable, NotFoundException } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";

import type {
  MemberDetailPayload,
  MembersListPayload,
  MembersMixPayload,
} from "../contracts/member-knowledge.contract";
import { LocalPgMemberKnowledgeRepository } from "../repositories/local-pg-member-knowledge.repository";

@Injectable()
export class MemberKnowledgeApplicationService {
  constructor(private readonly repo: LocalPgMemberKnowledgeRepository) {}

  async listMembers(
    context: ActorContext,
    projectId: string,
    limit: number,
  ): Promise<MembersListPayload> {
    const data = await this.repo.listContributors(context, projectId, limit);
    return {
      data,
      meta: {
        project_id: projectId,
        total: data.length,
      },
    };
  }

  async getMember(
    context: ActorContext,
    projectId: string,
    userId: string,
  ): Promise<MemberDetailPayload> {
    const detail = await this.repo.getMember(context, projectId, userId);
    if (!detail) {
      throw new NotFoundException(
        `member ${userId} has no knowledge in project ${projectId}`,
      );
    }
    return detail;
  }

  async mixMembers(
    context: ActorContext,
    projectId: string,
    userIds: string[],
    limit: number,
  ): Promise<MembersMixPayload> {
    const { items, total } = await this.repo.mixMemories(
      context,
      projectId,
      userIds,
      limit,
    );
    return {
      data: items,
      meta: {
        project_id: projectId,
        user_ids: userIds,
        total,
      },
    };
  }
}
