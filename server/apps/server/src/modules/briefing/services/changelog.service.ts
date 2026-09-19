import { Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";
import { LlmGatewayService } from "@openkt/platform-llm";

import { ProjectScopeService } from "../../projects/services/project-scope.service";
import {
  ChangelogResponseSchema,
  type ChangelogResponse,
} from "../contracts/briefing.contract";
import { BriefingCacheRepository } from "../repositories/briefing-cache.repository";

// Changelog service — "what's new since timestamp X".
//
// On every request we pull the deltas from `memories` and `episodes`
// since the caller's `since` parameter, then ask the LLM for a 2-3
// sentence "what happened" paragraph. The paragraph itself is the
// only thing we cache (5 minutes, keyed by project_id + bucketed
// since-hour) — the raw row data is cheap to fetch and varies enough
// between callers that caching it adds little.
//
// Process-local cache is good enough: the API tier runs as a single
// horizontally-scaled container and the worst-case scenario (every
// pod warms its own cache) costs us at most N extra LLM calls per
// hour per pod. If that ever becomes painful, swap the Map for a
// Redis tier.

interface CachedSummary {
  summary: string;
  builtAt: number;
}

const SUMMARY_CACHE_TTL_MS = 5 * 60_000;
const MAX_LOOKBACK_DAYS = 90;
const SYSTEM_PROMPT =
  "You write a 2-3 sentence summary of changes to an engineering project " +
  "between two timestamps. Be specific — cite the topic that shifted, the " +
  "decision that landed, or the question that was raised. No lists, no " +
  "headings, no emoji. If nothing meaningful changed, say so plainly.";

@Injectable()
export class ChangelogService {
  private readonly logger = new Logger(ChangelogService.name);
  private readonly summaryCache = new Map<string, CachedSummary>();

  constructor(
    private readonly scope: ProjectScopeService,
    private readonly cache: BriefingCacheRepository,
    private readonly llm: LlmGatewayService,
  ) {}

  async getChangelog(
    context: ActorContext,
    projectId: string,
    sinceIso: string,
  ): Promise<ChangelogResponse> {
    await this.scope.requireProjectAccess(context, projectId, "read");

    const since = new Date(sinceIso);
    if (Number.isNaN(since.getTime())) {
      throw new ValidationDomainError("since must be a valid ISO 8601 timestamp");
    }
    const ageMs = Date.now() - since.getTime();
    if (ageMs < 0) {
      throw new ValidationDomainError("since must be in the past");
    }
    if (ageMs > MAX_LOOKBACK_DAYS * 24 * 3_600_000) {
      throw new ValidationDomainError(
        `since must be within the last ${MAX_LOOKBACK_DAYS} days`,
      );
    }

    const until = new Date();

    const [newMemories, archivedMemories, newEpisodes, supersededEpisodes] =
      await Promise.all([
        this.cache.listNewMemoriesSince(projectId, since),
        this.cache.listArchivedMemoriesSince(projectId, since),
        this.cache.listNewEpisodesSince(projectId, since),
        this.cache.listSupersededEpisodesSince(projectId, since),
      ]);

    const supersededWithLineage = await Promise.all(
      supersededEpisodes.map(async (ep) => {
        const sibling = await this.cache.findMostRecentActiveSibling(
          projectId,
          new Date(ep.archived_at || since.toISOString()),
        );
        return {
          id: ep.id,
          superseded_by_episode_id: sibling?.id ?? null,
        };
      }),
    );

    const summary = await this.resolveSummary({
      projectId,
      since,
      until,
      newMemoryCount: newMemories.length,
      archivedMemoryCount: archivedMemories.length,
      newEpisodeCount: newEpisodes.length,
      supersededEpisodeCount: supersededEpisodes.length,
      memoryPreviews: newMemories.slice(0, 12).map((m) => ({
        kind: m.kind,
        preview: this.preview(m.content),
      })),
      episodePreviews: newEpisodes.slice(0, 8).map((e) => ({
        summary: e.summary ?? "",
      })),
    });

    const response: ChangelogResponse = {
      since: since.toISOString(),
      until: until.toISOString(),
      summary,
      new_memories: newMemories.map((m) => ({
        id: m.id,
        kind: m.kind,
        preview: this.preview(m.content),
        tags: m.tags,
        created_at: m.created_at,
        actor_id: m.owner_user_id,
      })),
      new_episodes: newEpisodes.map((e) => ({
        id: e.id,
        summary: e.summary,
        action: e.created_at === e.updated_at ? "created" : "updated",
        supersedes_episode_id: null,
      })),
      archived_memories: archivedMemories.map((m) => ({
        id: m.id,
        archived_at: m.archived_at,
      })),
      superseded_episodes: supersededWithLineage,
    };

    return ChangelogResponseSchema.parse(response);
  }

  private preview(content: string): string {
    return (content || "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  // — Summary cache ————————————————————————————————————————————————

  private cacheKey(projectId: string, since: Date): string {
    // Bucket `since` to the hour so callers polling the same window get
    // the same cached summary; per-second granularity would defeat the
    // cache entirely.
    const bucket = new Date(since);
    bucket.setUTCMinutes(0, 0, 0);
    return `${projectId}::${bucket.toISOString()}`;
  }

  private async resolveSummary(input: {
    projectId: string;
    since: Date;
    until: Date;
    newMemoryCount: number;
    archivedMemoryCount: number;
    newEpisodeCount: number;
    supersededEpisodeCount: number;
    memoryPreviews: { kind: string; preview: string }[];
    episodePreviews: { summary: string }[];
  }): Promise<string> {
    const key = this.cacheKey(input.projectId, input.since);
    const cached = this.summaryCache.get(key);
    if (cached && Date.now() - cached.builtAt < SUMMARY_CACHE_TTL_MS) {
      return cached.summary;
    }

    const summary = await this.generateSummary(input);
    this.summaryCache.set(key, { summary, builtAt: Date.now() });

    // Crude cache GC — if the map grows beyond ~1k entries, drop the
    // oldest half. We never expect to keep more than a few dozen.
    if (this.summaryCache.size > 1_000) {
      const entries = Array.from(this.summaryCache.entries()).sort(
        (a, b) => a[1].builtAt - b[1].builtAt,
      );
      for (const [k] of entries.slice(0, Math.floor(entries.length / 2))) {
        this.summaryCache.delete(k);
      }
    }
    return summary;
  }

  private async generateSummary(input: {
    since: Date;
    until: Date;
    newMemoryCount: number;
    archivedMemoryCount: number;
    newEpisodeCount: number;
    supersededEpisodeCount: number;
    memoryPreviews: { kind: string; preview: string }[];
    episodePreviews: { summary: string }[];
  }): Promise<string> {
    if (
      input.newMemoryCount === 0 &&
      input.newEpisodeCount === 0 &&
      input.archivedMemoryCount === 0 &&
      input.supersededEpisodeCount === 0
    ) {
      return "No meaningful changes between these timestamps.";
    }

    const userPrompt = [
      `Window: ${input.since.toISOString()} → ${input.until.toISOString()}`,
      "",
      `Counts: new_memories=${input.newMemoryCount}, archived_memories=${input.archivedMemoryCount}, new_episodes=${input.newEpisodeCount}, superseded_episodes=${input.supersededEpisodeCount}`,
      "",
      "New memory previews:",
      input.memoryPreviews
        .map((m, i) => `${i + 1}. (${m.kind}) ${m.preview}`)
        .join("\n") || "(none)",
      "",
      "New/updated episode summaries:",
      input.episodePreviews
        .map((e, i) => `${i + 1}. ${e.summary}`)
        .join("\n") || "(none)",
    ].join("\n");

    try {
      const result = await this.llm.tryGenerateText({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        maxOutputTokens: 300,
        timeoutMs: 20_000,
      });
      if (result?.text.trim()) return result.text.trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[changelog] LLM summary failed: ${message}`);
    }

    // Deterministic fallback — never leave the caller with an empty
    // summary even when the LLM gateway is unconfigured/offline.
    const parts: string[] = [];
    if (input.newMemoryCount > 0) {
      parts.push(`${input.newMemoryCount} new memories captured`);
    }
    if (input.newEpisodeCount > 0) {
      parts.push(`${input.newEpisodeCount} knowledge episodes updated`);
    }
    if (input.archivedMemoryCount > 0) {
      parts.push(`${input.archivedMemoryCount} memories archived`);
    }
    if (input.supersededEpisodeCount > 0) {
      parts.push(`${input.supersededEpisodeCount} episodes superseded`);
    }
    return `Between ${input.since.toISOString()} and ${input.until.toISOString()}: ${parts.join(", ")}.`;
  }
}
