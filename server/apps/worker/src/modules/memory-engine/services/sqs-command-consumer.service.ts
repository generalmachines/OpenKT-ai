import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { SQS_CLIENT } from "../../mq/mq.constants";
import type { PipelineCommandMessage } from "../pipeline-message";
import { MemoryPipelineOrchestratorService } from "./memory-pipeline.orchestrator.service";

interface VisibilityLease {
  stop(): Promise<Error | null>;
}

@Injectable()
export class SqsCommandConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsCommandConsumerService.name);
  private stopped = false;
  private pollPromise: Promise<void> | null = null;
  private pollAbortController: AbortController | null = null;
  private readonly heartbeatTimers = new Set<NodeJS.Timeout>();
  private readonly heartbeatAbortControllers = new Set<AbortController>();

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient | null,
    private readonly config: ConfigService,
    private readonly orchestrator: MemoryPipelineOrchestratorService,
  ) {}

  onModuleInit(): void {
    if (
      this.config.get<string>("NODE_ENV") === "test" ||
      this.config.get<string>("OPENKT_QUEUE_BACKEND") !== "sqs" ||
      this.pollPromise
    ) {
      return;
    }

    this.stopped = false;
    this.pollPromise = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.pollAbortController?.abort();
    const drained = await this.waitForPollDrain();
    if (!drained) {
      this.logger.warn(
        `[sqs.consumer] shutdown grace expired after ${
          this.config.get<number>("OPENKT_SQS_SHUTDOWN_GRACE_SECONDS") ?? 30
        }s; releasing visibility leases for retry`,
      );
    }
    this.stopAllHeartbeats();
    (
      this.client as unknown as { destroy?: () => void } | null
    )?.destroy?.();
  }

  private stopAllHeartbeats(): void {
    for (const timer of this.heartbeatTimers) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();
    for (const controller of this.heartbeatAbortControllers) {
      controller.abort();
    }
    this.heartbeatAbortControllers.clear();
  }

  private async waitForPollDrain(): Promise<boolean> {
    if (!this.pollPromise) return true;

    const graceMs =
      (this.config.get<number>("OPENKT_SQS_SHUTDOWN_GRACE_SECONDS") ?? 30) *
      1000;
    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    });
    const drained = this.pollPromise
      .then(() => true as const)
      .catch(() => true as const);
    const result = await Promise.race([drained, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /** Public for focused tests and one-shot operational probes. */
  async pollOnce(): Promise<number> {
    if (!this.client) {
      throw new Error("[sqs.consumer] client is not configured");
    }

    const queueUrl = this.config.getOrThrow<string>("OPENKT_SQS_COMMAND_QUEUE_URL");
    this.pollAbortController = new AbortController();
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages:
          this.config.get<number>("OPENKT_SQS_MAX_MESSAGES") ?? 8,
        WaitTimeSeconds:
          this.config.get<number>("OPENKT_SQS_WAIT_TIME_SECONDS") ?? 20,
        VisibilityTimeout:
          this.config.get<number>("OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS") ?? 300,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
          "MessageGroupId",
        ],
      }),
      { abortSignal: this.pollAbortController.signal },
    );

    const messages = response.Messages ?? [];
    const leases = new Map(
      messages.map((message) => [
        message,
        this.startVisibilityHeartbeat(queueUrl, message),
      ]),
    );
    const groups = groupDeliveries(messages);
    await Promise.all(
      groups.map(async (group) => {
        for (const message of group) {
          const processed = await this.processMessage(
            queueUrl,
            message,
            leases.get(message)!,
          );
          if (!processed) {
            break;
          }
        }
      }),
    );
    await Promise.all(
      [...leases.values()].map((lease) => lease.stop().catch(() => null)),
    );
    return messages.length;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopped && isAbortError(error)) {
          return;
        }
        this.logger.error(
          `[sqs.consumer] poll failed err=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.waitAfterPollError();
      }
    }
  }

  private async processMessage(
    queueUrl: string,
    delivery: Message,
    lease: VisibilityLease,
  ): Promise<boolean> {
    try {
      if (!delivery.Body) {
        throw new Error("message body is empty");
      }
      if (!delivery.ReceiptHandle) {
        throw new Error("message receipt handle is missing");
      }

      const message = JSON.parse(delivery.Body) as PipelineCommandMessage;
      const outcome = await this.orchestrator.handle(message);
      if (outcome === "in_progress") {
        throw new Error(
          "matching pipeline job is still running; delivery retained",
        );
      }
      const heartbeatError = await lease.stop();
      if (heartbeatError) {
        throw heartbeatError;
      }
      await this.client!.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: delivery.ReceiptHandle,
        }),
      );
      return true;
    } catch (error) {
      await lease.stop().catch(() => null);
      this.logger.error(
        `[sqs.consumer] processing failed message_id=${delivery.MessageId ?? "unknown"} ` +
          `receive_count=${delivery.Attributes?.ApproximateReceiveCount ?? "unknown"} err=${
            error instanceof Error ? error.message : String(error)
          }; message retained for visibility-timeout retry`,
      );
      return false;
    }
  }

  private startVisibilityHeartbeat(
    queueUrl: string,
    delivery: Message,
  ): VisibilityLease {
    const receiptHandle = delivery.ReceiptHandle;
    if (!this.client || !receiptHandle) {
      return { stop: async () => null };
    }

    const intervalMs =
      (this.config.get<number>(
        "OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS",
      ) ?? 60) * 1000;
    const visibilityTimeout =
      this.config.get<number>("OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS") ?? 300;
    let active = true;
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> | null = null;
    let heartbeatError: Error | null = null;
    let heartbeatController: AbortController | null = null;

    const schedule = () => {
      // `stopped` only prevents another receive. Active handlers keep their
      // visibility leases during graceful shutdown until they finish or the
      // configured shutdown grace expires.
      if (!active || heartbeatError) return;
      timer = setTimeout(() => {
        if (timer) this.heartbeatTimers.delete(timer);
        timer = null;
        heartbeatController = new AbortController();
        this.heartbeatAbortControllers.add(heartbeatController);
        inFlight = this.client!
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: visibilityTimeout,
            }),
            { abortSignal: heartbeatController.signal },
          )
          .then(() => undefined)
          .catch((error: unknown) => {
            heartbeatError =
              error instanceof Error ? error : new Error(String(error));
            this.logger.error(
              `[sqs.consumer] visibility heartbeat failed message_id=${
                delivery.MessageId ?? "unknown"
              } err=${heartbeatError.message}`,
            );
          })
          .finally(() => {
            if (heartbeatController) {
              this.heartbeatAbortControllers.delete(heartbeatController);
            }
            heartbeatController = null;
            inFlight = null;
            schedule();
          });
      }, intervalMs);
      timer.unref?.();
      this.heartbeatTimers.add(timer);
    };

    schedule();

    return {
      stop: async () => {
        if (!active) return heartbeatError;
        active = false;
        if (timer) {
          clearTimeout(timer);
          this.heartbeatTimers.delete(timer);
          timer = null;
        }
        await inFlight?.catch(() => {});
        return heartbeatError;
      },
    };
  }

  private async waitAfterPollError(): Promise<void> {
    const delayMs =
      this.config.get<number>("OPENKT_SQS_POLL_ERROR_DELAY_MS") ?? 1000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    });
  }
}

function groupDeliveries(messages: Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const [index, message] of messages.entries()) {
    // Standard queues do not return MessageGroupId. Give each delivery its
    // own synthetic group so they retain the existing parallel behavior.
    const key =
      message.Attributes?.MessageGroupId ??
      `standard:${message.MessageId ?? index}`;
    const group = groups.get(key);
    if (group) {
      group.push(message);
    } else {
      groups.set(key, [message]);
    }
  }
  return [...groups.values()];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
