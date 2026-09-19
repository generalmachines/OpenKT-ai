import type { PublishOptions } from "./rmq-publisher.service";

/**
 * Broker-neutral publish surface used by the durable outbox and pipeline
 * stages. RabbitMQ remains the default implementation; SQS is selected with
 * OPENKT_QUEUE_BACKEND=sqs.
 */
export interface MessageQueuePublisher {
  publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options?: PublishOptions,
  ): Promise<void>;
}
