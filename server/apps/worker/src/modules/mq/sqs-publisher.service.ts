import crypto from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SendMessageCommand,
  type SendMessageCommandInput,
  type SQSClient,
} from "@aws-sdk/client-sqs";

import {
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_EVENTS_EXCHANGE,
  SQS_CLIENT,
} from "./mq.constants";
import type { MessageQueuePublisher } from "./message-queue-publisher";
import type { PublishOptions } from "./rmq-publisher.service";

@Injectable()
export class SqsPublisher implements MessageQueuePublisher {
  private readonly logger = new Logger(SqsPublisher.name);

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient | null,
    private readonly config: ConfigService,
  ) {}

  async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options: PublishOptions = {},
  ): Promise<void> {
    if (!this.client) {
      throw new Error("[sqs.publisher] client is not configured");
    }

    const queueUrl = this.queueUrlFor(exchange);
    if (!queueUrl) {
      if (exchange === MEMORY_EVENTS_EXCHANGE) {
        this.logger.debug(
          `[sqs.publisher] stage event skipped routing_key=${routingKey}; OPENKT_SQS_EVENTS_QUEUE_URL is unset`,
        );
        return;
      }
      throw new Error(`[sqs.publisher] no queue is configured for exchange ${exchange}`);
    }

    const input: SendMessageCommandInput = {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageAttributes: {
        routing_key: { DataType: "String", StringValue: routingKey },
        ...(options.messageId
          ? { message_id: { DataType: "String", StringValue: options.messageId } }
          : {}),
        ...toSqsAttributes(options.headers),
      },
      ...(queueUrl.endsWith(".fifo")
        ? fifoParameters(payload, routingKey, options.messageId)
        : {}),
    };

    await this.client.send(new SendMessageCommand(input));
  }

  private queueUrlFor(exchange: string): string | undefined {
    if (exchange === MEMORY_COMMANDS_EXCHANGE) {
      return this.config.get<string>("OPENKT_SQS_COMMAND_QUEUE_URL");
    }
    if (exchange === MEMORY_EVENTS_EXCHANGE) {
      return this.config.get<string>("OPENKT_SQS_EVENTS_QUEUE_URL");
    }
    return undefined;
  }
}

function fifoParameters(
  payload: unknown,
  routingKey: string,
  optionMessageId: string | undefined,
): Pick<
  SendMessageCommandInput,
  "MessageGroupId" | "MessageDeduplicationId"
> {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const aggregateIdentity =
    stringValue(record.aggregate_id) ??
    stringValue(record.project_id) ??
    routingKey;
  const messageId =
    optionMessageId ??
    stringValue(record.message_id) ??
    crypto
      .createHash("sha256")
      .update(`${routingKey}:${JSON.stringify(payload)}`)
      .digest("hex");

  return {
    MessageGroupId: crypto
      .createHash("sha256")
      .update(aggregateIdentity)
      .digest("hex"),
    MessageDeduplicationId: messageId.slice(0, 128),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toSqsAttributes(
  headers: PublishOptions["headers"],
): NonNullable<SendMessageCommandInput["MessageAttributes"]> {
  if (!headers) return {};

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      {
        DataType: typeof value === "number" ? "Number" : "String",
        StringValue: String(value),
      },
    ]),
  );
}
