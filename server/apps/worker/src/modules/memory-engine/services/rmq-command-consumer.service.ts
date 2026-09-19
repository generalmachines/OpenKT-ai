import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";

import {
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_COMMANDS_QUEUE,
  RMQ_CONNECTION_MANAGER,
} from "../../mq/mq.constants";
import type { PipelineCommandMessage } from "../pipeline-message";
import { MemoryPipelineOrchestratorService } from "./memory-pipeline.orchestrator.service";

@Injectable()
export class RmqCommandConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RmqCommandConsumerService.name);
  private channel: ChannelWrapper | null = null;

  constructor(
    @Inject(RMQ_CONNECTION_MANAGER)
    private readonly connection: AmqpConnectionManager | null,
    private readonly configService: ConfigService,
    private readonly orchestrator: MemoryPipelineOrchestratorService,
  ) {}

  onModuleInit(): void {
    if (this.configService.get<string>("NODE_ENV") === "test") {
      return;
    }
    if (this.configService.get<string>("OPENKT_QUEUE_BACKEND") === "sqs") {
      return;
    }
    if (this.channel) {
      return;
    }
    if (!this.connection) {
      throw new Error("[memory.pipeline] RabbitMQ connection is not configured");
    }

    const prefetch = this.configService.get<number>("RMQ_COMMAND_CONSUMER_PREFETCH") ?? 8;
    this.channel = this.connection.createChannel({
      name: "rmq-command-consumer",
      setup: async (channel: ConfirmChannel) => {
        await channel.assertExchange(MEMORY_COMMANDS_EXCHANGE, "topic", {
          durable: true,
        });
        await channel.assertQueue(MEMORY_COMMANDS_QUEUE, { durable: true });
        await channel.bindQueue(MEMORY_COMMANDS_QUEUE, MEMORY_COMMANDS_EXCHANGE, "#");
        await channel.prefetch(prefetch);
        await channel.consume(
          MEMORY_COMMANDS_QUEUE,
          async (delivery) => {
            if (!delivery) {
              return;
            }
            await this.consume(channel, delivery);
          },
          { noAck: false },
        );
      },
    });

    this.channel.on("error", (error: Error) => {
      this.logger.error(`[memory.pipeline] consumer channel error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => {});
  }

  private async consume(channel: ConfirmChannel, delivery: ConsumeMessage): Promise<void> {
    try {
      const raw = delivery.content.toString("utf8");
      const message = JSON.parse(raw) as PipelineCommandMessage;
      await this.orchestrator.handle(message);
      channel.ack(delivery);
    } catch (error) {
      this.logger.error(
        `[memory.pipeline] consume failed err=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      channel.ack(delivery);
    }
  }
}
