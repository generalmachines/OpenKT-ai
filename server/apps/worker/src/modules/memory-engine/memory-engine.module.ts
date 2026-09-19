import { Module } from "@nestjs/common";

import {
  LlmGatewayService,
  LLM_CALL_RECORDER,
  LLM_QUOTA_CHECK,
} from "@openkt/platform-llm";

import { WorkerDatabaseModule } from "../database/worker-database.module";
import { BriefingBatchService } from "./services/briefing-batch.service";
import { BriefingStageService } from "./services/briefing-stage.service";
import { EmbedStageService } from "./services/embed-stage.service";
import { EpisodeStageService } from "./services/episode-stage.service";
import { JobLedgerService } from "./services/job-ledger.service";
import { MemberKnowledgeBatchService } from "./services/member-knowledge-batch.service";
import { MemberKnowledgeStageService } from "./services/member-knowledge-stage.service";
import { MemoryPipelineOrchestratorService } from "./services/memory-pipeline.orchestrator.service";
import { PreprocessStageService } from "./services/preprocess-stage.service";
import { RmqCommandConsumerService } from "./services/rmq-command-consumer.service";
import { SqsCommandConsumerService } from "./services/sqs-command-consumer.service";
import { SynthesizeStageService } from "./services/synthesize-stage.service";
import { TriageStageService } from "./services/triage-stage.service";
import { WorkerLlmCallRecorder } from "./services/worker-llm-call-recorder.service";
import { WorkerLlmQuotaChecker } from "./services/worker-llm-quota-checker.service";
import { WorkerTagMatcherService } from "./services/worker-tag-matcher.service";
import { WorkerLlmConfigResolverService } from "./services/worker-llm-config-resolver.service";

// The LLM gateway lib (@openkt/platform-llm) accepts an optional
// `LLM_CALL_RECORDER` so it can stay framework-agnostic. The server
// app binds a Drizzle-based recorder; the worker — which doesn't have
// the Drizzle module graph — binds its own pg-backed recorder
// (`WorkerLlmCallRecorder`). Without this binding every LLM call from
// the worker (triage / synthesize / episode / member_knowledge /
// briefing) goes unrecorded in `llm_calls`, which is exactly what
// prod was seeing (0 rows in the table despite hundreds of runs).
@Module({
  imports: [WorkerDatabaseModule],
  providers: [
    WorkerLlmConfigResolverService,
    JobLedgerService,
    WorkerLlmCallRecorder,
    WorkerLlmQuotaChecker,
    { provide: LLM_CALL_RECORDER, useExisting: WorkerLlmCallRecorder },
    { provide: LLM_QUOTA_CHECK, useExisting: WorkerLlmQuotaChecker },
    LlmGatewayService,
    WorkerTagMatcherService,
    PreprocessStageService,
    EmbedStageService,
    TriageStageService,
    EpisodeStageService,
    SynthesizeStageService,
    MemberKnowledgeStageService,
    BriefingStageService,
    // Cron services that batch the per-(project, user) member-knowledge
    // and per-project briefing work. Each emits one MQ command per
    // affected project on a 5-minute tick instead of one per memory.
    MemberKnowledgeBatchService,
    BriefingBatchService,
    MemoryPipelineOrchestratorService,
    RmqCommandConsumerService,
    SqsCommandConsumerService,
  ],
  exports: [RmqCommandConsumerService, SqsCommandConsumerService],
})
export class MemoryEngineModule {}
