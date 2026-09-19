import { Injectable } from "@nestjs/common";

import {
  EMBEDDING_MODEL,
  embed,
  toPgVector,
} from "../../../../../server/src/modules/memory/repositories/embedding-bge";
import {
  isSameVersion,
  nextCommand,
  type PipelineCommandMessage,
  type StageExecutionResult,
} from "../pipeline-message";
import { ROUTING_KEY_EMBED_DONE } from "../../mq/mq.constants";
import { WorkerPgService } from "../../database/worker-pg.service";

@Injectable()
export class EmbedStageService {
  constructor(private readonly db: WorkerPgService) {}

  async execute(message: PipelineCommandMessage): Promise<StageExecutionResult> {
    const memory = await this.db.one<{
      id: string;
      content: string;
      project_id: string;
      org_id: string | null;
      owner_user_id: string;
      archived: boolean;
      updated_at: string;
    }>(
      `select id, content, project_id, org_id, owner_user_id,
              archived, updated_at::text
         from memories
        where id = $1`,
      [message.aggregate_id],
    );

    if (!memory) {
      return {
        result: { skipped: true, reason: "memory not found" },
        eventRoutingKey: ROUTING_KEY_EMBED_DONE,
      };
    }

    if (memory.archived) {
      return {
        result: { skipped: true, reason: "memory archived" },
        eventRoutingKey: ROUTING_KEY_EMBED_DONE,
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
        eventRoutingKey: ROUTING_KEY_EMBED_DONE,
      };
    }

    // Embedding is OUR data — recall queries pgvector directly against
    // `memories.embedding`. We always run the embed pass and write the
    // vector. We also
    // re-embed even when an embedding is already present so a content
    // edit on the same row will refresh the vector — `nextCommand`
    // carries the new `updated_at` forward to keep version tokens in
    // sync with the row state.
    const vector = await embed(memory.content);
    if (!vector) {
      return {
        result: { skipped: true, reason: "embedding unavailable" },
        eventRoutingKey: ROUTING_KEY_EMBED_DONE,
      };
    }

    const updated = await this.db.one<{ updated_at: string }>(
      `update memories
          set embedding = $2::vector,
              updated_at = now()
        where id = $1
        returning updated_at::text`,
      [memory.id, toPgVector(vector)],
    );

    const nextVersion = updated?.updated_at ?? memory.updated_at;

    return {
      result: {
        embedded: true,
        memory_id: memory.id,
        model: EMBEDDING_MODEL,
      },
      commands: [
        nextCommand(message, {
          jobType: "memory.triage",
          versionToken: nextVersion,
          payload: {
            memory_id: memory.id,
            project_id: memory.project_id,
            org_id: memory.org_id,
            owner_user_id: memory.owner_user_id,
          },
        }),
        // Neighbors are no longer pre-computed per memory — the server
        // computes them lazily on first recall and caches the result
        // in `memory_neighbors` for 24h. See
        // MemoryRecallService.ensureNeighborsFresh.
      ],
      eventRoutingKey: ROUTING_KEY_EMBED_DONE,
    };
  }
}
