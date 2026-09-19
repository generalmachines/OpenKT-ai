import { Injectable } from "@nestjs/common";

import { WorkerPgService } from "../database/worker-pg.service";
import type { ClaimedOutboxEvent, OutboxRelayStore } from "./outbox.constants";

interface OutboxRelayRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  published_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  claim_token: string | null;
  claimed_at: string | null;
}

@Injectable()
export class LocalPgOutboxRepository implements OutboxRelayStore {
  constructor(private readonly db: WorkerPgService) {}

  async claimBatch(
    limit: number,
    claimTtlSeconds: number,
  ): Promise<ClaimedOutboxEvent[]> {
    const rows = await this.db.query<OutboxRelayRow>(
      `
        with candidates as (
          select id
          from outbox_events
          where published_at is null
            and next_attempt_at <= now()
            and (
              claim_token is null
              or claimed_at < now() - ($2::int * interval '1 second')
            )
          order by created_at asc
          limit $1
          for update skip locked
        )
        update outbox_events event
        set claim_token = uuid_generate_v4()::text,
            claimed_at = now(),
            attempts = attempts + 1
        from candidates
        where event.id = candidates.id
        returning event.*
      `,
      [limit, claimTtlSeconds],
    );

    return rows.map(mapRow);
  }

  async markPublished(
    eventId: string,
    claimToken: string,
    publishedAt: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `
        update outbox_events
        set published_at = $3,
            last_error = null,
            claim_token = null,
            claimed_at = null
        where id = $1
          and claim_token = $2
          and published_at is null
        returning id
      `,
      [eventId, claimToken, publishedAt],
    );
    return rows.length === 1;
  }

  async markFailed(
    eventId: string,
    claimToken: string,
    errorMessage: string,
    nextAttemptAt: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `
        update outbox_events
        set last_error = $3,
            next_attempt_at = $4,
            claim_token = null,
            claimed_at = null
        where id = $1
          and claim_token = $2
          and published_at is null
        returning id
      `,
      [eventId, claimToken, truncateError(errorMessage), nextAttemptAt],
    );
    return rows.length === 1;
  }
}

function mapRow(row: OutboxRelayRow): ClaimedOutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload ?? {},
    publishedAt: row.published_at,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
  };
}

function truncateError(message: string): string {
  return message.length > 4000 ? `${message.slice(0, 3997)}...` : message;
}
