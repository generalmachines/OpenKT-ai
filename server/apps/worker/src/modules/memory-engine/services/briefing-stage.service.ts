import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import { LlmGatewayService } from "@openkt/platform-llm";

import type {
  PipelineCommandMessage,
  StageExecutionResult,
} from "../pipeline-message";
import { ROUTING_KEY_BRIEFING_DONE } from "../../mq/mq.constants";
import { WorkerPgService } from "../../database/worker-pg.service";
import { WorkerLlmConfigResolverService } from "./worker-llm-config-resolver.service";

// Briefings v2 — live-view model.
//
// One cache row per project (`project_briefing_cache`). On every
// briefing pass the worker UPSERTs the row, bumps `version`, and sets
// `stale_at = now() + STALE_AFTER_MS`. The API reads from this row
// and, when it sees `stale_at < now()`, fires a refresh job in the
// background but still returns the cached value with `stale: true`.
//
// Why we don't keep history here:
//   * the memory feed already shows what was captured and when
//   * episode lineage (supersedes / archives) shows how the project's
//     understanding evolved
//   * the changelog endpoint (`/v1/projects/:id/changelog?since=...`)
//     synthesises "what's new between t1 and t2" on demand
// Storing an append-only list of past briefings duplicates all three
// without adding signal.
//
// Coalescing: like v1 we still skip back-to-back briefings landing in
// the same project within FRESH_WINDOW_MS — N memories arriving at
// once shouldn't fire N LLM passes.
const FRESH_WINDOW_MS = 5 * 60_000;
const STALE_AFTER_MS = 6 * 60 * 60_000; // 6h

// Structured output the LLM is asked to emit. Loose shape on purpose:
// we don't want a stage failure if the model omits an optional field.
const BriefingOutputSchema = z.object({
  summary: z.string().min(1),
  themes: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().default(""),
        memory_ids: z.array(z.string().uuid()).default([]),
        episode_ids: z.array(z.string().uuid()).default([]),
      }),
    )
    .default([]),
  key_decisions: z
    .array(
      z.object({
        summary: z.string(),
        episode_id: z.string().uuid().nullable().default(null),
        decided_at: z.string().nullable().default(null),
      }),
    )
    .default([]),
  open_questions: z
    .array(
      z.object({
        question: z.string(),
        raised_in_memory_id: z.string().uuid().nullable().default(null),
        raised_at: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

type BriefingOutput = z.infer<typeof BriefingOutputSchema>;

const SYSTEM_PROMPT =
  "You are summarising the current state of an engineering project for a teammate dropping back in. " +
  "Produce a tight live-view briefing — what the project is, what's converging, what's open. " +
  "Cite memory and episode ids when you can. " +
  "Output a single JSON object with shape: " +
  "{ summary: string, themes: [{name, description, memory_ids, episode_ids}], " +
  "key_decisions: [{summary, episode_id, decided_at}], " +
  "open_questions: [{question, raised_in_memory_id, raised_at}] }. " +
  "Keep `summary` to 4-6 sentences. No headings, no markdown fences.";

@Injectable()
export class BriefingStageService {
  private readonly logger = new Logger(BriefingStageService.name);

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
        eventRoutingKey: ROUTING_KEY_BRIEFING_DONE,
      };
    }

    // Read the current cache row so we can (a) debounce against the
    // FRESH_WINDOW and (b) preserve `version` continuity across upserts.
    const prior = await this.db.one<{
      version: number;
      generated_at: string;
    }>(
      `select version, generated_at::text
         from project_briefing_cache
        where project_id = $1`,
      [message.project_id],
    );

    if (prior?.generated_at) {
      const ageMs = Date.now() - Date.parse(prior.generated_at);
      if (ageMs < FRESH_WINDOW_MS) {
        return {
          result: {
            skipped: true,
            reason: "briefing already fresh",
            generated_at: prior.generated_at,
            age_ms: ageMs,
            version: prior.version,
          },
          eventRoutingKey: ROUTING_KEY_BRIEFING_DONE,
        };
      }
    }

    const memories = await this.db.query<{
      id: string;
      content: string;
      kind: string;
      created_at: string;
    }>(
      `select id, content, kind, created_at::text
         from memories
        where project_id = $1 and archived = false
        order by created_at desc
        limit 40`,
      [message.project_id],
    );

    if (memories.length === 0) {
      return {
        result: { skipped: true, reason: "no memories to brief" },
        eventRoutingKey: ROUTING_KEY_BRIEFING_DONE,
      };
    }

    const episodes = await this.db.query<{
      id: string;
      name: string;
      summary: string | null;
      tags: string[] | null;
      confidence: number | null;
      updated_at: string;
    }>(
      `select id, name, summary, tags, confidence, updated_at::text
         from episodes
        where project_id = $1 and archived_at is null
        order by updated_at desc
        limit 30`,
      [message.project_id],
    );

    const totalMemoryCount = await this.db.one<{ n: number }>(
      `select count(*)::int as n from memories where project_id = $1 and archived = false`,
      [message.project_id],
    );
    const totalEpisodeCount = await this.db.one<{ n: number }>(
      `select count(*)::int as n from episodes where project_id = $1 and archived_at is null`,
      [message.project_id],
    );

    const userPrompt = this.buildUserPrompt(
      project.name || project.slug || "this project",
      memories,
      episodes,
    );

    const providerConfig = await this.llmConfigResolver.resolve(message);
    const response = await this.llmGatewayService.tryGenerateObject<BriefingOutput>({
      providerConfig,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      maxOutputTokens: 1_200,
      timeoutMs: 45_000,
      schema: BriefingOutputSchema,
    });

    if (!response || !response.object.summary.trim()) {
      // LLM exhausted (all providers failed) — capture WHY so it
      // shows up in agentic_jobs.result and we don't have to grep the
      // worker logs to understand the silent skip. We still write a
      // placeholder row to `project_briefing_cache` so the API never
      // has to special-case the empty-cache state — readers see
      // `version: 0` + a `stale_at` in the past and behave the same
      // as a stale-cache refresh trigger.
      const providerChain = response?.meta?.providerChain ?? null;
      const breaker = this.llmGatewayService.getCircuitBreaker();
      const breakerStats = providerChain
        ? providerChain.map((id) => ({
            provider: id,
            state: breaker.getState(id),
            last_error: breaker.getStats(id).lastError,
          }))
        : null;
      const reason = response
        ? "LLM returned empty summary"
        : "no LLM response (all providers exhausted)";

      try {
        await this.db.query(
          `insert into project_briefing_cache (
             project_id, version, generated_at, stale_at,
             memory_count_at_generation, episode_count_at_generation,
             summary, themes, key_decisions, open_questions, stats, updated_at
           )
           values (
             $1, 0, now(), now() - interval '1 second',
             $2, $3,
             '(not yet generated)',
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
             $4::jsonb, now()
           )
           on conflict (project_id) do nothing`,
          [
            message.project_id,
            totalMemoryCount?.n ?? memories.length,
            totalEpisodeCount?.n ?? episodes.length,
            JSON.stringify({
              placeholder: true,
              reason,
              provider_chain: providerChain,
              breaker_stats: breakerStats,
            }),
          ],
        );
      } catch (err) {
        this.logger.warn(
          `[briefing] placeholder cache row insert failed project_id=${message.project_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      return {
        result: {
          skipped: true,
          reason,
          provider_chain: providerChain,
          breaker_stats: breakerStats,
          placeholder_written: true,
        },
        eventRoutingKey: ROUTING_KEY_BRIEFING_DONE,
      };
    }

    const briefing = response.object;
    const stats = {
      provider: response.provider,
      model: response.model,
      memories_sampled: memories.length,
      episodes_sampled: episodes.length,
      generated_by_message_id: message.message_id,
    };

    // UPSERT — one row per project. Bumps `version` on conflict; the
    // memory/episode counts and `stale_at` are snapshotted at write
    // time so the API can decide later whether to refresh.
    const upserted = await this.db.one<{ version: number }>(
      `insert into project_briefing_cache (
         project_id, version, generated_at, stale_at,
         memory_count_at_generation, episode_count_at_generation,
         summary, themes, key_decisions, open_questions, stats, updated_at
       )
       values (
         $1, 1, now(), now() + ($9 * interval '1 millisecond'),
         $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, now()
       )
       on conflict (project_id) do update set
         version = project_briefing_cache.version + 1,
         generated_at = excluded.generated_at,
         stale_at = excluded.stale_at,
         memory_count_at_generation = excluded.memory_count_at_generation,
         episode_count_at_generation = excluded.episode_count_at_generation,
         summary = excluded.summary,
         themes = excluded.themes,
         key_decisions = excluded.key_decisions,
         open_questions = excluded.open_questions,
         stats = excluded.stats,
         updated_at = now()
       returning version`,
      [
        message.project_id,
        totalMemoryCount?.n ?? memories.length,
        totalEpisodeCount?.n ?? episodes.length,
        briefing.summary,
        JSON.stringify(briefing.themes),
        JSON.stringify(briefing.key_decisions),
        JSON.stringify(briefing.open_questions),
        JSON.stringify(stats),
        STALE_AFTER_MS,
      ],
    );

    return {
      result: {
        generated: true,
        project_id: message.project_id,
        provider: response.provider,
        model: response.model,
        version: upserted?.version ?? 1,
        memories_used: memories.length,
        episodes_used: episodes.length,
      },
      eventRoutingKey: ROUTING_KEY_BRIEFING_DONE,
    };
  }

  private buildUserPrompt(
    projectName: string,
    memories: { id: string; content: string; kind: string; created_at: string }[],
    episodes: {
      id: string;
      name: string;
      summary: string | null;
      tags: string[] | null;
      confidence: number | null;
    }[],
  ): string {
    const memLines = memories.map((m, i) => {
      const stamp = m.created_at.slice(0, 10);
      const preview = (m.content || "").replace(/\s+/g, " ").slice(0, 280);
      return `${i + 1}. id=${m.id} (${stamp} · ${m.kind}) ${preview}`;
    });
    const epLines = episodes.map((e, i) => {
      const tag = (e.tags ?? []).slice(0, 4).join(",");
      const summary = (e.summary || "").replace(/\s+/g, " ").slice(0, 220);
      return `${i + 1}. id=${e.id} name="${e.name}" tags=[${tag}] conf=${e.confidence ?? "?"} :: ${summary}`;
    });
    return [
      `Project: ${projectName}`,
      "",
      `Recent memories (${memories.length}, newest first):`,
      memLines.join("\n") || "(none)",
      "",
      `Active episodes (${episodes.length}, most-recently updated first):`,
      epLines.join("\n") || "(none)",
      "",
      "Write the briefing.",
    ].join("\n");
  }
}
