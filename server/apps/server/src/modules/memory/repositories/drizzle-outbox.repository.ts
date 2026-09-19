import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";
import type {
  OutboxEventInput,
  OutboxEventRecord,
  OutboxEventRepository,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { outboxEvents } from "../../../db/schema";

@Injectable()
export class DrizzleOutboxRepository implements OutboxEventRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async enqueue(
    _context: ActorContext,
    event: OutboxEventInput,
  ): Promise<OutboxEventRecord> {
    const [created] = await this.db
      .insert(outboxEvents)
      .values({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      })
      .returning()
      .catch((err: Error) => {
        throw new ValidationDomainError("outbox enqueue failed", {
          aggregateType: event.aggregateType,
          eventType: event.eventType,
          cause: err.message,
        });
      });

    if (!created) {
      throw new ValidationDomainError("outbox enqueue failed", {
        aggregateType: event.aggregateType,
        eventType: event.eventType,
      });
    }

    return {
      id: created.id,
      aggregateType: created.aggregateType,
      aggregateId: created.aggregateId,
      eventType: created.eventType,
      payload: (created.payload ?? {}) as Record<string, unknown>,
      publishedAt: created.publishedAt ? this.iso(created.publishedAt) : null,
      attempts: created.attempts,
      lastError: created.lastError,
      createdAt: this.iso(created.createdAt),
    };
  }

  private iso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : String(value);
  }
}
