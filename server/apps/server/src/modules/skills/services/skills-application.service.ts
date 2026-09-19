import { Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError, NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import { AccessScopeService } from "../../access/services/access-scope.service";
import type { GrantRole } from "../../grants/contracts/grant.contract";
import { GrantRepository } from "../../grants/repositories/grant.repository";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import type {
  CreateSkillInput,
  ListSkillsQuery,
  PatchSkillInput,
  SaveSkillVersionInput,
  SkillDetail,
  SkillFileView,
  SkillRole,
  SkillSummary,
  SkillSurface,
  SkillVersionDetail,
  SkillVersionSummary,
} from "../contracts/skill.contract";
import { SkillRepository, type SkillRow, type SkillVersionRow } from "../repositories/skill.repository";
import {
  SKILL_LIMITS,
  SKILL_MD,
  bytesOf,
  slugify,
  starterSkillMd,
  validateSkillFiles,
  type SkillFile,
  type ValidatedSkill,
} from "./skill-files";
import { STARTER_SKILL_MD, STARTER_SKILL_TITLE } from "./starter-skill";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RANK: Record<SkillRole, number> = { reader: 1, editor: 2, owner: 3 };
const best = (a: SkillRole | null, b: SkillRole | null): SkillRole | null =>
  !a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b;

// Who may do what (Spec 04 "Skills"):
//   read  — the owner; anyone who can read the skill's space; anyone holding a
//           grant on the skill.
//   edit  — the owner; editor/owner grant on the skill; editor/owner on the space.
//   grants, delete — the owner, and nobody else. `my_role: "owner"` therefore
//           means the literal owner; an `owner` grant reads as `editor` here,
//           exactly as it does for a space's access list.
// A skill the caller cannot read is a 404, never a 403.
@Injectable()
export class SkillsApplicationService {
  private readonly logger = new Logger(SkillsApplicationService.name);

  constructor(
    private readonly skillRepository: SkillRepository,
    private readonly projectScope: ProjectScopeService,
    private readonly accessScope: AccessScopeService,
    private readonly grantRepository: GrantRepository,
  ) {}

  async list(context: ActorContext, query: ListSkillsQuery & { slug?: string }): Promise<SkillSummary[]> {
    const userId = this.requireUser(context);
    const projectId = query.project_id
      ? await this.projectScope.resolveProjectIdOrSlug(context, query.project_id)
      : undefined;
    if (projectId) await this.projectScope.requireProjectAccess(context, projectId, "read");

    const scope = await this.accessScope.visibleScope(context);
    const rows = await this.skillRepository.listVisible(userId, scope.projectIds, {
      projectId,
      q: query.q || undefined,
      slug: query.slug,
      archived: query.archived ?? false,
    });

    // One lookup for every grant, one per distinct space — not one per row.
    const grantRoles = await this.grantRepository.listUserRoles("skill", userId);
    const spaceRoles = new Map<string, SkillRole | null>();
    const out: SkillSummary[] = [];
    for (const row of rows) {
      const role = await this.roleOn(context, row, spaceRoles, grantRoles);
      if (role) out.push(this.toSummary(row, role.role, role.spaceVisible));
    }
    return out;
  }

  async create(context: ActorContext, input: CreateSkillInput): Promise<SkillDetail> {
    const userId = this.requireUser(context);

    let projectId: string | null = null;
    let orgId: string | null = null;
    if (input.project_id) {
      projectId = await this.projectScope.resolveProjectIdOrSlug(context, input.project_id);
      orgId = (await this.projectScope.requireProjectAccess(context, projectId, "write")).orgId;
    }

    let files: SkillFile[];
    if (input.files) files = input.files;
    else if (input.skill_md !== undefined) files = [{ path: SKILL_MD, content: input.skill_md }];
    else files = [{ path: SKILL_MD, content: starterSkillMd(input.title, await this.freeSlug(userId, projectId, input.title)) }];

    const validated = validateSkillFiles(files);
    const id = await this.skillRepository.create({
      ownerUserId: userId,
      orgId,
      projectId,
      card: { slug: validated.name, title: input.title, description: validated.description },
      files: validated.files,
      changeNote: input.change_note ?? null,
    });
    return this.get(context, id);
  }

  async get(context: ActorContext, skillId: string): Promise<SkillDetail> {
    const { row, role, spaceVisible } = await this.requireReadable(context, skillId);
    const [current, versions] = await Promise.all([
      this.skillRepository.findVersion(skillId, row.skill.currentVersion),
      this.skillRepository.listVersions(skillId),
    ]);
    return {
      ...this.toSummary(row, role, spaceVisible),
      files: toFileViews(current?.version.files ?? []),
      versions: versions.map(toVersionSummary),
    };
  }

  async getVersion(context: ActorContext, skillId: string, version: number): Promise<SkillVersionDetail> {
    await this.requireReadable(context, skillId);
    const found = await this.skillRepository.findVersion(skillId, version);
    if (!found) throw new NotFoundDomainError("skill version");
    return { skill_id: skillId, ...toVersionSummary(found), files: toFileViews(found.version.files) };
  }

  async saveVersion(context: ActorContext, skillId: string, input: SaveSkillVersionInput): Promise<SkillDetail> {
    const userId = this.requireUser(context);
    const { row } = await this.requireEditable(context, skillId);
    const validated = validateSkillFiles(input.files);
    await this.skillRepository.saveVersion({
      skillId,
      baseVersion: input.base_version,
      card: this.cardFrom(validated, input.title ?? null, row.skill.title),
      files: validated.files,
      changeNote: input.change_note ?? null,
      createdBy: userId,
    });
    return this.get(context, skillId);
  }

  // Restoring never rewrites history: the old files become a NEW version.
  async restore(context: ActorContext, skillId: string, version: number): Promise<SkillDetail> {
    const userId = this.requireUser(context);
    const { row } = await this.requireEditable(context, skillId);
    const found = await this.skillRepository.findVersion(skillId, version);
    if (!found) throw new NotFoundDomainError("skill version");
    const validated = validateSkillFiles(found.version.files);
    await this.skillRepository.saveVersion({
      skillId,
      baseVersion: row.skill.currentVersion,
      card: this.cardFrom(validated, null, row.skill.title),
      files: validated.files,
      changeNote: `Restored v${version}`,
      createdBy: userId,
    });
    return this.get(context, skillId);
  }

  async patch(context: ActorContext, skillId: string, input: PatchSkillInput): Promise<SkillDetail> {
    const { row } = await this.requireEditable(context, skillId);
    const changes: { projectId?: string | null; orgId?: string | null; archived?: boolean } = {};
    if (input.archived !== undefined) changes.archived = input.archived;
    if (input.project_id !== undefined) {
      if (input.project_id === null) {
        changes.projectId = null;
        changes.orgId = null;
      } else {
        const projectId = await this.projectScope.resolveProjectIdOrSlug(context, input.project_id);
        if (projectId !== row.skill.projectId) {
          // Filing a skill in a space is a write to that space.
          const access = await this.projectScope.requireProjectAccess(context, projectId, "write");
          changes.projectId = projectId;
          changes.orgId = access.orgId;
        }
      }
    }
    await this.skillRepository.patch(skillId, changes);
    return this.get(context, skillId);
  }

  async delete(context: ActorContext, skillId: string): Promise<{ deleted: true }> {
    const { role } = await this.requireReadable(context, skillId);
    if (role !== "owner") throw new ForbiddenDomainError("only the skill owner can delete it");
    await this.skillRepository.delete(skillId);
    await this.grantRepository.removeAllForResource("skill", skillId);
    return { deleted: true };
  }

  // Counts one use and hands back the content, so a caller gets both in one call.
  async recordRun(
    context: ActorContext,
    skillId: string,
    surface: SkillSurface,
  ): Promise<{ skill: SkillSummary; version: number; files: SkillFileView[] }> {
    const { row, role, spaceVisible } = await this.requireReadable(context, skillId);
    const current = await this.skillRepository.findVersion(skillId, row.skill.currentVersion);
    await this.skillRepository.recordRun(skillId, row.skill.currentVersion, context.principal.userId ?? null, surface);
    const summary = this.toSummary(row, role, spaceVisible);
    return {
      skill: { ...summary, run_count: summary.run_count + 1, run_count_30d: summary.run_count_30d + 1 },
      version: row.skill.currentVersion,
      files: toFileViews(current?.version.files ?? []),
    };
  }

  async exportFiles(context: ActorContext, skillId: string): Promise<{ slug: string; version: number; files: SkillFileView[] }> {
    const detail = await this.get(context, skillId);
    return { slug: detail.slug, version: detail.current_version, files: detail.files };
  }

  // The grants routes call this first, so someone who cannot even read the
  // skill gets 404; GrantsApplicationService then answers 403 to a reader.
  async assertReadable(context: ActorContext, skillId: string): Promise<void> {
    await this.requireReadable(context, skillId);
  }

  // For tools, which name a skill the way a person would: by id or by its `name`.
  async resolveId(context: ActorContext, idOrSlug: string, project?: string): Promise<string> {
    const value = idOrSlug.trim();
    if (UUID_RE.test(value)) return value;
    const matches = await this.list(context, { project_id: project, slug: value.toLowerCase(), archived: false });
    if (matches.length === 0) throw new NotFoundDomainError("skill");
    if (matches.length > 1) {
      throw new ValidationDomainError(
        `more than one skill is named "${value}"; pass its id or the space it lives in`,
        { matches: matches.map((m) => ({ id: m.id, space_name: m.space_name, owner: m.owner.display_name })) },
      );
    }
    return matches[0]!.id;
  }

  // Sign-up: one real skill in the new person's own shelf. Never blocks a sign-up.
  async seedStarterSkill(userId: string): Promise<void> {
    try {
      const validated = validateSkillFiles([{ path: SKILL_MD, content: STARTER_SKILL_MD }]);
      if (await this.skillRepository.slugExists(userId, null, validated.name)) return;
      await this.skillRepository.create({
        ownerUserId: userId,
        orgId: null,
        projectId: null,
        card: { slug: validated.name, title: STARTER_SKILL_TITLE, description: validated.description },
        files: validated.files,
        changeNote: "Starter skill",
      });
    } catch (err) {
      this.logger.warn(`[skills] starter skill for user=${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private requireUser(context: ActorContext): string {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");
    return userId;
  }

  // Title: what the caller typed, else the SKILL.md heading, else what it was.
  private cardFrom(validated: ValidatedSkill, title: string | null, previousTitle: string) {
    return {
      slug: validated.name,
      title: (title ?? validated.heading ?? previousTitle).slice(0, SKILL_LIMITS.maxTitleLength),
      description: validated.description,
    };
  }

  private async freeSlug(userId: string, projectId: string | null, title: string): Promise<string> {
    const base = slugify(title);
    for (let n = 1; n <= 50; n++) {
      const suffix = n === 1 ? "" : `-${n}`;
      const candidate = `${base.slice(0, SKILL_LIMITS.maxNameLength - suffix.length)}${suffix}`;
      if (!(await this.skillRepository.slugExists(userId, projectId, candidate))) return candidate;
    }
    return base;
  }

  private async spaceRole(
    context: ActorContext,
    projectId: string,
    cache: Map<string, SkillRole | null>,
  ): Promise<SkillRole | null> {
    if (cache.has(projectId)) return cache.get(projectId)!;
    let role: SkillRole | null = null;
    for (const [mode, granted] of [["write", "editor"], ["read", "reader"]] as const) {
      try {
        await this.projectScope.requireProjectAccess(context, projectId, mode);
        role = granted;
        break;
      } catch (err) {
        if (!(err instanceof NotFoundDomainError)) throw err;
      }
    }
    cache.set(projectId, role);
    return role;
  }

  private async roleOn(
    context: ActorContext,
    row: SkillRow,
    spaceRoles = new Map<string, SkillRole | null>(),
    grantRoles?: Map<string, GrantRole>,
  ): Promise<{ role: SkillRole; spaceVisible: boolean } | null> {
    const userId = context.principal.userId;
    if (!userId) return null;
    const viaSpace = row.skill.projectId ? await this.spaceRole(context, row.skill.projectId, spaceRoles) : null;
    const spaceVisible = viaSpace !== null;
    if (row.skill.ownerUserId === userId) return { role: "owner", spaceVisible };
    const grant = grantRoles
      ? (grantRoles.get(row.skill.id) ?? null)
      : await this.grantRepository.findUserRole("skill", row.skill.id, userId);
    const viaGrant: SkillRole | null = !grant ? null : grant === "reader" ? "reader" : "editor";
    const role = best(viaSpace, viaGrant);
    return role ? { role, spaceVisible } : null;
  }

  private async requireReadable(context: ActorContext, skillId: string) {
    this.requireUser(context);
    const row = await this.skillRepository.findById(skillId);
    const access = row ? await this.roleOn(context, row) : null;
    if (!row || !access) throw new NotFoundDomainError("skill");
    return { row, ...access };
  }

  private async requireEditable(context: ActorContext, skillId: string) {
    const found = await this.requireReadable(context, skillId);
    if (found.role === "reader") throw new ForbiddenDomainError("you can use this skill but not change it");
    return found;
  }

  private toSummary(row: SkillRow, role: SkillRole, spaceVisible: boolean): SkillSummary {
    const s = row.skill;
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      description: s.description,
      project_id: s.projectId,
      // The name of a space is for people who can open that space.
      space_name: spaceVisible ? row.spaceName : null,
      owner: { id: s.ownerUserId, display_name: row.ownerName },
      current_version: s.currentVersion,
      archived: s.archived,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
      run_count: s.runCount,
      run_count_30d: Number(row.runs30d ?? 0),
      my_role: role,
    };
  }
}

function toFileViews(files: readonly SkillFile[]): SkillFileView[] {
  return files.map((f) => ({ path: f.path, content: f.content, bytes: bytesOf(f.content) }));
}

function toVersionSummary(row: SkillVersionRow): SkillVersionSummary {
  return {
    version: row.version.version,
    change_note: row.version.changeNote,
    created_by: { id: row.version.createdBy, display_name: row.authorName },
    created_at: row.version.createdAt.toISOString(),
  };
}
