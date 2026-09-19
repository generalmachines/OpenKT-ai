import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  memberKnowledge,
  memories,
  orgMembers,
  profiles,
  projects,
} from "../../../db/schema";
import type {
  MemberDetailPayload,
  MemberMemoryItem,
  MemberSummary,
  RecentMemory,
  Theme,
} from "../contracts/member-knowledge.contract";

@Injectable()
export class LocalPgMemberKnowledgeRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Membership ─────────────────────────────────────────────────────
  // Caller must be in the project's org. Personal projects (no org)
  // are visible only to their owner.
  private async assertMember(
    context: ActorContext,
    projectId: string,
  ): Promise<{ org_id: string | null; owner_user_id: string }> {
    const userId = context.principal.userId;
    if (!userId) throw new Error("user principal required");

    const project = await this.db
      .select({
        id: projects.id,
        org_id: projects.orgId,
        owner_user_id: projects.ownerUserId,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project.length === 0) {
      throw new Error(`project ${projectId} not visible to caller`);
    }
    const { org_id, owner_user_id } = project[0];

    if (org_id) {
      const member = await this.db
        .select({ user_id: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org_id), eq(orgMembers.userId, userId)))
        .limit(1);
      if (member.length === 0) {
        throw new Error(`project ${projectId} not visible to caller`);
      }
    } else if (owner_user_id !== userId) {
      throw new Error(`project ${projectId} not visible to caller`);
    }
    return { org_id, owner_user_id };
  }

  // ── Public API ────────────────────────────────────────────────────

  async listContributors(
    context: ActorContext,
    projectId: string,
    limit: number,
  ): Promise<MemberSummary[]> {
    await this.assertMember(context, projectId);

    // Derive contributors from `memories` so we always include people
    // who have written but never had a synthesis pass run. Left-join
    // member_knowledge (the LLM-driven rollup) on top for summary +
    // themes.
    const rows = await this.db
      .select({
        user_id: memories.ownerUserId,
        display_name: profiles.displayName,
        memory_count: sql<number>`count(distinct ${memories.id})::int`,
        first_at: sql<Date | null>`min(${memories.createdAt})`,
        last_at: sql<Date | null>`max(${memories.createdAt})`,
        summary: memberKnowledge.summary,
        themes: memberKnowledge.themes,
        rollup_memory_count: memberKnowledge.memoryCount,
        rollup_episode_count: memberKnowledge.episodeCount,
        last_synthesized_at: memberKnowledge.lastSynthesizedAt,
      })
      .from(memories)
      .leftJoin(profiles, eq(profiles.userId, memories.ownerUserId))
      .leftJoin(
        memberKnowledge,
        and(
          eq(memberKnowledge.projectId, memories.projectId),
          eq(memberKnowledge.userId, memories.ownerUserId),
        ),
      )
      .where(and(eq(memories.projectId, projectId), eq(memories.archived, false)))
      .groupBy(
        memories.ownerUserId,
        profiles.displayName,
        memberKnowledge.summary,
        memberKnowledge.themes,
        memberKnowledge.memoryCount,
        memberKnowledge.episodeCount,
        memberKnowledge.lastSynthesizedAt,
      )
      .orderBy(desc(sql`max(${memories.createdAt})`))
      .limit(limit);

    return rows.map((r) => ({
      user_id: r.user_id,
      display_name: r.display_name ?? null,
      avatar_url: null, // profiles table has no avatar_url today
      memory_count: Number(r.memory_count ?? 0),
      episode_count: Number(r.rollup_episode_count ?? 0),
      themes: normalizeThemes(r.themes),
      summary: r.summary ?? null,
      last_contribution_at: toIso(r.last_at),
    }));
  }

  async getMember(
    context: ActorContext,
    projectId: string,
    userId: string,
  ): Promise<MemberDetailPayload | null> {
    await this.assertMember(context, projectId);

    const profile = await this.db
      .select({ user_id: profiles.userId, display_name: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    const knowledge = await this.db
      .select()
      .from(memberKnowledge)
      .where(
        and(
          eq(memberKnowledge.projectId, projectId),
          eq(memberKnowledge.userId, userId),
        ),
      )
      .limit(1);

    const stats = await this.db
      .select({
        memory_count: sql<number>`count(distinct ${memories.id})::int`,
        first_at: sql<Date | null>`min(${memories.createdAt})`,
        last_at: sql<Date | null>`max(${memories.createdAt})`,
      })
      .from(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.ownerUserId, userId),
          eq(memories.archived, false),
        ),
      );

    // If neither profile nor any memories exist, treat as not found.
    if (profile.length === 0 && Number(stats[0]?.memory_count ?? 0) === 0) {
      return null;
    }

    const recent = await this.db
      .select({
        id: memories.id,
        kind: memories.kind,
        content: memories.content,
        created_at: memories.createdAt,
      })
      .from(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.ownerUserId, userId),
          eq(memories.archived, false),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(10);

    const recent_memories: RecentMemory[] = recent.map((m) => ({
      id: m.id,
      kind: String(m.kind),
      preview: preview(m.content),
      created_at: toIso(m.created_at) ?? "",
    }));

    const themes = normalizeThemes(knowledge[0]?.themes);

    return {
      user_id: userId,
      display_name: profile[0]?.display_name ?? null,
      summary: knowledge[0]?.summary ?? null,
      themes,
      stats: {
        memory_count: Number(stats[0]?.memory_count ?? 0),
        episode_count: Number(knowledge[0]?.episodeCount ?? 0),
        first_contribution_at: toIso(stats[0]?.first_at ?? null),
        last_contribution_at: toIso(stats[0]?.last_at ?? null),
        tags_owned: themes.map((t) => t.tag),
      },
      recent_memories,
    };
  }

  async mixMemories(
    context: ActorContext,
    projectId: string,
    userIds: string[],
    limit: number,
  ): Promise<{ items: MemberMemoryItem[]; total: number }> {
    await this.assertMember(context, projectId);
    if (userIds.length === 0) {
      return { items: [], total: 0 };
    }

    const rows = await this.db
      .select({
        id: memories.id,
        kind: memories.kind,
        content: memories.content,
        owner_user_id: memories.ownerUserId,
        created_at: memories.createdAt,
        updated_at: memories.updatedAt,
      })
      .from(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.archived, false),
          inArray(memories.ownerUserId, userIds),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(limit);

    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: String(r.kind),
        content: r.content,
        owner_user_id: r.owner_user_id ?? null,
        created_at: toIso(r.created_at) ?? "",
        updated_at: toIso(r.updated_at) ?? "",
      })),
      total: rows.length,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function preview(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim()) ?? content;
  const compact = firstLine.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 197)}...` : compact;
}

function normalizeThemes(raw: unknown): Theme[] {
  if (!Array.isArray(raw)) return [];
  const out: Theme[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const tag = typeof rec.tag === "string" ? rec.tag : null;
    const weight = typeof rec.weight === "number" ? rec.weight : null;
    if (!tag || weight === null) continue;
    const memory_count =
      typeof rec.memory_count === "number" ? rec.memory_count : undefined;
    out.push({ tag, weight, memory_count });
  }
  return out;
}

