import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  memories,
  orgMembers,
  projects,
  teamBriefings,
} from "../../../db/schema";
import type { BriefingRow } from "../contracts/briefing.contract";

interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  created_at: string;
}

// Briefings repository — typed Drizzle queries against whatever DB
// DATABASE_URL points at (local pg in dev, Supabase pg-pooler in
// prod). The historical class name is kept stable so the application
// service that depends on it doesn't need to change.

@Injectable()
export class LocalPgBriefingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async assertMember(
    context: ActorContext,
    projectId: string,
  ): Promise<{ org_id: string; project_name: string }> {
    const userId = context.principal.userId;
    if (!userId) throw new Error("user principal required");
    const rows = await this.db
      .select({ org_id: projects.orgId, project_name: projects.name })
      .from(projects)
      .innerJoin(orgMembers, eq(orgMembers.orgId, projects.orgId))
      .where(and(eq(projects.id, projectId), eq(orgMembers.userId, userId)))
      .limit(1);
    if (rows.length === 0) throw new Error(`project ${projectId} not visible to caller`);
    return { org_id: rows[0].org_id ?? "", project_name: rows[0].project_name };
  }

  async getCurrent(context: ActorContext, projectId: string): Promise<BriefingRow | null> {
    await this.assertMember(context, projectId);
    const rows = await this.db
      .select()
      .from(teamBriefings)
      .where(and(eq(teamBriefings.projectId, projectId), eq(teamBriefings.isCurrent, true)))
      .limit(1);
    return rows[0] ? this.toRow(rows[0]) : null;
  }

  async listMemoriesForBriefing(
    context: ActorContext,
    projectId: string,
    limit = 80,
  ): Promise<MemoryRow[]> {
    await this.assertMember(context, projectId);
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        kind: memories.kind,
        created_at: memories.createdAt,
      })
      .from(memories)
      .where(and(eq(memories.projectId, projectId), eq(memories.archived, false)))
      .orderBy(desc(memories.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      kind: r.kind as string,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async fetchProjectAndOrg(
    context: ActorContext,
    projectId: string,
  ): Promise<{ name: string; org_id: string } | null> {
    const row = await this.assertMember(context, projectId);
    return { name: row.project_name, org_id: row.org_id };
  }

  async insertCurrent(
    context: ActorContext,
    row: {
      project_id: string;
      org_id: string;
      generated_by: string | null;
      briefing_md: string;
      model: string;
      source_memory_count_at_generation: number;
      source_memory_ids: string[];
    },
  ): Promise<BriefingRow> {
    await this.assertMember(context, row.project_id);
    const inserted = await this.db
      .insert(teamBriefings)
      .values({
        projectId: row.project_id,
        orgId: row.org_id,
        generatedBy: row.generated_by ?? undefined,
        briefingMd: row.briefing_md,
        model: row.model,
        sourceMemoryCountAtGeneration: row.source_memory_count_at_generation,
        sourceMemoryIds: row.source_memory_ids,
        isCurrent: true,
      })
      .returning();
    if (!inserted[0]) throw new Error("failed to insert briefing");
    return this.toRow(inserted[0]);
  }

  private toRow(row: typeof teamBriefings.$inferSelect): BriefingRow {
    return {
      id: row.id,
      project_id: row.projectId,
      org_id: row.orgId,
      generated_at:
        row.generatedAt instanceof Date ? row.generatedAt.toISOString() : String(row.generatedAt),
      briefing_md: row.briefingMd,
      model: row.model,
      prompt_tokens: row.promptTokens,
      completion_tokens: row.completionTokens,
      source_memory_count_at_generation: row.sourceMemoryCountAtGeneration,
      source_memory_ids: row.sourceMemoryIds ?? [],
      is_current: row.isCurrent,
    };
  }
}
