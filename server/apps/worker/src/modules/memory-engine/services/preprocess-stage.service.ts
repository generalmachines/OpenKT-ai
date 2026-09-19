import { Injectable } from "@nestjs/common";

import {
  isSameVersion,
  nextCommand,
  type PipelineCommandMessage,
  type StageExecutionResult,
} from "../pipeline-message";
import { ROUTING_KEY_PREPROCESS_DONE } from "../../mq/mq.constants";
import { WorkerPgService } from "../../database/worker-pg.service";

@Injectable()
export class PreprocessStageService {
  constructor(private readonly db: WorkerPgService) {}

  async execute(message: PipelineCommandMessage): Promise<StageExecutionResult> {
    const memory = await this.db.one<{
      id: string;
      project_id: string;
      org_id: string | null;
      owner_user_id: string;
      archived: boolean;
      updated_at: string;
    }>(
      `select id, project_id, org_id, owner_user_id, archived, updated_at::text
         from memories
        where id = $1`,
      [message.aggregate_id],
    );

    if (!memory) {
      return {
        result: { skipped: true, reason: "memory not found" },
        eventRoutingKey: ROUTING_KEY_PREPROCESS_DONE,
      };
    }

    if (memory.archived) {
      return {
        result: { skipped: true, reason: "memory archived" },
        eventRoutingKey: ROUTING_KEY_PREPROCESS_DONE,
      };
    }

    if (!isSameVersion(memory.updated_at, message.version_token)) {
      return {
        result: {
          skipped: true,
          reason: "stale version",
          expected_version: memory.updated_at,
          received_version: message.version_token,
        },
        eventRoutingKey: ROUTING_KEY_PREPROCESS_DONE,
      };
    }

    return {
      result: {
        // Per-memory fan-out is now just `memory.embed` — the chain
        // continues `embed → triage → episode → synthesize?` where
        // synthesize only fires when triage flagged a supersede.
        // `member_knowledge` and `briefing` no longer fan out per
        // memory; the worker batches them via a 5-minute cron
        // (Member Knowledge Batch / Briefing Batch services) that
        // scans for projects with new memories and emits one job per
        // project. Semantic neighbors are computed lazily on first
        // recall in the server (MemoryRecallService) and cached for
        // 24h in `memory_neighbors`.
        queued: ["memory.embed"],
        project_id: memory.project_id,
        memory_id: memory.id,
      },
      commands: [
        nextCommand(message, {
          jobType: "memory.embed",
          payload: {
            memory_id: memory.id,
            project_id: memory.project_id,
            org_id: memory.org_id,
            owner_user_id: memory.owner_user_id,
          },
        }),
      ],
      eventRoutingKey: ROUTING_KEY_PREPROCESS_DONE,
    };
  }
}
