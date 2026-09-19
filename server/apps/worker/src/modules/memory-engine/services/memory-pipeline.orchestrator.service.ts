import crypto from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { runWithLlmCallContext } from "@openkt/platform-llm";

import {
  MESSAGE_QUEUE_PUBLISHER,
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_EVENTS_EXCHANGE,
  ROUTING_KEY_STAGE_FAILED,
} from "../../mq/mq.constants";
import type { MessageQueuePublisher } from "../../mq/message-queue-publisher";
import {
  stageFromJobType,
  type StageExecutionResult,
  routingKeyForCommand,
  type PipelineCommandMessage,
} from "../pipeline-message";
import { BriefingStageService } from "./briefing-stage.service";
import { EmbedStageService } from "./embed-stage.service";
import { EpisodeStageService } from "./episode-stage.service";
import { JobLedgerService } from "./job-ledger.service";
import { MemberKnowledgeStageService } from "./member-knowledge-stage.service";
import { PreprocessStageService } from "./preprocess-stage.service";
import { SynthesizeStageService } from "./synthesize-stage.service";
import { TriageStageService } from "./triage-stage.service";

@Injectable()
export class MemoryPipelineOrchestratorService {
  private readonly logger = new Logger(MemoryPipelineOrchestratorService.name);

  constructor(
    private readonly jobLedgerService: JobLedgerService,
    private readonly preprocessStageService: PreprocessStageService,
    private readonly embedStageService: EmbedStageService,
    private readonly triageStageService: TriageStageService,
    private readonly episodeStageService: EpisodeStageService,
    private readonly synthesizeStageService: SynthesizeStageService,
    private readonly memberKnowledgeStageService: MemberKnowledgeStageService,
    private readonly briefingStageService: BriefingStageService,
    @Inject(MESSAGE_QUEUE_PUBLISHER)
    private readonly publisher: MessageQueuePublisher,
  ) {}

  async handle(
    message: PipelineCommandMessage,
  ): Promise<"processed" | "already_done" | "in_progress"> {
    const started = await this.jobLedgerService.begin(message);
    if (!started.shouldRun) {
      return started.skipReason === "in_progress"
        ? "in_progress"
        : "already_done";
    }

    try {
      // Wrap the stage in an LlmCallContext so the worker's LLM
      // recorder can label `llm_calls.stage` / `project_id` /
      // `user_id` / `memory_id` correctly. The lib's
      // AsyncLocalStorage carries it down into every gateway call
      // the stage makes (one or many).
      const result = await runWithLlmCallContext(
        {
          stage: toRecorderStage(message.job_type),
          projectId: message.project_id ?? null,
          userId: message.user_id ?? null,
          memoryId:
            message.aggregate_type === "memory"
              ? message.aggregate_id
              : null,
          requestId: message.correlation_id ?? null,
        },
        () => this.dispatch(message) as Promise<StageExecutionResult>,
      );
      for (const command of result.commands ?? []) {
        await this.publisher.publish(
          MEMORY_COMMANDS_EXCHANGE,
          routingKeyForCommand(command),
          command,
          {
            messageId: command.message_id,
            headers: {
              correlation_id: command.correlation_id,
              job_type: command.job_type,
            },
          },
        );
      }

      await this.jobLedgerService.markDone(started.jobId, result.result, message);
      if (result.eventRoutingKey) {
        await this.publishStageEvent(message, result.eventRoutingKey, result.result).catch(
          (error: unknown) => {
            this.logger.warn(
              `[memory.pipeline] stage event publish failed job_type=${message.job_type} err=${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        );
      }
      return "processed";
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.jobLedgerService.markFailed(started.jobId, messageText, message);
      await this.publishStageEvent(message, ROUTING_KEY_STAGE_FAILED, {
        failed: true,
        error: messageText,
      }).catch(() => {});
      this.logger.error(
        `[memory.pipeline] command failed job_type=${message.job_type} aggregate_id=${message.aggregate_id} err=${messageText}`,
      );
      // RabbitMQ's consumer preserves its historical ack-on-stage-failure
      // behavior. The SQS consumer treats this rejection as a failed
      // delivery and deliberately does not delete the message, allowing the
      // queue visibility timeout (and configured redrive policy) to retry it.
      throw error;
    }
  }

  private dispatch(message: PipelineCommandMessage) {
    switch (message.job_type) {
      case "memory.preprocess":
        return this.preprocessStageService.execute(message);
      case "memory.embed":
        return this.embedStageService.execute(message);
      case "memory.triage":
        return this.triageStageService.execute(message);
      case "memory.episode":
        return this.episodeStageService.execute(message);
      case "memory.synthesize":
        return this.synthesizeStageService.execute(message);
      case "memory.member_knowledge":
        return this.memberKnowledgeStageService.execute(message);
      case "project.briefing":
        return this.briefingStageService.execute(message);
    }
  }

  private async publishStageEvent(
    source: PipelineCommandMessage,
    routingKey: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    const event = {
      message_id: crypto.randomUUID(),
      correlation_id: source.correlation_id,
      causation_id: source.message_id,
      job_type: routingKey,
      aggregate_type: source.aggregate_type,
      aggregate_id: source.aggregate_id,
      project_id: source.project_id,
      org_id: source.org_id,
      user_id: source.user_id,
      version_token: source.version_token,
      payload: {
        ...source.payload,
        stage_result: result,
      },
      published_at: new Date().toISOString(),
    };

    await this.publisher.publish(MEMORY_EVENTS_EXCHANGE, routingKey, event, {
      messageId: event.message_id,
      headers: {
        correlation_id: event.correlation_id,
        job_type: routingKey,
      },
    });
  }
}

// The pipeline's internal `PipelineStage` (`member_knowledge_synthesis`)
// is richer than the LlmCallStage union from @openkt/platform-llm. Map
// the pipeline stage onto the closest recorder-supported label so
// `llm_calls.stage` stays a useful filter.
function toRecorderStage(
  jobType: PipelineCommandMessage["job_type"],
):
  | "preprocess"
  | "embed"
  | "triage"
  | "episode"
  | "synthesize"
  | "briefing"
  | "manual" {
  const pipelineStage = stageFromJobType(jobType);
  switch (pipelineStage) {
    case "preprocess":
      return "preprocess";
    case "embed":
      return "embed";
    case "triage":
      return "triage";
    case "episode":
      return "episode";
    case "synthesize":
      return "synthesize";
    case "briefing":
      return "briefing";
    case "member_knowledge_synthesis":
      return "manual";
  }
}
