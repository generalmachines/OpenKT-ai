import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  AmqpConnectionManager,
  ChannelWrapper,
  Options,
} from "amqp-connection-manager";

import { RMQ_CONNECTION_MANAGER } from "./mq.constants";
import type { MessageQueuePublisher } from "./message-queue-publisher";

export interface PublishOptions {
  /**
   * Optional headers (e.g. correlation id, causation id, x-retry-count).
   * The relay layer is the canonical place to stamp the standard envelope
   * fields — this just lets the caller layer extras on top.
   */
  headers?: Record<string, string | number | boolean>;
  /**
   * Per-call override of `messageId`. If omitted, callers should set their
   * own deterministic id in the payload — this argument exists so the
   * relay can mirror the outbox row id onto the AMQP envelope.
   */
  messageId?: string;
  /**
   * Override the broker confirm timeout (ms). Defaults to
   * RMQ_PUBLISHER_CONFIRM_TIMEOUT_MS / 5000.
   */
  timeoutMs?: number;
}

/**
 * RmqPublisher — confirm-channel publisher for "no packet lost" sends.
 *
 * Why a confirm channel: the official Nest RMQ doc routes through
 * ClientProxy which does NOT expose publisher confirms. To guarantee a
 * message is durable on the broker before the caller continues, we
 * open a confirm channel directly via amqp-connection-manager's
 * ChannelWrapper. `channelWrapper.publish(...)` returns a Promise that
 * resolves after the broker's `basic.ack` lands.
 *
 * Behaviour:
 *   - Every publish is `persistent: true` (deliveryMode 2). Combined
 *     with durable exchanges + quorum queues (set via consumer-side
 *     queueOptions) this gives the no-loss guarantee.
 *   - The publisher waits for broker confirm. If the broker does not
 *     ack within the timeout, the Promise rejects and the relay treats
 *     the message as unpublished (no `published_at` stamp), so the
 *     next relay tick retries.
 *   - On reconnect, amqp-connection-manager re-establishes the channel
 *     transparently. Pending publishes queue until the channel is back.
 */
@Injectable()
export class RmqPublisher
  implements MessageQueuePublisher, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RmqPublisher.name);
  private channel: ChannelWrapper | null = null;
  private readonly defaultTimeoutMs: number;

  constructor(
    @Inject(RMQ_CONNECTION_MANAGER)
    private readonly connection: AmqpConnectionManager | null,
    private readonly configService: ConfigService,
  ) {
    this.defaultTimeoutMs =
      this.configService.get<number>("RMQ_PUBLISHER_CONFIRM_TIMEOUT_MS") ?? 5000;
  }

  onModuleInit(): void {
    if (this.configService.get<string>("OPENKT_QUEUE_BACKEND") === "sqs") {
      return;
    }
    if (!this.connection) {
      throw new Error("[mq.publisher] RabbitMQ connection is not configured");
    }
    this.channel = this.connection.createChannel({
      name: "rmq-publisher",
      // confirm: true is the implicit default in amqp-connection-manager —
      // ChannelWrapper.publish always awaits a broker confirm regardless.
      // Setting it explicitly so a future driver change cannot silently
      // strip confirms.
      confirm: true,
      json: true,
    });

    this.channel.on("error", (err: Error) => {
      this.logger.error(`[mq.publisher] channel error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => {});
  }

  /**
   * Publish a message and wait for broker confirm. Throws if the broker
   * does not ack inside the timeout, or if the channel rejects the
   * publish (e.g. broker mandatory-flag bounce).
   *
   * @param exchange   AMQP exchange name (typically a constant from mq.constants).
   * @param routingKey Routing key. For `x-modulus-hash` exchanges this is what gets hashed —
   *                   use the aggregate id (`memory_id`) for memory pipeline messages and
   *                   `project_id` for briefing messages so per-aggregate ordering holds.
   * @param payload    JSON-serializable body. The wrapper sets `json: true`, so we hand
   *                   the raw object — no manual `Buffer.from(JSON.stringify(...))`.
   * @param options    Optional per-call overrides (headers, messageId, timeout).
   */
  async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options: PublishOptions = {},
  ): Promise<void> {
    if (!this.channel) {
      throw new Error(
        "[mq.publisher] channel not initialised — was onModuleInit called?",
      );
    }

    const publishOptions: Options.Publish = {
      persistent: true,
      contentType: "application/json",
      headers: options.headers,
      messageId: options.messageId,
      timeout: options.timeoutMs ?? this.defaultTimeoutMs,
    };
    await this.channel.publish(exchange, routingKey, payload, publishOptions);
  }
}
