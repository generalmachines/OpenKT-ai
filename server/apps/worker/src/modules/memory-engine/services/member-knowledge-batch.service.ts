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
  ROUTING_KEY_MEMBER_KNOWLEDGE_REQUEST,
} from "../../mq/mq.constants";
import type { MessageQueuePublisher } from "../../mq/message-queue-publisher";
import type { PipelineCommandMessage } from "../pipeline-message";
import { WorkerPgService } from "../../database/worker-pg.service";

// Batched member-knowledge synthesis. Previously every memory fanned
// out a `memory.member_knowledge` command from preprocess — at one job
// per memory the pipeline scaled O(memories) on a stage whose payload
// is naturally per-(project, user). This service runs on a 5-minute
// cron, scans for projects with memories newer than the project's last
// member_knowledge rollup, and emits ONE job per affected project. The
// stage itself (member-knowledge-stage.service) iterates over stale
// contributors and upserts (project_id, user_id) — so a single job per
// project covers every contributor that needs a refresh.
//
// We bake the 5-minute interval at module init (no env knob) per the
// final-push directive — one fewer thing to misconfigure in prod.

const INTERVAL_MS = 5 * 60_000;

@Injectable()
export class MemberKnowledgeBatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemberKnowledgeBatchService.name);
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
    // First tick after one INTERVAL_MS — boot startup is busy enough
    // without a synchronous fan-out the moment the worker comes up.
    this.timer = setInterval(() => this.runSafe(), INTERVAL_MS);
    this.logger.log(`member-knowledge batch scheduled (every ${INTERVAL_MS / 1000}s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runSafe(): Promise<void> {
    try {
      const count = await this.tick();
      if (count > 0) {
        this.logger.log(`member-knowledge batch fanned out ${count} project(s)`);
      }
    } catch (err) {
      this.logger.error(
        `member-knowledge batch tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * One pass: find projects with at least one memory updated since
   * their most recent member_knowledge rollup (or in the last 5min if
   * no rollup exists yet) and publish a single
   * `memory.member_knowledge.request` per such project. Public so a
   * future ops tool can trigger an on-demand batch without booting the
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
           and m.owner_user_id is not null
         group by m.project_id
      )
      select pl.project_id::text as project_id,
             p.org_id::text       as org_id,
             p.owner_user_id::text as owner_user_id,
             pl.latest_updated_at::text as latest_updated_at
        from project_latest pl
        join projects p on p.id = pl.project_id
        left join lateral (
          select max(last_synthesized_at) as last_synthesized_at
            from member_knowledge mk
           where mk.project_id = pl.project_id
        ) mk on true
       where coalesce(mk.last_synthesized_at, 'epoch'::timestamptz) < pl.latest_updated_at
          or pl.latest_updated_at > $1::timestamptz
      `,
      [cutoffIso],
    );

    for (const project of projects) {
      const command: PipelineCommandMessage = {
        message_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        causation_id: null,
        job_type: "memory.member_knowledge",
        aggregate_type: "project",
        aggregate_id: project.project_id,
        project_id: project.project_id,
        org_id: project.org_id,
        user_id: project.owner_user_id,
        version_token: project.latest_updated_at,
        payload: {
          project_id: project.project_id,
          // No `memory_id` — this is project-coalesced. The
          // member-knowledge stage scans for stale contributors itself.
          batch: "cron",
        },
        published_at: new Date().toISOString(),
      };
      await this.publisher.publish(
        MEMORY_COMMANDS_EXCHANGE,
        ROUTING_KEY_MEMBER_KNOWLEDGE_REQUEST,
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
