import crypto from "node:crypto";

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import {
  MESSAGE_QUEUE_PUBLISHER,
  MEMORY_COMMANDS_EXCHANGE,
  ROUTING_KEY_BRIEFING_REQUEST,
} from "../../mq/mq.constants";
import type { MessageQueuePublisher } from "../../mq/message-queue-publisher";
import type { PipelineCommandMessage } from "../pipeline-message";
import { WorkerPgService } from "../../database/worker-pg.service";

// Batched project briefings. Previously every memory fanned out a
// `project.briefing` command from preprocess — N memories in a
// project produced N briefing jobs, with only the FRESH_WINDOW_MS
// debouncer in the briefing stage saving us from N LLM passes. This
// service runs on a 5-minute cron, queries projects with at least one
// memory updated since the project's cached briefing was generated,
// and emits ONE briefing job per such project.
//
// 5-minute interval is baked in (no env knob) per the final-push
// directive — the briefing stage's own FRESH_WINDOW_MS (5min) lines
// up so back-to-back ticks against a quiet project are coalesced
// inside the stage anyway.

const INTERVAL_MS = 5 * 60_000;

@Injectable()
export class BriefingBatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BriefingBatchService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pg: WorkerPgService,
    @Inject(MESSAGE_QUEUE_PUBLISHER)
    private readonly publisher: MessageQueuePublisher,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") {
      return;
    }
    this.timer = setInterval(() => this.runSafe(), INTERVAL_MS);
    this.logger.log(`briefing batch scheduled (every ${INTERVAL_MS / 1000}s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runSafe(): Promise<void> {
    try {
      const count = await this.tick();
      if (count > 0) {
        this.logger.log(`briefing batch fanned out ${count} project(s)`);
      }
    } catch (err) {
      this.logger.error(
        `briefing batch tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * One pass: find projects whose most recently updated memory is
   * newer than the project's cached briefing `generated_at` (or
   * within the last 5min if no cache row exists) and publish one
   * `project.briefing.request` per such project. Public so a future
   * ops tool can trigger an on-demand pass without booting the
   * scheduler.
   */
  async tick(): Promise<number> {
    const cutoffIso = new Date(Date.now() - INTERVAL_MS).toISOString();
    const projects = await this.pg.query<{
      project_id: string;
      org_id: string | null;
      owner_user_id: string;
      latest_updated_at: string;
    }>(
      `
      with project_latest as (
        select m.project_id,
               max(m.updated_at) as latest_updated_at
          from memories m
         where m.archived = false
         group by m.project_id
      )
      select pl.project_id::text as project_id,
             p.org_id::text       as org_id,
             p.owner_user_id::text as owner_user_id,
             pl.latest_updated_at::text as latest_updated_at
        from project_latest pl
        join projects p on p.id = pl.project_id
        left join project_briefing_cache pbc on pbc.project_id = pl.project_id
       where coalesce(pbc.generated_at, 'epoch'::timestamptz) < pl.latest_updated_at
          or pl.latest_updated_at > $1::timestamptz
      `,
      [cutoffIso],
    );

    for (const project of projects) {
      const command: PipelineCommandMessage = {
        message_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        causation_id: null,
        job_type: "project.briefing",
        aggregate_type: "project",
        aggregate_id: project.project_id,
        project_id: project.project_id,
        org_id: project.org_id,
        user_id: project.owner_user_id,
        version_token: project.latest_updated_at,
        payload: {
          project_id: project.project_id,
          batch: "cron",
        },
        published_at: new Date().toISOString(),
      };
      await this.publisher.publish(
        MEMORY_COMMANDS_EXCHANGE,
        ROUTING_KEY_BRIEFING_REQUEST,
        command,
        {
          messageId: command.message_id,
          headers: {
            correlation_id: command.correlation_id,
            job_type: command.job_type,
          },
        },
      );
    }
    return projects.length;
  }
}
