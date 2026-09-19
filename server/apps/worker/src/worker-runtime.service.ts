import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";

import { RmqCommandConsumerService } from "./modules/memory-engine/services/rmq-command-consumer.service";
import { SqsCommandConsumerService } from "./modules/memory-engine/services/sqs-command-consumer.service";
import { RmqInfraService } from "./modules/mq/rmq-infra.service";
import { OutboxRelayService } from "./modules/outbox/outbox-relay.service";

@Injectable()
export class WorkerRuntimeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerRuntimeService.name);

  constructor(
    private readonly rmqInfra: RmqInfraService,
    private readonly commandConsumer: RmqCommandConsumerService,
    private readonly sqsCommandConsumer: SqsCommandConsumerService,
    private readonly outboxRelay: OutboxRelayService,
  ) {}

  onApplicationBootstrap(): void {
    this.rmqInfra.onModuleInit();
    this.commandConsumer.onModuleInit();
    this.sqsCommandConsumer.onModuleInit();
    this.outboxRelay.onModuleInit();
    this.logger.log("worker runtime providers anchored");
  }
}
