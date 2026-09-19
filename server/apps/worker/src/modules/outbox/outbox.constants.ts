export const OUTBOX_RELAY_STORE = Symbol("OUTBOX_RELAY_STORE");

export interface ClaimedOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  publishedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
  claimToken: string | null;
  claimedAt: string | null;
}

export interface OutboxRelayStore {
  claimBatch(limit: number, claimTtlSeconds: number): Promise<ClaimedOutboxEvent[]>;
  markPublished(eventId: string, claimToken: string, publishedAt: string): Promise<boolean>;
  markFailed(
    eventId: string,
    claimToken: string,
    errorMessage: string,
    nextAttemptAt: string,
  ): Promise<boolean>;
}
