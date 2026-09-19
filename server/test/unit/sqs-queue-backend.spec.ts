import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { ConfigService } from "@nestjs/config";
import { MODULE_METADATA } from "@nestjs/common/constants";

import { HealthMonitorModule } from "../../apps/worker/src/modules/health-monitor/health-monitor.module";
import { SqsCommandConsumerService } from "../../apps/worker/src/modules/memory-engine/services/sqs-command-consumer.service";
import { RmqCommandConsumerService } from "../../apps/worker/src/modules/memory-engine/services/rmq-command-consumer.service";
import {
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_EVENTS_EXCHANGE,
} from "../../apps/worker/src/modules/mq/mq.constants";
import { SqsPublisher } from "../../apps/worker/src/modules/mq/sqs-publisher.service";
import { WorkerModule } from "../../apps/worker/src/worker.module";
import { workerEnvironmentSchema } from "../../libs/platform/config/src/env.schemas";

const QUEUE_URL = "https://sqs.ap-south-1.amazonaws.com/123456789012/openkt-commands";

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
}

describe("SQS queue backend", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("wires the health monitor into the worker application", () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, WorkerModule);
    expect(imports).toContain(HealthMonitorModule);
  });

  it("keeps RabbitMQ as the default and validates backend-specific settings", () => {
    const rabbitmq = workerEnvironmentSchema.safeParse({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost/openkt",
      RABBITMQ_URL: "amqp://localhost",
    });
    expect(rabbitmq.success).toBe(true);
    if (rabbitmq.success) {
      expect(rabbitmq.data.OPENKT_QUEUE_BACKEND).toBe("rabbitmq");
    }

    const sqs = workerEnvironmentSchema.safeParse({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost/openkt",
      OPENKT_QUEUE_BACKEND: "sqs",
      AWS_REGION: "ap-south-1",
      OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL,
    });
    expect(sqs.success).toBe(true);

    const invalidSqs = workerEnvironmentSchema.safeParse({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost/openkt",
      OPENKT_QUEUE_BACKEND: "sqs",
    });
    expect(invalidSqs.success).toBe(false);
    if (!invalidSqs.success) {
      expect(invalidSqs.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(["AWS_REGION", "OPENKT_SQS_COMMAND_QUEUE_URL"]),
      );
    }

    const unsafeHeartbeat = workerEnvironmentSchema.safeParse({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost/openkt",
      OPENKT_QUEUE_BACKEND: "sqs",
      AWS_REGION: "ap-south-1",
      OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL,
      OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS: 100,
      OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS: 60,
    });
    expect(unsafeHeartbeat.success).toBe(false);
  });

  it("publishes command messages with SQS message attributes", async () => {
    const client = { send: jest.fn().mockResolvedValue({ MessageId: "sqs-id" }) };
    const publisher = new SqsPublisher(
      client as never,
      config({ OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL }),
    );

    await publisher.publish(
      MEMORY_COMMANDS_EXCHANGE,
      "memory.preprocess.request",
      { message_id: "message-1", job_type: "memory.preprocess" },
      {
        messageId: "message-1",
        headers: { correlation_id: "correlation-1", attempt: 2 },
      },
    );

    const command = client.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input).toEqual(
      expect.objectContaining({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          message_id: "message-1",
          job_type: "memory.preprocess",
        }),
        MessageAttributes: expect.objectContaining({
          routing_key: {
            DataType: "String",
            StringValue: "memory.preprocess.request",
          },
          message_id: { DataType: "String", StringValue: "message-1" },
          correlation_id: {
            DataType: "String",
            StringValue: "correlation-1",
          },
          attempt: { DataType: "Number", StringValue: "2" },
        }),
      }),
    );
  });

  it("adds deterministic FIFO group and deduplication identifiers", async () => {
    const fifoUrl = `${QUEUE_URL}.fifo`;
    const client = { send: jest.fn().mockResolvedValue({ MessageId: "sqs-id" }) };
    const publisher = new SqsPublisher(
      client as never,
      config({ OPENKT_SQS_COMMAND_QUEUE_URL: fifoUrl }),
    );
    const payload = {
      message_id: "message-1",
      aggregate_id: "memory-123",
      project_id: "project-456",
      job_type: "memory.preprocess",
    };

    await publisher.publish(
      MEMORY_COMMANDS_EXCHANGE,
      "memory.preprocess.request",
      payload,
      { messageId: "message-1" },
    );
    await publisher.publish(
      MEMORY_COMMANDS_EXCHANGE,
      "memory.embed.request",
      { ...payload, message_id: "message-2" },
      { messageId: "message-2" },
    );

    const first = client.send.mock.calls[0]?.[0].input;
    const second = client.send.mock.calls[1]?.[0].input;
    expect(first.MessageGroupId).toMatch(/^[a-f0-9]{64}$/);
    expect(second.MessageGroupId).toBe(first.MessageGroupId);
    expect(first.MessageDeduplicationId).toBe("message-1");
    expect(second.MessageDeduplicationId).toBe("message-2");
  });

  it("skips optional events when no SQS event queue is configured", async () => {
    const client = { send: jest.fn() };
    const publisher = new SqsPublisher(client as never, config({}));

    await publisher.publish(MEMORY_EVENTS_EXCHANGE, "memory.embed.done", {});

    expect(client.send).not.toHaveBeenCalled();
  });

  it("long-polls and deletes a message only after successful handling", async () => {
    const body = JSON.stringify({
      message_id: "message-1",
      job_type: "memory.preprocess",
    });
    const client = {
      send: jest
        .fn()
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: "sqs-id",
              ReceiptHandle: "receipt-1",
              Body: body,
              Attributes: { ApproximateReceiveCount: "1" },
            },
          ],
        })
        .mockResolvedValueOnce({}),
    };
    const orchestrator = { handle: jest.fn().mockResolvedValue(undefined) };
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({
        OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL,
        OPENKT_SQS_MAX_MESSAGES: 8,
        OPENKT_SQS_WAIT_TIME_SECONDS: 20,
        OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS: 300,
      }),
      orchestrator as never,
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);

    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(ReceiveMessageCommand);
    expect(client.send.mock.calls[0]?.[0].input).toEqual(
      expect.objectContaining({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 8,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 300,
      }),
    );
    expect(orchestrator.handle).toHaveBeenCalledWith(JSON.parse(body));
    expect(client.send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteMessageCommand);
    expect(client.send.mock.calls[1]?.[0].input).toEqual({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "receipt-1",
    });
  });

  it("retains failed messages for visibility-timeout retry", async () => {
    const client = {
      send: jest.fn().mockResolvedValue({
        Messages: [
          {
            MessageId: "sqs-id",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              message_id: "message-1",
              job_type: "memory.preprocess",
            }),
            Attributes: { ApproximateReceiveCount: "2" },
          },
        ],
      }),
    };
    const orchestrator = {
      handle: jest.fn().mockRejectedValue(new Error("temporary database failure")),
    };
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({ OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL }),
      orchestrator as never,
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(orchestrator.handle).toHaveBeenCalledTimes(1);
  });

  it("retains a duplicate delivery while the ledger job is still running", async () => {
    const client = {
      send: jest.fn().mockResolvedValue({
        Messages: [
          {
            MessageId: "sqs-id",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              message_id: "message-1",
              job_type: "memory.preprocess",
            }),
          },
        ],
      }),
    };
    const orchestrator = {
      handle: jest.fn().mockResolvedValue("in_progress"),
    };
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({ OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL }),
      orchestrator as never,
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(orchestrator.handle).toHaveBeenCalledTimes(1);
  });

  it("deletes a duplicate delivery whose ledger job is already done", async () => {
    const client = {
      send: jest
        .fn()
        .mockResolvedValueOnce({
          Messages: [
            {
              MessageId: "sqs-id",
              ReceiptHandle: "receipt-1",
              Body: JSON.stringify({
                message_id: "message-1",
                job_type: "memory.preprocess",
              }),
            },
          ],
        })
        .mockResolvedValueOnce({}),
    };
    const orchestrator = {
      handle: jest.fn().mockResolvedValue("already_done"),
    };
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({ OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL }),
      orchestrator as never,
    );

    await consumer.pollOnce();

    expect(client.send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteMessageCommand);
  });

  it("renews visibility for a long-running message before deleting it", async () => {
    jest.useFakeTimers();
    let finish!: (value: "processed") => void;
    const handlePromise = new Promise<"processed">((resolve) => {
      finish = resolve;
    });
    const client = {
      send: jest.fn((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                MessageId: "sqs-id",
                ReceiptHandle: "receipt-1",
                Body: JSON.stringify({
                  message_id: "message-1",
                  job_type: "memory.preprocess",
                }),
              },
            ],
          });
        }
        return Promise.resolve({});
      }),
      destroy: jest.fn(),
    };
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({
        OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL,
        OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS: 30,
        OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS: 10,
      }),
      { handle: jest.fn().mockReturnValue(handlePromise) } as never,
    );

    const poll = consumer.pollOnce();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10_000);

    const heartbeat = client.send.mock.calls
      .map((call) => call[0])
      .find((command) => command instanceof ChangeMessageVisibilityCommand);
    expect(heartbeat).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect(heartbeat!.input).toEqual({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "receipt-1",
      VisibilityTimeout: 30,
    });

    finish("processed");
    await poll;
    expect(
      client.send.mock.calls.some(
        (call) => call[0] instanceof DeleteMessageCommand,
      ),
    ).toBe(true);
    await consumer.onModuleDestroy();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps renewing active leases while graceful shutdown drains handlers", async () => {
    jest.useFakeTimers();
    let finish!: (value: "processed") => void;
    const handlePromise = new Promise<"processed">((resolve) => {
      finish = resolve;
    });
    const client = {
      send: jest.fn((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                MessageId: "shutdown-message",
                ReceiptHandle: "shutdown-receipt",
                Body: JSON.stringify({
                  message_id: "shutdown-message",
                  job_type: "memory.preprocess",
                }),
              },
            ],
          });
        }
        return Promise.resolve({});
      }),
      destroy: jest.fn(),
    };
    const handle = jest.fn().mockReturnValue(handlePromise);
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({
        NODE_ENV: "development",
        OPENKT_QUEUE_BACKEND: "sqs",
        OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL,
        OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS: 30,
        OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS: 5,
        OPENKT_SQS_SHUTDOWN_GRACE_SECONDS: 20,
      }),
      { handle } as never,
    );

    consumer.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(handle).toHaveBeenCalledTimes(1);

    const shutdown = consumer.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(
      client.send.mock.calls.some(
        (call) => call[0] instanceof ChangeMessageVisibilityCommand,
      ),
    ).toBe(true);
    expect(client.destroy).not.toHaveBeenCalled();

    finish("processed");
    await shutdown;

    expect(
      client.send.mock.calls.some(
        (call) => call[0] instanceof DeleteMessageCommand,
      ),
    ).toBe(true);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not delete when a visibility heartbeat fails", async () => {
    jest.useFakeTimers();
    let finish!: (value: "processed") => void;
    const handlePromise = new Promise<"processed">((resolve) => {
      finish = resolve;
    });
    const client = {
      send: jest.fn((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                MessageId: "sqs-id",
                ReceiptHandle: "receipt-1",
                Body: JSON.stringify({
                  message_id: "message-1",
                  job_type: "memory.preprocess",
                }),
              },
            ],
          });
        }
        if (command instanceof ChangeMessageVisibilityCommand) {
          return Promise.reject(new Error("visibility API unavailable"));
        }
        return Promise.resolve({});
      }),
    };
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({
        OPENKT_SQS_COMMAND_QUEUE_URL: QUEUE_URL,
        OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS: 30,
        OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS: 10,
      }),
      { handle: jest.fn().mockReturnValue(handlePromise) } as never,
    );

    const poll = consumer.pollOnce();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10_000);
    finish("processed");
    await poll;

    expect(
      client.send.mock.calls.some(
        (call) => call[0] instanceof ChangeMessageVisibilityCommand,
      ),
    ).toBe(true);
    expect(
      client.send.mock.calls.some(
        (call) => call[0] instanceof DeleteMessageCommand,
      ),
    ).toBe(false);
  });

  it("processes FIFO messages sequentially within a group and groups concurrently", async () => {
    let finishFirst!: (value: "processed") => void;
    const first = new Promise<"processed">((resolve) => {
      finishFirst = resolve;
    });
    const bodies = {
      first: JSON.stringify({ message_id: "g1-1", job_type: "memory.preprocess" }),
      second: JSON.stringify({ message_id: "g1-2", job_type: "memory.embed" }),
      other: JSON.stringify({ message_id: "g2-1", job_type: "memory.triage" }),
    };
    const client = {
      send: jest.fn((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                MessageId: "g1-1",
                ReceiptHandle: "r1",
                Body: bodies.first,
                Attributes: { MessageGroupId: "group-1" },
              },
              {
                MessageId: "g1-2",
                ReceiptHandle: "r2",
                Body: bodies.second,
                Attributes: { MessageGroupId: "group-1" },
              },
              {
                MessageId: "g2-1",
                ReceiptHandle: "r3",
                Body: bodies.other,
                Attributes: { MessageGroupId: "group-2" },
              },
            ],
          });
        }
        return Promise.resolve({});
      }),
    };
    const handle = jest.fn((message: { message_id: string }) =>
      message.message_id === "g1-1" ? first : Promise.resolve("processed"),
    );
    const consumer = new SqsCommandConsumerService(
      client as never,
      config({ OPENKT_SQS_COMMAND_QUEUE_URL: `${QUEUE_URL}.fifo` }),
      { handle } as never,
    );

    const poll = consumer.pollOnce();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ message_id: "g1-1" }));
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ message_id: "g2-1" }));
    expect(handle).not.toHaveBeenCalledWith(
      expect.objectContaining({ message_id: "g1-2" }),
    );

    finishFirst("processed");
    await poll;
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ message_id: "g1-2" }));
  });

  it("keeps RabbitMQ's historical ack-on-handler-rejection behavior", async () => {
    const orchestrator = {
      handle: jest.fn().mockRejectedValue(new Error("stage failed")),
    };
    const consumer = new RmqCommandConsumerService(
      null,
      config({ OPENKT_QUEUE_BACKEND: "rabbitmq" }),
      orchestrator as never,
    );
    const channel = { ack: jest.fn() };
    const delivery = {
      content: Buffer.from(
        JSON.stringify({
          message_id: "message-1",
          job_type: "memory.preprocess",
        }),
      ),
    };

    await (consumer as unknown as {
      consume(channel: unknown, delivery: unknown): Promise<void>;
    }).consume(channel, delivery);

    expect(orchestrator.handle).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(delivery);
  });
});
