import { Injectable, Logger } from "@nestjs/common";

import { LlmGatewayService } from "@openkt/platform-llm";

import type {
  PipelineCommandMessage,
  StageExecutionResult,
} from "../pipeline-message";
import { ROUTING_KEY_MEMBER_KNOWLEDGE_DONE } from "../../mq/mq.constants";
import { WorkerLlmConfigResolverService } from "./worker-llm-config-resolver.service";
import { WorkerPgService } from "../../database/worker-pg.service";

// Per-contributor knowledge rollup stage. Replaces the old `pulse`
// stage which wrote one event per memory. The new stage runs once per
// project (project-coalesced like `briefing`) and for every contributor
// whose memories are "stale" relative to their last rollup, calls the
// LLM to regenerate `summary` + `themes` and upserts into
// `member_knowledge` keyed by (project_id, user_id).
//
// "Stale" = the most recent memory by that user is younger than
// member_knowledge.last_synthesized_at, OR no rollup exists yet, OR
// the rollup is older than STALENESS_MS regardless of activity.
//
// We deliberately make this a per-(project, user) upsert (not per
// memory) so the worker scales as `O(contributors)` instead of
// `O(memories)`. Memories created by a new actor still trigger this
// stage via the preprocess fan-out — the contributor scan picks them
// up on the next pass.

const STALENESS_MS = 6 * 60 * 60_000; // 6h — re-synthesise inactive contributors
const MAX_MEMORIES_PER_CONTRIBUTOR = 40;
const MAX_CONTRIBUTORS_PER_RUN = 25;

interface Contributor {
  user_id: string;
  display_name: string | null;
  memory_count: number;
  episode_count: number;
  last_memory_at: string;
  last_synthesized_at: string | null;
}

interface ContributorMemory {
  id: string;
  content: string;
  kind: string;
  created_at: string;
}

interface ThemeOut {
  tag: string;
  weight: number;
  memory_count: number;
}

interface LlmRollup {
  summary: string;
  themes: ThemeOut[];
}

@Injectable()
export class MemberKnowledgeStageService {
  private readonly logger = new Logger(MemberKnowledgeStageService.name);

  constructor(
    private readonly db: WorkerPgService,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly llmConfigResolver: WorkerLlmConfigResolverService,
  ) {}

  async execute(message: PipelineCommandMessage): Promise<StageExecutionResult> {
    const project = await this.db.one<{
      id: string;
      name: string;
      slug: string;
      org_id: string | null;
    }>(
      `select id, name, slug, org_id
         from projects
        where id = $1`,
      [message.project_id],
    );
    if (!project) {
      return {
        result: { skipped: true, reason: "project not found" },
        eventRoutingKey: ROUTING_KEY_MEMBER_KNOWLEDGE_DONE,
      };
    }

    const contributors = await this.findStaleContributors(
      message.project_id,
    );

    if (contributors.length === 0) {
      return {
        result: { skipped: true, reason: "no stale contributors" },
        eventRoutingKey: ROUTING_KEY_MEMBER_KNOWLEDGE_DONE,
      };
    }

    const synthesised: Array<{ user_id: string; provider: string; model: string }> =
      [];
    const placeholders: Array<{ user_id: string; reason: string }> = [];

    for (const contributor of contributors) {
      try {
        const memories = await this.fetchMemoriesForContributor(
          message.project_id,
          contributor.user_id,
        );
        if (memories.length === 0) continue;

        const rollup = await this.synthesiseRollup({
          message,
          projectName: project.name || project.slug || "this project",
          contributor,
          memories,
        });

        if (!rollup) {
          // LLM exhausted — still UPSERT the row keyed by
          // (project_id, user_id) so the row at least *exists* and
          // dashboards stop reporting the user as un-rolled-up.
          // summary stays NULL until a future run lands a real one;
          // last_synthesized_at = now() lets the staleness window
          // back off so we don't hammer the LLM on every memory arrival
          // when it's already failing.
          await this.upsertRollup({
            project_id: message.project_id,
            org_id: project.org_id,
            user_id: contributor.user_id,
            summary: null,
            themes: [],
            memory_count: memories.length,
            episode_count: contributor.episode_count,
          });
          placeholders.push({
            user_id: contributor.user_id,
            reason: "no LLM response (all providers exhausted)",
          });
          continue;
        }

        await this.upsertRollup({
          project_id: message.project_id,
          org_id: project.org_id,
          user_id: contributor.user_id,
          summary: rollup.value.summary,
          themes: rollup.value.themes,
          memory_count: memories.length,
          episode_count: contributor.episode_count,
        });

        synthesised.push({
          user_id: contributor.user_id,
          provider: rollup.provider,
          model: rollup.model,
        });
      } catch (err) {
        this.logger.warn(
          `[member_knowledge] contributor ${contributor.user_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      result: {
        generated: true,
        project_id: message.project_id,
        contributors_synthesized: synthesised.length,
        contributors_scanned: contributors.length,
        placeholders_written: placeholders.length,
        details: synthesised,
        placeholders,
      },
      eventRoutingKey: ROUTING_KEY_MEMBER_KNOWLEDGE_DONE,
    };
  }

  // ── Helpers (also unit-tested in isolation) ─────────────────────────

  /**
   * Returns contributors who need a fresh rollup. A contributor is
   * stale if any of:
   *   - no row in member_knowledge yet
   *   - their most recent memory is newer than last_synthesized_at
   *   - the rollup is older than STALENESS_MS
   */
  async findStaleContributors(projectId: string): Promise<Contributor[]> {
    const cutoffIso = new Date(Date.now() - STALENESS_MS).toISOString();
    // Defensive: `m.owner_user_id is not null` in the inner CTE prevents
    // a NULL contributor row from later cascading into a
    // `member_knowledge` insert with `user_id = NULL` (prod has 5
    // such rows from an older revision that didn't filter — the
    // partial unique index `(project_id, user_id) where user_id is
    // not null` lets NULL user_id rows duplicate freely).
    return this.db.query<Contributor>(
      `with stats as (
         select m.owner_user_id as user_id,
                max(m.updated_at) as last_memory_at,
                count(*)::int as memory_count
           from memories m
          where m.project_id = $1
            and m.archived = false
            and m.owner_user_id is not null
          group by m.owner_user_id
       )
       select stats.user_id,
              pr.display_name,
              stats.memory_count,
              0::int as episode_count,
              stats.last_memory_at::text,
              mk.last_synthesized_at::text as last_synthesized_at
         from stats
         left join profiles pr on pr.user_id = stats.user_id
         left join member_knowledge mk
           on mk.project_id = $1 and mk.user_id = stats.user_id
        where mk.last_synthesized_at is null
           or mk.last_synthesized_at < stats.last_memory_at
           or mk.last_synthesized_at < $2::timestamptz
        order by stats.last_memory_at desc
        limit $3`,
      [projectId, cutoffIso, MAX_CONTRIBUTORS_PER_RUN],
    );
  }

  async fetchMemoriesForContributor(
    projectId: string,
    userId: string,
  ): Promise<ContributorMemory[]> {
    return this.db.query<ContributorMemory>(
      `select id, content, kind, created_at::text
         from memories
        where project_id = $1 and owner_user_id = $2 and archived = false
        order by created_at desc
        limit ${MAX_MEMORIES_PER_CONTRIBUTOR}`,
      [projectId, userId],
    );
  }

  private async synthesiseRollup({
    message,
    projectName,
    contributor,
    memories,
  }: {
    message: PipelineCommandMessage;
    projectName: string;
    contributor: Contributor;
    memories: ContributorMemory[];
  }): Promise<{ value: LlmRollup; provider: string; model: string } | null> {
    const lines = memories.map((memory, index) => {
      const stamp = (memory.created_at ?? "").slice(0, 10);
      const compact = (memory.content || "").replace(/\s+/g, " ").slice(0, 280);
      return `${index + 1}. (${stamp} · ${memory.kind}) ${compact}`;
    });

    const userLabel =
      contributor.display_name?.trim() || `user ${contributor.user_id}`;

    const response = await this.llmGatewayService.tryGenerateText({
      providerConfig: await this.llmConfigResolver.resolve(message),
      messages: [
        {
          role: "system",
          content:
            "Given these memories created by user X in project Y, write a 2-3 sentence summary of what knowledge they've contributed. " +
            "Focus on themes, decisions they drove, and areas of ownership. Avoid filler. " +
            'Respond with ONLY a single JSON object: {"summary": "...", "themes": [{"tag": "...", "weight": 0.0-1.0, "memory_count": N}, ...]}. ' +
            "Order themes by weight desc. Use 3-7 themes. Do not include markdown fences.",
        },
        {
          role: "user",
          content:
            `Project Y: ${projectName}\nUser X: ${userLabel}\n\n` +
            `Memories (newest first, ${memories.length} total):\n${lines.join("\n")}`,
        },
      ],
      maxOutputTokens: 500,
      timeoutMs: 30_000,
    });

    if (!response || !response.text.trim()) {
      return null;
    }

    const parsed = parseRollupJson(response.text);
    if (!parsed) return null;

    return {
      value: parsed,
      provider: response.provider,
      model: response.model,
    };
  }

  private async upsertRollup(row: {
    project_id: string;
    org_id: string | null;
    user_id: string;
    summary: string | null;
    themes: ThemeOut[];
    memory_count: number;
    episode_count: number;
  }): Promise<void> {
    await this.db.query(
      `insert into member_knowledge (
         project_id, org_id, user_id, summary, themes,
         memory_count, episode_count, last_synthesized_at
       )
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
       on conflict (project_id, user_id) where user_id is not null
       do update set
         summary = excluded.summary,
         themes = excluded.themes,
         memory_count = excluded.memory_count,
         episode_count = excluded.episode_count,
         org_id = excluded.org_id,
         last_synthesized_at = excluded.last_synthesized_at`,
      [
        row.project_id,
        row.org_id,
        row.user_id,
        row.summary,
        JSON.stringify(row.themes),
        row.memory_count,
        row.episode_count,
      ],
    );
  }
}

/**
 * Pulls the first `{...}` JSON block out of an LLM response, parses
 * it, and returns the typed rollup. Exported for unit tests.
 */
export function parseRollupJson(raw: string): LlmRollup | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  const summary = typeof rec.summary === "string" ? rec.summary.trim() : "";
  if (!summary) return null;

  const themesRaw = Array.isArray(rec.themes) ? rec.themes : [];
  const themes: ThemeOut[] = [];
  for (const t of themesRaw) {
    if (!t || typeof t !== "object") continue;
    const trec = t as Record<string, unknown>;
    const tag = typeof trec.tag === "string" ? trec.tag.trim() : "";
    const weight =
      typeof trec.weight === "number" && Number.isFinite(trec.weight)
        ? Math.max(0, Math.min(1, trec.weight))
        : null;
    if (!tag || weight === null) continue;
    const memory_count =
      typeof trec.memory_count === "number" && Number.isFinite(trec.memory_count)
        ? Math.max(0, Math.trunc(trec.memory_count))
        : 0;
    themes.push({ tag, weight, memory_count });
  }
  themes.sort((a, b) => b.weight - a.weight);

  return { summary, themes };
}
