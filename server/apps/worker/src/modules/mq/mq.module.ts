import { Global, Module, type OnModuleDestroy } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SQSClient } from "@aws-sdk/client-sqs";
import * as amqp from "amqp-connection-manager";

import {
  MESSAGE_QUEUE_PUBLISHER,
  RMQ_CONNECTION_MANAGER,
  SQS_CLIENT,
} from "./mq.constants";
import type { MessageQueuePublisher } from "./message-queue-publisher";
import { RmqInfraService } from "./rmq-infra.service";
import { RmqPublisher } from "./rmq-publisher.service";
import { SqsPublisher } from "./sqs-publisher.service";

/**
 * MqModule — Track C primitives.
 *
 * Wires:
 *   - a single AmqpConnectionManager (the resilience wrapper named in
 *     the official NestJS RMQ doc),
 *   - RmqInfraService (asserts the durable exchanges on every
 *     reconnect),
 *   - RmqPublisher (confirm-channel publisher used by the outbox
 *     relay).
 *
 * Marked `@Global` because every domain module that publishes (or
 * subscribes via @nestjs/microservices) needs the same connection.
 *
 * Boot is non-blocking: amqp-connection-manager retries the connection
 * in the background. The worker can start, accept the outbox-relay
 * tick, and queue up sends — they will land once the broker is
 * reachable, or fail with a confirm timeout if it never comes back.
 *
 * Required env: `RABBITMQ_URL` (validated by
 * `validateWorkerEnvironment` in libs/platform/config). Optional env:
 * `RMQ_PUBLISHER_CONFIRM_TIMEOUT_MS` (default 5000).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: RMQ_CONNECTION_MANAGER,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService,
      ): amqp.AmqpConnectionManager | null => {
        if (config.get<string>("OPENKT_QUEUE_BACKEND") === "sqs") {
          return null;
        }
        return amqp.connect([config.getOrThrow<string>("RABBITMQ_URL")], {
          // amqp-connection-manager defaults: heartbeat 5s, reconnect
          // every 1s up to forever. Both reasonable for a worker that
          // should never give up on a transient broker outage.
        });
      },
    },
    {
      provide: SQS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SQSClient | null =>
        config.get<string>("OPENKT_QUEUE_BACKEND") === "sqs"
          ? new SQSClient({ region: config.getOrThrow<string>("AWS_REGION") })
          : null,
    },
    RmqInfraService,
    RmqPublisher,
    SqsPublisher,
    {
      provide: MESSAGE_QUEUE_PUBLISHER,
      inject: [ConfigService, RmqPublisher, SqsPublisher],
      useFactory: (
        config: ConfigService,
        rabbitmq: RmqPublisher,
        sqs: SqsPublisher,
      ): MessageQueuePublisher =>
        config.get<string>("OPENKT_QUEUE_BACKEND") === "sqs" ? sqs : rabbitmq,
    },
  ],
  exports: [
    MESSAGE_QUEUE_PUBLISHER,
    RMQ_CONNECTION_MANAGER,
    SQS_CLIENT,
    RmqInfraService,
    RmqPublisher,
    SqsPublisher,
  ],
})
export class MqModule implements OnModuleDestroy {
  // OnModuleDestroy on the providers handles cleanup; the module itself
  // does not need extra teardown. Declaring the hook here is purely a
  // marker that the module is destruction-aware (Nest will call into
  // the providers in the right order).
  async onModuleDestroy(): Promise<void> {
    // intentional no-op
  }
}
