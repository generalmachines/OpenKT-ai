import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError, NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";
import type { ProjectRecord } from "@openkt/data-repositories";

import type { JoinLink } from "../../../db/schema";
import { GrantRepository } from "../../grants/repositories/grant.repository";
import { GrantsApplicationService } from "../../grants/services/grants-application.service";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { ProjectsApplicationService } from "../../projects/services/projects-application.service";
import {
  DEFAULT_LINK_DAYS,
  JoinCodeSchema,
  type JoinLinkView,
  type JoinPreview,
  type JoinResult,
  type JoinRole,
} from "../contracts/join-link.contract";
import { isUsable, JoinLinkRepository } from "../repositories/join-link.repository";

export interface TeamView {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "editor" | "reader";
  // Only the owner sees a team's links.
  links: JoinLinkView[] | null;
}

const NOT_FOUND = "join link not found — it may have expired or been used up";

// Teams, as people use them: a team is a shared space. Its owner (or an
// editor) makes a join link; whoever opens it and signs in gets a grant on
// the space through GrantsApplicationService — the same row an owner's
// share by email creates — and from then on recalls and saves there.
@Injectable()
export class TeamsService {
  constructor(
    private readonly links: JoinLinkRepository,
    private readonly grants: GrantsApplicationService,
    private readonly grantRepository: GrantRepository,
    private readonly projectScope: ProjectScopeService,
    private readonly projects: ProjectsApplicationService,
    private readonly config: ConfigService,
  ) {}

  joinUrl(code: string): string {
    const base = (this.config.get<string>("OPENKT_PUBLIC_URL") ?? "https://api.openkt.ai").replace(/\/+$/, "");
    return `${base}/join/${code}`;
  }

  mcpUrl(): string {
    return this.config.get<string>("OPENKT_MCP_URL") ?? "https://mcp.openkt.ai/mcp";
  }

  // Owner or editor. A personal space is never shared by link.
  async createLink(
    context: ActorContext,
    projectId: string,
    input: { role: JoinRole; expires_in_days?: number | null; max_uses?: number | null },
  ): Promise<JoinLinkView> {
    const userId = requireUser(context);
    const project = await this.requireTeamSpace(context, projectId, "write");
    const days = input.expires_in_days ?? DEFAULT_LINK_DAYS;
    const link = await this.links.create({
      projectId: project.id,
      role: input.role,
      createdBy: userId,
      expiresAt: new Date(Date.now() + days * 86_400_000),
      maxUses: input.max_uses ?? null,
    });
    return this.view(link);
  }

  // Owner only.
  async listLinks(context: ActorContext, projectId: string): Promise<JoinLinkView[]> {
    await this.requireOwner(context, projectId);
    return (await this.links.listForProject(projectId)).map((l) => this.view(l));
  }

  // Owner only.
  async revokeLink(context: ActorContext, projectId: string, code: string): Promise<{ revoked: boolean }> {
    await this.requireOwner(context, projectId);
    return { revoked: await this.links.remove(projectId, code) };
  }

  // No sign-in needed: what the join page shows before anyone signs up. The
  // inviter is named by display name only, never by email.
  async preview(code: string): Promise<JoinPreview> {
    const found = JoinCodeSchema.safeParse(code).success ? await this.links.find(code) : null;
    if (!found?.usable) throw new NotFoundDomainError(NOT_FOUND);
    return {
      space_name: found.spaceName,
      inviter_name: found.inviterName?.trim() || "A teammate",
      role: found.link.role as JoinRole,
    };
  }

  // Someone already in the space (the owner, or a member with the link's role
  // or better) gets their role back even from a used-up or expired link, and
  // uses nothing up; everyone else needs a link that still works.
  async join(context: ActorContext, codeOrUrl: string): Promise<JoinResult> {
    const userId = requireUser(context);
    const code = parseJoinCode(codeOrUrl);
    const found = code ? await this.links.find(code) : null;
    if (!code || !found) throw new NotFoundDomainError(NOT_FOUND);
    const result = await this.grants.grantByJoinLink(
      "project",
      found.link.projectId,
      userId,
      found.link.role as JoinRole,
      found.link.createdBy,
      () => this.links.claim(code),
    );
    if (!result) throw new NotFoundDomainError(NOT_FOUND);
    return {
      space: { id: found.link.projectId, name: found.spaceName },
      role: result.role,
    };
  }

  // One call: a new team space owned by the caller, plus an editor link to share.
  async createTeam(
    context: ActorContext,
    name: string,
  ): Promise<{ space: { id: string; name: string; slug: string }; link: JoinLinkView }> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw new ValidationDomainError("team name must be 1-120 characters");
    const project = await this.projects.create(context, { name: trimmed, visibility: "personal", orgId: null });
    const link = await this.createLink(context, project.id, { role: "editor" });
    return { space: { id: project.id, name: project.name, slug: project.slug }, link };
  }

  // The link to share for a space: the caller's own unlimited link for that
  // role if one is still good for a day, else a new one.
  async inviteLink(context: ActorContext, projectRef: string, role: JoinRole = "editor"): Promise<JoinLinkView> {
    const userId = requireUser(context);
    const projectId = await this.projectScope.resolveProjectIdOrSlug(context, projectRef);
    const project = await this.requireTeamSpace(context, projectId, "write");
    const existing = await this.links.findReusable(project.id, userId, role);
    if (existing) return this.view(existing);
    return this.createLink(context, project.id, { role });
  }

  // Every space the caller can open except their personal one, with their
  // role; the owner also gets the links.
  async listTeams(context: ActorContext): Promise<TeamView[]> {
    const userId = requireUser(context);
    const visible = await this.projects.listVisible(context, {});
    const roles = await this.grantRepository.listUserRoles("project", userId);
    const out: TeamView[] = [];
    for (const project of visible) {
      if (isPersonalSpace(project)) continue;
      const owner = project.ownerUserId === userId;
      const role = owner ? "owner" : roles.get(project.id) === "editor" ? "editor" : "reader";
      const links = owner
        ? (await this.links.listForProject(project.id)).filter((l) => isUsable(l)).map((l) => this.view(l))
        : null;
      out.push({ id: project.id, name: project.name, slug: project.slug, role, links });
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────

  private async requireTeamSpace(
    context: ActorContext,
    projectId: string,
    mode: "read" | "write",
  ): Promise<ProjectRecord> {
    await this.projectScope.requireProjectAccess(context, projectId, mode);
    const project = await this.projects.getById(context, projectId);
    if (isPersonalSpace(project)) {
      throw new ValidationDomainError("a personal space cannot be shared by link — create a team instead");
    }
    return project;
  }

  private async requireOwner(context: ActorContext, projectId: string): Promise<void> {
    const access = await this.projectScope.requireProjectAccess(context, projectId, "read");
    if (access.ownerUserId !== requireUser(context)) {
      throw new ForbiddenDomainError("only the space owner can see or delete its join links");
    }
  }

  private view(link: JoinLink): JoinLinkView {
    return {
      code: link.code,
      url: this.joinUrl(link.code),
      space_id: link.projectId,
      role: link.role as JoinRole,
      created_by: link.createdBy,
      created_at: iso(link.createdAt),
      expires_at: link.expiresAt ? iso(link.expiresAt) : null,
      max_uses: link.maxUses,
      uses: link.uses,
      active: isUsable(link),
    };
  }
}

// "AbCdE12345", ".../join/AbCdE12345", "https://api.openkt.ai/join/AbCdE12345?x" → the code.
export function parseJoinCode(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /\/join\/([A-Za-z0-9]+)/.exec(trimmed)?.[1];
  const candidate = fromUrl ?? trimmed;
  return JoinCodeSchema.safeParse(candidate).success ? candidate : null;
}

// The personal space is the one marked `is_personal` (see
// ProjectScopeService.resolvePersonalProjectId), never inferred from its slug.
export function isPersonalSpace(project: Pick<ProjectRecord, "isPersonal">): boolean {
  return project.isPersonal;
}

function requireUser(context: ActorContext): string {
  const userId = context.principal.userId;
  if (!userId) throw new ValidationDomainError("user principal required");
  return userId;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
