import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  MEMORY_COMMANDS_EXCHANGE,
  MESSAGE_QUEUE_PUBLISHER,
} from "../mq/mq.constants";
import type { MessageQueuePublisher } from "../mq/message-queue-publisher";
import {
  type ClaimedOutboxEvent,
  OUTBOX_RELAY_STORE,
  type OutboxRelayStore,
} from "./outbox.constants";

interface RelayCommandMessage {
  message_id: string;
  correlation_id: string;
  causation_id: string | null;
  job_type: string;
  aggregate_type: string;
  aggregate_id: string;
  project_id: string;
  org_id: string | null;
  user_id: string;
  version_token: string;
  payload: Record<string, unknown>;
  published_at: string;
}

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly batchSize: number;
  private readonly activePollMs: number;
  private readonly idlePollMs: number;
  private readonly claimTtlSeconds: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  // After this many attempts on a single event we give up and
  // dead-letter it: `next_attempt_at` is pinned 100 years in the
  // future and `last_error` is prefixed with `[DEAD_LETTER]` so the
  // event is visible to a human operator without being re-tried by
  // the polling loop. Tunable for tests via OUTBOX_RELAY_MAX_ATTEMPTS.
  private readonly maxAttempts: number;
  // Sentinel pin for dead-letter rows. Chosen to be far past any
  // human-scale TTL; if someone really wants to re-run a DLQ event,
  // they can flip `next_attempt_at = now()` manually.
  private static readonly DEAD_LETTER_NEXT_ATTEMPT_AT =
    "9999-01-01T00:00:00.000Z";
  static readonly DEAD_LETTER_PREFIX = "[DEAD_LETTER]";

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  constructor(
    @Inject(OUTBOX_RELAY_STORE)
    private readonly outboxStore: OutboxRelayStore,
    @Inject(MESSAGE_QUEUE_PUBLISHER)
    private readonly publisher: MessageQueuePublisher,
    private readonly configService: ConfigService,
  ) {
    this.batchSize = this.configService.get<number>("OUTBOX_RELAY_BATCH_SIZE") ?? 50;
    this.activePollMs = this.configService.get<number>("OUTBOX_RELAY_ACTIVE_POLL_MS") ?? 250;
    this.idlePollMs = this.configService.get<number>("OUTBOX_RELAY_IDLE_POLL_MS") ?? 5000;
    this.claimTtlSeconds =
      this.configService.get<number>("OUTBOX_RELAY_CLAIM_TTL_SECONDS") ?? 30;
    this.retryBaseMs = this.configService.get<number>("OUTBOX_RELAY_RETRY_BASE_MS") ?? 1000;
    this.retryMaxMs = this.configService.get<number>("OUTBOX_RELAY_RETRY_MAX_MS") ?? 60000;
    this.maxAttempts =
      this.configService.get<number>("OUTBOX_RELAY_MAX_ATTEMPTS") ?? 20;
  }

  onModuleInit(): void {
    if (this.configService.get<string>("NODE_ENV") === "test") {
      return;
    }
    if (this.timer) {
      return;
    }
    this.scheduleNext(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async drainOnce(): Promise<number> {
    const claimed = await this.outboxStore.claimBatch(
      this.batchSize,
      this.claimTtlSeconds,
    );
    if (claimed.length === 0) {
      return 0;
    }

    let processed = 0;
    for (const event of claimed) {
      if (event.publishedAt) {
        continue;
      }
      await this.processEvent(event);
      processed += 1;
    }

    return processed;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) {
      return;
    }

    this.running = true;
    let nextDelay = this.idlePollMs;

    try {
      const processed = await this.drainOnce();
      nextDelay = processed > 0 ? this.activePollMs : this.idlePollMs;
    } catch (err) {
      this.logger.error(
        `[outbox.relay] tick failed err=${err instanceof Error ? err.message : String(err)}`,
      );
      nextDelay = this.idlePollMs;
    } finally {
      this.running = false;
      this.scheduleNext(nextDelay);
    }
  }

  private async processEvent(event: ClaimedOutboxEvent): Promise<void> {
    const claimToken = event.claimToken;
    if (!claimToken) {
      throw new Error(`claimed outbox event ${event.id} is missing claim_token`);
    }

    try {
      const publishPlan = this.buildPublishPlan(event);
      await this.publisher.publish(
        MEMORY_COMMANDS_EXCHANGE,
        publishPlan.routingKey,
        publishPlan.message,
        {
          messageId: publishPlan.message.message_id,
          headers: {
            correlation_id: publishPlan.message.correlation_id,
            job_type: publishPlan.message.job_type,
          },
        },
      );

      const stamped = await this.outboxStore.markPublished(
        event.id,
        claimToken,
        publishPlan.message.published_at,
      );
      if (!stamped) {
        this.logger.error(
          `[outbox.relay] publish confirmed but publish stamp was not persisted event_id=${event.id}`,
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // `claimBatch` already incremented `attempts` by 1, so
      // `event.attempts + 1` is the count this attempt will land at.
      // Once it crosses `maxAttempts` we pin the row out of rotation
      // with a `[DEAD_LETTER]` prefix on last_error and a far-future
      // next_attempt_at — see the class-level constants. Without
      // this, prod has seen a single event reach 383 attempts.
      const attemptsAfter = event.attempts + 1;
      const isDeadLetter = attemptsAfter >= this.maxAttempts;
      const persistedError = isDeadLetter
        ? `${OutboxRelayService.DEAD_LETTER_PREFIX} attempts=${attemptsAfter} :: ${errorMessage}`
        : errorMessage;
      const nextAttemptAt = isDeadLetter
        ? OutboxRelayService.DEAD_LETTER_NEXT_ATTEMPT_AT
        : new Date(
            Date.now() + this.computeBackoffMs(attemptsAfter),
          ).toISOString();

      const updated = await this.outboxStore.markFailed(
        event.id,
        claimToken,
        persistedError,
        nextAttemptAt,
      );
      if (!updated) {
        this.logger.error(
          `[outbox.relay] publish failed and failure state was not persisted event_id=${event.id} err=${errorMessage}`,
        );
        return;
      }

      if (isDeadLetter) {
        this.logger.error(
          `[outbox.relay] DEAD_LETTER event_id=${event.id} attempts=${attemptsAfter} err=${errorMessage}`,
        );
      } else {
        this.logger.warn(
          `[outbox.relay] publish failed event_id=${event.id} attempts=${attemptsAfter} next_attempt_at=${nextAttemptAt} err=${errorMessage}`,
        );
      }
    }
  }

  private buildPublishPlan(event: ClaimedOutboxEvent): {
    routingKey: string;
    message: RelayCommandMessage;
  } {
    switch (event.eventType) {
      case "memory.created": {
        const publishedAt = new Date().toISOString();
        const projectId = requireString(event.payload.project_id, "project_id", event.id);
        const userId = requireString(event.payload.owner_user_id, "owner_user_id", event.id);
        const versionToken = resolveVersionToken(event);

        return {
          // Topic exchange — routing key is the stage request name. Was
          // event.aggregateId back when the commands exchange was
          // x-modulus-hash (sharding plugin); now the single consumer
          // queue is bound with `#` so any key matches.
          routingKey: "memory.preprocess.request",
          message: {
            message_id: event.id,
            correlation_id: event.id,
            causation_id: null,
            job_type: "memory.preprocess",
            aggregate_type: event.aggregateType,
            aggregate_id: event.aggregateId,
            project_id: projectId,
            org_id: nullableString(event.payload.org_id),
            user_id: userId,
            version_token: versionToken,
            payload: {
              ...event.payload,
              source_event_type: event.eventType,
            },
            published_at: publishedAt,
          },
        };
      }
      // Briefings v2 — the API enqueues a refresh when a cached row is
      // stale or cold. Translate it into a `project.briefing` command
      // the worker's command consumer will pick up.
      case "project.briefing.refresh": {
        const publishedAt = new Date().toISOString();
        const projectId = requireString(event.payload.project_id, "project_id", event.id);
        return {
          routingKey: projectId,
          message: {
            message_id: event.id,
            correlation_id: event.id,
            causation_id: null,
            job_type: "project.briefing",
            aggregate_type: "project",
            aggregate_id: projectId,
            project_id: projectId,
            org_id: nullableString(event.payload.org_id),
            // Briefing refreshes are project-scoped, not user-scoped;
            // there's no owning user for a "the cache is stale" event.
            // Fall back to an all-zero sentinel so the downstream
            // `user_id` contract stays a string.
            user_id:
              nullableString(event.payload.requested_by_user_id) ??
              "00000000-0000-0000-0000-000000000000",
            version_token: resolveVersionToken(event),
            payload: {
              ...event.payload,
              source_event_type: event.eventType,
            },
            published_at: publishedAt,
          },
        };
      }
      default:
        throw new Error(`unsupported outbox event_type=${event.eventType}`);
    }
  }

  private computeBackoffMs(attemptNumber: number): number {
    const cappedExponent = Math.max(attemptNumber - 1, 0);
    const backoff = this.retryBaseMs * 2 ** cappedExponent;
    return Math.min(backoff, this.retryMaxMs);
  }
}

function requireString(
  value: unknown,
  key: string,
  eventId: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`outbox event ${eventId} missing payload.${key}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveVersionToken(event: ClaimedOutboxEvent): string {
  if (typeof event.payload.updated_at === "string" && event.payload.updated_at.length > 0) {
    return event.payload.updated_at;
  }
  if (typeof event.payload.created_at === "string" && event.payload.created_at.length > 0) {
    return event.payload.created_at;
  }
  return event.createdAt;
}
