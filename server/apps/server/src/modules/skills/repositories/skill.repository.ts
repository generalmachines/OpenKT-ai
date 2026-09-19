import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { profiles, projects, skillRuns, skills, skillVersions, type Skill, type SkillVersion } from "../../../db/schema";
import type { SkillFile } from "../services/skill-files";

export interface SkillRow {
  skill: Skill;
  spaceName: string | null;
  ownerName: string | null;
  runs30d: number;
}

export interface SkillVersionRow {
  version: SkillVersion;
  authorName: string | null;
}

export interface SkillCardFields {
  slug: string;
  title: string;
  description: string;
}

const runs30d = sql<number>`(
  select count(*)::int from skill_runs r
  where r.skill_id = ${skills.id} and r.created_at > now() - interval '30 days'
)`;

const conflict = (code: string, message: string) => new HttpException({ code, message }, HttpStatus.CONFLICT);

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "23505";
}

const SLUG_TAKEN = "another skill in the same place already uses this `name`; change the frontmatter `name`";

@Injectable()
export class SkillRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private rows(where: SQL | undefined): Promise<SkillRow[]> {
    return this.db
      .select({ skill: skills, spaceName: projects.name, ownerName: profiles.displayName, runs30d })
      .from(skills)
      .leftJoin(projects, eq(projects.id, skills.projectId))
      .leftJoin(profiles, eq(profiles.userId, skills.ownerUserId))
      .where(where)
      .orderBy(desc(skills.updatedAt), desc(skills.createdAt));
  }

  async findById(id: string): Promise<SkillRow | null> {
    const [row] = await this.rows(eq(skills.id, id));
    return row ?? null;
  }

  // The visible set, in the query: mine, or in a space I can read, or granted
  // to me directly. Never filtered after the fact.
  listVisible(
    userId: string,
    visibleProjectIds: string[],
    filter: { projectId?: string; q?: string; slug?: string; archived: boolean },
  ): Promise<SkillRow[]> {
    const visible = or(
      eq(skills.ownerUserId, userId),
      visibleProjectIds.length ? inArray(skills.projectId, visibleProjectIds) : undefined,
      sql`${skills.id} in (
        select g.resource_id from grants g
        where g.resource_type = 'skill' and g.subject_type = 'user' and g.subject_id = ${userId}::uuid
      )`,
    );
    const conditions: (SQL | undefined)[] = [visible, eq(skills.archived, filter.archived)];
    if (filter.projectId) conditions.push(eq(skills.projectId, filter.projectId));
    if (filter.slug) conditions.push(eq(skills.slug, filter.slug));
    if (filter.q) {
      const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(or(ilike(skills.title, like), ilike(skills.description, like), ilike(skills.slug, like)));
    }
    return this.rows(and(...conditions));
  }

  async slugExists(ownerUserId: string, projectId: string | null, slug: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.slug, slug),
          projectId ? eq(skills.projectId, projectId) : and(eq(skills.ownerUserId, ownerUserId), isNull(skills.projectId)),
        ),
      )
      .limit(1);
    return !!row;
  }

  async create(input: {
    ownerUserId: string;
    orgId: string | null;
    projectId: string | null;
    card: SkillCardFields;
    files: SkillFile[];
    changeNote: string | null;
  }): Promise<string> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(skills)
          .values({
            ownerUserId: input.ownerUserId,
            orgId: input.orgId,
            projectId: input.projectId,
            ...input.card,
            currentVersion: 1,
          })
          .returning({ id: skills.id });
        await tx.insert(skillVersions).values({
          skillId: row!.id,
          version: 1,
          files: input.files,
          changeNote: input.changeNote,
          createdBy: input.ownerUserId,
        });
        return row!.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("slug_taken", SLUG_TAKEN);
      throw err;
    }
  }

  // Versions are immutable: a save is always version n+1. The UPDATE only
  // matches while `current_version` is still the one the editor started from,
  // so of two people saving at once exactly one wins and the other gets 409.
  async saveVersion(input: {
    skillId: string;
    baseVersion: number;
    card: SkillCardFields;
    files: SkillFile[];
    changeNote: string | null;
    createdBy: string;
  }): Promise<number> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(skills)
          .set({ ...input.card, currentVersion: sql`${skills.currentVersion} + 1`, updatedAt: sql`now()` })
          .where(and(eq(skills.id, input.skillId), eq(skills.currentVersion, input.baseVersion)))
          .returning({ version: skills.currentVersion });
        if (!row) {
          throw conflict(
            "version_conflict",
            "this skill was saved by someone else since you opened it; reload it and apply your change again",
          );
        }
        await tx.insert(skillVersions).values({
          skillId: input.skillId,
          version: row.version,
          files: input.files,
          changeNote: input.changeNote,
          createdBy: input.createdBy,
        });
        return row.version;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("slug_taken", SLUG_TAKEN);
      throw err;
    }
  }

  async findVersion(skillId: string, version: number): Promise<SkillVersionRow | null> {
    const [row] = await this.versionRows(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)));
    return row ?? null;
  }

  listVersions(skillId: string): Promise<SkillVersionRow[]> {
    return this.versionRows(eq(skillVersions.skillId, skillId));
  }

  private versionRows(where: SQL | undefined): Promise<SkillVersionRow[]> {
    return this.db
      .select({ version: skillVersions, authorName: profiles.displayName })
      .from(skillVersions)
      .leftJoin(profiles, eq(profiles.userId, skillVersions.createdBy))
      .where(where)
      .orderBy(desc(skillVersions.version));
  }

  async patch(
    skillId: string,
    changes: { projectId?: string | null; orgId?: string | null; archived?: boolean },
  ): Promise<void> {
    try {
      await this.db.update(skills).set({ ...changes, updatedAt: sql`now()` }).where(eq(skills.id, skillId));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("slug_taken", "a skill with this `name` already exists there");
      throw err;
    }
  }

  // Versions and runs go with it (FK cascade).
  async delete(skillId: string): Promise<void> {
    await this.db.delete(skills).where(eq(skills.id, skillId));
  }

  async recordRun(skillId: string, version: number, userId: string | null, surface: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(skillRuns).values({ skillId, version, userId, surface });
      await tx.update(skills).set({ runCount: sql`${skills.runCount} + 1` }).where(eq(skills.id, skillId));
    });
  }
}
