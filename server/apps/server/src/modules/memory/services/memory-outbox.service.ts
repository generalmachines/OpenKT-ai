import { Injectable, Logger } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";

import type { MemoryRecord } from "../contracts/memory.contract";
import { DrizzleOutboxRepository } from "../repositories/drizzle-outbox.repository";

/**
 * Memory-domain outbox publisher. Sits between the command service and the generic
 * outbox repository so memory-specific event types and payload shapes
 * stay in this module instead of leaking into the data tier.
 *
 * Sync write path emits ONE event per memory mutation. The worker
 * (Track C) consumes the resulting RabbitMQ message and runs the
 * triage / episode / embedding stages out-of-band. None of that
 * machinery exists yet — at this phase we only durably enqueue the
 * event so it is recoverable when the worker lands.
 *
 * Failure semantics: the write path is only considered complete once
 * the outbox row is durable. If this enqueue fails we surface a
 * domain error so the caller can treat the request as failed instead
 * of silently dropping the async work trigger.
 */
@Injectable()
export class MemoryOutboxService {
  private readonly logger = new Logger(MemoryOutboxService.name);

  constructor(private readonly outboxRepository: DrizzleOutboxRepository) {}

  /**
   * Publish a `memory.created` event for the worker to pick up.
   *
   * Payload shape is intentionally narrow — only what downstream
   * stages need to start work without re-reading the row. The worker
   * is free to re-fetch the canonical row by `aggregateId`.
   */
  async publishCreated(context: ActorContext, memory: MemoryRecord): Promise<void> {
    try {
      await this.outboxRepository.enqueue(context, {
        aggregateType: "memory",
        aggregateId: memory.id,
        eventType: "memory.created",
        payload: {
          memory_id: memory.id,
          project_id: memory.project_id,
          org_id: memory.org_id,
          owner_user_id: memory.owner.user_id,
          kind: memory.kind,
          visibility: memory.visibility,
          content_length: memory.content.length,
          source_refs: memory.source_refs,
          created_at: memory.created_at,
          updated_at: memory.updated_at,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[memory.outbox] enqueue memory.created failed memory_id=${memory.id} err=${message}`,
      );
      throw new ValidationDomainError(
        "memory outbox enqueue failed",
        {
          memory_id: memory.id,
          cause: message,
        },
      );
    }
  }
}
