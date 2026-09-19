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
} from "amqp-connection-manager";
import type { Channel } from "amqplib";

import {
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_COMMANDS_QUEUE,
  MEMORY_DLX_EXCHANGE,
  MEMORY_EVENTS_EXCHANGE,
  RMQ_CONNECTION_MANAGER,
} from "./mq.constants";

/**
 * RmqInfraService — owns the broker connection lifecycle and asserts
 * the topology declared in mq.constants.ts.
 *
 * Driver: amqp-connection-manager (the resilience wrapper the official
 * NestJS RabbitMQ doc tells you to install:
 * `npm i --save amqplib amqp-connection-manager`). The wrapper handles
 * reconnect transparently — `connectionInitOptions` is not needed at
 * this layer because amqp-connection-manager retries on its own.
 *
 * Topology (durable, asserted on every successful (re)connect via the
 * `setup` hook on the channel wrapper):
 *
 *   - `memory.engine.commands` — type `x-modulus-hash` (durable).
 *     Requires the `rabbitmq_sharding` plugin to be enabled on the
 *     broker. See `docs/runbooks/rabbitmq-broker-policies.md` for the
 *     operator-side `rabbitmq-plugins enable rabbitmq_sharding` step
 *     and the policy that fans the exchange across shard queues.
 *
 *   - `memory.engine.events` — type `topic` (durable). Stage-completion
 *     fan-out / observability.
 *
 *   - `memory.engine.dlx` — type `topic` (durable). Dead-letter
 *     destination; per-stage DLQs subscribe with stage routing keys.
 *
 * The setup channel is held only long enough to assert the topology;
 * the publisher (RmqPublisher) opens its own confirm channel for sends.
 *
 * Failure semantics:
 *   - If the broker has not enabled rabbitmq_sharding, asserting an
 *     `x-modulus-hash` exchange will fail with a 540 PRECONDITION_FAILED.
 *     We log loud and rethrow so the worker fails fast — better to
 *     refuse to boot than silently downgrade.
 *   - On normal disconnects, amqp-connection-manager re-runs the setup
 *     hook automatically when the connection comes back.
 */
@Injectable()
export class RmqInfraService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RmqInfraService.name);
  private setupChannel: ChannelWrapper | null = null;

  constructor(
    @Inject(RMQ_CONNECTION_MANAGER)
    private readonly connection: AmqpConnectionManager | null,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>("OPENKT_QUEUE_BACKEND") === "sqs") {
      return;
    }
    if (!this.connection) {
      throw new Error("[mq.infra] RabbitMQ connection is not configured");
    }
    if (this.setupChannel) {
      return;
    }

    // amqp-connection-manager.createChannel runs the `setup` callback on
    // every successful (re)connect, so the topology gets re-asserted
    // automatically after a broker bounce. The wrapper buffers any work
    // until a real channel is available — there is no need to await a
    // connection here.
    this.setupChannel = this.connection.createChannel({
      name: "rmq-infra-topology",
      json: false,
      setup: (channel: Channel) => this.assertTopology(channel),
    });

    this.setupChannel.on("error", (err: Error) => {
      this.logger.error(
        `[mq.infra] setup channel error: ${err.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.setupChannel?.close();
      await this.connection?.close();
    } catch (err) {
      this.logger.warn(
        `[mq.infra] shutdown warning: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Idempotent topology assertion. Called by amqp-connection-manager on
   * every successful reconnect so a broker that just came back up gets
   * the same shape as a fresh broker.
   */
  private async assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(MEMORY_COMMANDS_EXCHANGE, "topic", {
      durable: true,
    });
    await channel.assertExchange(MEMORY_EVENTS_EXCHANGE, "topic", {
      durable: true,
    });
    await channel.assertExchange(MEMORY_DLX_EXCHANGE, "topic", {
      durable: true,
    });
    // Bind a single durable command queue to the commands exchange with
    // the `#` wildcard so every routing key lands here. Sharding could
    // re-enter behind a feature flag if we run multiple workers; for now
    // one queue + one consumer is simpler and works on every broker.
    await channel.assertQueue(MEMORY_COMMANDS_QUEUE, { durable: true });
    await channel.bindQueue(MEMORY_COMMANDS_QUEUE, MEMORY_COMMANDS_EXCHANGE, "#");
    this.logger.log(
      `[mq.infra] topology asserted (${MEMORY_COMMANDS_EXCHANGE} topic → ${MEMORY_COMMANDS_QUEUE}, ` +
        `${MEMORY_EVENTS_EXCHANGE} topic, ${MEMORY_DLX_EXCHANGE} topic)`,
    );
  }
}
