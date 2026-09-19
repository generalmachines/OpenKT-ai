import { Injectable } from "@nestjs/common";
import { z } from "zod";

import { LlmGatewayService } from "@openkt/platform-llm";

import {
  EMBEDDING_DIM,
  toPgVector,
} from "../../../../../server/src/modules/memory/repositories/embedding-bge";
import {
  isSameVersion,
  nextCommand,
  type PipelineCommandMessage,
  type StageExecutionResult,
} from "../pipeline-message";
import { ROUTING_KEY_EPISODE_DONE } from "../../mq/mq.constants";
import { WorkerPgService } from "../../database/worker-pg.service";
import { WorkerLlmConfigResolverService } from "./worker-llm-config-resolver.service";

const JOIN_THRESHOLD = 0.65;
const MAX_NEIGHBOURS = 6;
const MIN_CLUSTER_SIZE = 2;

const NameSchema = z.object({
  name: z.string().min(1).max(200),
  summary: z.string().min(1).max(800),
});

@Injectable()
export class EpisodeStageService {
  constructor(
    private readonly db: WorkerPgService,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly llmConfigResolver: WorkerLlmConfigResolverService,
  ) {}

  async execute(message: PipelineCommandMessage): Promise<StageExecutionResult> {
    const inner = await this.runEpisodeStage(message);
    // The synthesize stage runs after episode ONLY when triage flagged
    // a supersede (carried via the `synthesize_eligible` payload flag).
    // For all other memories the LLM-driven knowledge-node synthesis
    // is no longer eager — the raw memory is fully queryable through
    // embed + tags + episode without it, and the heavy O(memories) LLM
    // pass is deferred. Memories that are missing / wrong version /
    // archived are flagged `terminal: true` and don't continue at all.
    if (inner.terminal) {
      const { terminal: _terminal, ...rest } = inner;
      return rest;
    }
    const { terminal: _terminal, ...rest } = inner;
    const synthesizeEligible =
      (message.payload as { synthesize_eligible?: boolean } | undefined)
        ?.synthesize_eligible === true;
    if (!synthesizeEligible) {
      return rest;
    }
    return {
      ...rest,
      commands: [
        ...(rest.commands ?? []),
        nextCommand(message, {
          jobType: "memory.synthesize",
          payload: {
            ...message.payload,
            memory_id: message.aggregate_id,
            project_id: message.project_id,
          },
        }),
      ],
    };
  }

  private async runEpisodeStage(
    message: PipelineCommandMessage,
  ): Promise<StageExecutionResult & { terminal: boolean }> {
    const memory = await this.db.one<{
      id: string;
      content: string;
      project_id: string;
      org_id: string | null;
      owner_user_id: string;
      embedding: number[] | string | null;
      archived: boolean;
      superseded_by: string | null;
      updated_at: string;
    }>(
      `select id, content, project_id, org_id, owner_user_id, embedding::text as embedding,
              archived, superseded_by, updated_at::text
         from memories
        where id = $1`,
      [message.aggregate_id],
    );

    if (!memory) {
      return {
        result: { skipped: true, reason: "memory not found" },
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: true,
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
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: true,
      };
    }

    if (memory.archived || memory.superseded_by) {
      return {
        result: { skipped: true, reason: "memory already archived/superseded" },
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: true,
      };
    }

    const vector = coerceVector(memory.embedding);
    const hasLocalEmbedding = !!(vector && vector.length === EMBEDDING_DIM);

    let candidates: Array<{ id: string; similarity: number }>;

    if (hasLocalEmbedding) {
      // pgvector nearest neighbours within the same project.
      candidates = (
        await this.db.query<{ id: string; similarity: number }>(
          `select id, (1 - (embedding <=> $2::vector))::real as similarity
             from memories
            where project_id = $1
              and archived = false
              and embedding is not null
              and id <> $3
            order by embedding <=> $2::vector
            limit $4`,
          [memory.project_id, toPgVector(vector!), memory.id, MAX_NEIGHBOURS],
        )
      ).filter((row) => row.similarity >= JOIN_THRESHOLD);
    } else {
      return {
        result: { skipped: true, reason: "embedding missing" },
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: false,
      };
    }
    if (candidates.length === 0) {
      return {
        result: { skipped: true, reason: "no strong neighbours" },
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: false,
      };
    }

    const candidateIds = candidates.map((candidate) => candidate.id);
    const existingLinks = await this.db.query<{ episode_id: string; memory_id: string }>(
      `select episode_id, memory_id
         from episode_memories
        where memory_id = any($1::uuid[])`,
      [candidateIds],
    );
    if (existingLinks.length > 0) {
      const similarityByMemoryId = new Map(
        candidates.map((candidate) => [candidate.id, candidate.similarity]),
      );
      let best: { episodeId: string; similarity: number } | null = null;
      for (const link of existingLinks) {
        const similarity = similarityByMemoryId.get(link.memory_id) ?? 0;
        if (!best || similarity > best.similarity) {
          best = { episodeId: link.episode_id, similarity };
        }
      }

      if (best) {
        await this.db.query(
          `insert into episode_memories (episode_id, memory_id, similarity_at_join)
           values ($1, $2, $3)
           on conflict (episode_id, memory_id)
           do update set similarity_at_join = excluded.similarity_at_join`,
          [best.episodeId, memory.id, best.similarity],
        );

        await recomputeCentroid(this.db, best.episodeId);

        return {
          result: {
            joined: true,
            episode_id: best.episodeId,
            similarity: best.similarity,
          },
          eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
          terminal: false,
        };
      }
    }

    if (candidates.length < MIN_CLUSTER_SIZE) {
      return {
        result: { skipped: true, reason: "not enough neighbours for a new episode" },
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: false,
      };
    }

    const candidateRows = await this.db.query<{ id: string; content: string; kind: string }>(
      `select id, content, kind from memories where id = any($1::uuid[])`,
      [candidateIds],
    );

    const clusterBlock = [memory, ...candidateRows.slice(0, MAX_NEIGHBOURS)]
      .map((row, index) => `${index + 1}. ${(row.content || "").replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n");

    const response = await this.llmGatewayService.tryGenerateObject({
      providerConfig: await this.llmConfigResolver.resolve(message),
      messages: [
        {
          role: "system",
          content:
            "You name and summarize an episode - a cluster of related project memories. " +
            "Rules: name is a short noun phrase (3-8 words), summary is 1-3 sentences, and if the cluster is not coherent set both fields empty. " +
            'Respond with only {"name":"...","summary":"..."}.',
        },
        {
          role: "user",
          content: `Cluster of memories (most-similar group, project-scoped):\n\n${clusterBlock}`,
        },
      ],
      schema: NameSchema,
      maxOutputTokens: 400,
      timeoutMs: 30_000,
    });

    if (!response || !response.object.name.trim()) {
      return {
        result: { skipped: true, reason: "no LLM response" },
        eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
        terminal: false,
      };
    }

    // Centroid is a per-episode 1024d vector used for episode-level
    // recall. It can only be computed when the member memories have
    // embeddings; otherwise it stays null — the episode row is still
    // useful (name + summary + member set).
    let centroidPgVector: string | null = null;
    if (hasLocalEmbedding) {
      const vectorRows = await this.db.query<{ id: string; embedding: string | null }>(
        `select id, embedding::text as embedding
           from memories
          where id = any($1::uuid[])`,
        [[memory.id, ...candidateIds]],
      );
      const vectors = vectorRows
        .map((row) => coerceVector(row.embedding))
        .filter((value): value is number[] => value !== null && value.length === EMBEDDING_DIM);
      if (vectors.length > 0) {
        centroidPgVector = toPgVector(meanVector(vectors));
      }
    }

    const episodeRow = await this.db.one<{ id: string }>(
      `insert into episodes (org_id, project_id, name, summary, embedding)
       values ($1, $2, $3, $4, $5::vector)
       returning id`,
      [
        memory.org_id,
        memory.project_id,
        response.object.name.trim(),
        response.object.summary.trim(),
        centroidPgVector,
      ],
    );
    if (!episodeRow) throw new Error("episode insert failed");

    const episodeId = episodeRow.id;
    const linkRows = [memory.id, ...candidateIds].map((memoryId) => ({
      episode_id: episodeId,
      memory_id: memoryId,
      similarity_at_join: candidates.find((candidate) => candidate.id === memoryId)?.similarity ?? null,
    }));

    for (const row of linkRows) {
      await this.db.query(
        `insert into episode_memories (episode_id, memory_id, similarity_at_join)
         values ($1, $2, $3)
         on conflict (episode_id, memory_id)
         do update set similarity_at_join = excluded.similarity_at_join`,
        [row.episode_id, row.memory_id, row.similarity_at_join],
      );
    }

    return {
      result: {
        created: true,
        episode_id: episodeId,
        name: response.object.name.trim(),
        member_count: linkRows.length,
      },
      eventRoutingKey: ROUTING_KEY_EPISODE_DONE,
      terminal: false,
    };
  }
}

async function recomputeCentroid(
  db: WorkerPgService,
  episodeId: string,
): Promise<void> {
  // No-op when no member has an embedding — the episode keeps a
  // null centroid.
  const data = await db.query<{ embedding: string | null }>(
    `select m.embedding::text as embedding
       from episode_memories em
       join memories m on m.id = em.memory_id
      where em.episode_id = $1
        and m.embedding is not null`,
    [episodeId],
  );

  const vectors = data
    .map((row) => coerceVector(row.embedding))
    .filter((value): value is number[] => value !== null && value.length === EMBEDDING_DIM);
  if (vectors.length === 0) {
    return;
  }

  await db.query(
    `update episodes set embedding = $2::vector, updated_at = now() where id = $1`,
    [episodeId, toPgVector(meanVector(vectors))],
  );
}

function coerceVector(raw: number[] | string | null): number[] | null {
  if (!raw) {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  try {
    return raw
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((value) => parseFloat(value));
  } catch {
    return null;
  }
}

function meanVector(vectors: number[][]): number[] {
  const out = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < EMBEDDING_DIM; i += 1) {
      out[i] += vector[i];
    }
  }
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    out[i] /= vectors.length;
  }
  return out;
}
