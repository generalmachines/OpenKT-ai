import type { ActorContext } from "@openkt/core-context";

/**
 * Generic outbox port.
 *
 * Domain modules write events here in the same transactional context as
 * the aggregate write. A separate relay (sibling worker / cron) reads
 * unpublished rows, fans them out to RabbitMQ, then stamps published_at.
 *
 * The shape mirrors `outbox_events` in the migration. Domain code
 * depends only on this port — never on the Supabase adapter.
 */
export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxEventRecord extends OutboxEventInput {
  id: string;
  publishedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface OutboxEventRepository {
  /**
   * Persist a new outbox event. Insert is idempotent only by primary
   * key (the table has a UUID default). Callers handling retries should
   * supply their own dedupe key in `payload` if needed.
   */
  enqueue(context: ActorContext, event: OutboxEventInput): Promise<OutboxEventRecord>;
}
