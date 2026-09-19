import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { outboxEvents } from "../../../db/schema";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import {
  BriefingResponseSchema,
  type BriefingResponse,
} from "../contracts/briefing.contract";
import { BriefingCacheRepository } from "../repositories/briefing-cache.repository";

// Briefings-v2 application service — the cached "live view" surface.
//
// `getBriefing` enforces project membership, then returns the cached
// row. When the row is missing OR `stale_at < now()` the service
// enqueues a `project.briefing.refresh` outbox event so the worker
// will recompute lazily, then returns whatever it has (with `stale:
// true` so the UI can show a refresh hint).
//
// We never block on a refresh: the LLM pass is too slow for an HTTP
// roundtrip. The first call on a brand-new project returns a synthetic
// "empty" response with `stale: true` and version 0.

@Injectable()
export class BriefingService {
  private readonly logger = new Logger(BriefingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly scope: ProjectScopeService,
    private readonly cache: BriefingCacheRepository,
  ) {}

  async getBriefing(
    context: ActorContext,
    projectId: string,
  ): Promise<BriefingResponse> {
    await this.scope.requireProjectAccess(context, projectId, "read");

    const row = await this.cache.getByProjectId(projectId);
    const now = Date.now();

    if (!row) {
      // Cold start: enqueue a refresh and return an empty stale shell.
      await this.enqueueRefresh(projectId, "cold-start");
      const placeholder: BriefingResponse = {
        project_id: projectId,
        version: 0,
        generated_at: new Date().toISOString(),
        stale_at: null,
        stale: true,
        memory_count_at_generation: 0,
        episode_count_at_generation: 0,
        summary: "",
        themes: [],
        key_decisions: [],
        open_questions: [],
        stats: { reason: "cold-start" },
      };
      return BriefingResponseSchema.parse(placeholder);
    }

    const isStale = row.stale_at !== null && Date.parse(row.stale_at) < now;
    if (isStale) {
      await this.enqueueRefresh(projectId, "stale");
    }

    return BriefingResponseSchema.parse({
      project_id: row.project_id,
      version: row.version,
      generated_at: row.generated_at,
      stale_at: row.stale_at,
      stale: isStale,
      memory_count_at_generation: row.memory_count_at_generation,
      episode_count_at_generation: row.episode_count_at_generation,
      summary: row.summary,
      themes: row.themes,
      key_decisions: row.key_decisions,
      open_questions: row.open_questions,
      stats: row.stats,
    });
  }

  // The worker's command consumer treats outbox events of type
  // `project.briefing` as a request to run the briefing stage. We
  // intentionally don't await any RabbitMQ publish here — the outbox
  // pattern guarantees eventual delivery, and the API path stays cheap.
  private async enqueueRefresh(
    projectId: string,
    reason: "cold-start" | "stale",
  ): Promise<void> {
    try {
      await this.db.insert(outboxEvents).values({
        aggregateType: "project",
        aggregateId: projectId,
        eventType: "project.briefing.refresh",
        payload: {
          project_id: projectId,
          reason,
          requested_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[briefing] refresh enqueue failed project_id=${projectId} reason=${reason} err=${message}`,
      );
      // Swallow — a failed enqueue is not worth turning a successful
      // cache read into a 500. The next read will retry.
    }
  }
}
