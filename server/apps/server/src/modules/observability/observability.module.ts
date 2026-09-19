import { Global, Module } from "@nestjs/common";

import { LLM_CALL_RECORDER, LLM_QUOTA_CHECK } from "@openkt/platform-llm";

import { PlatformAdminGuard } from "../analytics/guards/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { LlmCallsController } from "./controllers/llm-calls.controller";
import { PipelineStreamController } from "./controllers/pipeline-stream.controller";
import { RabbitMqStateController } from "./controllers/rabbitmq-state.controller";
import { UserQuotaController } from "./controllers/user-quota.controller";
import { ObservabilityController } from "./observability.controller";
import { ObservabilityService } from "./observability.service";
import { LlmCallRepository } from "./repositories/llm-call.repository";
import { LlmCallQueryService } from "./services/llm-call-query.service";
import { PipelineHealthService } from "./services/pipeline-health.service";
import { PipelineStreamService } from "./services/pipeline-stream.service";
import { RabbitMqStateService } from "./services/rabbitmq-state.service";
import { UserQuotaCheckerAdapter } from "./services/user-quota-checker.adapter";
import { UserQuotaService } from "./services/user-quota.service";

// The LlmCallRepository implements the LlmCallRecorder contract from
// @openkt/platform-llm; binding it via the LLM_CALL_RECORDER token here
// is what makes every gateway call inside the server app write a row.
// The worker app wires its own copy.
//
// Similarly, the `UserQuotaCheckerAdapter` wraps the existing
// `UserQuotaService` (object-method API) to match the
// `LlmQuotaChecker` shape consumed by the gateway. Binding it to
// `LLM_QUOTA_CHECK` is what makes the server enforce per-user token
// caps before each provider attempt.

@Global()
@Module({
  imports: [AuthModule],
  controllers: [
    ObservabilityController,
    LlmCallsController,
    UserQuotaController,
    PipelineStreamController,
    RabbitMqStateController,
  ],
  providers: [
    ObservabilityService,
    LlmCallRepository,
    LlmCallQueryService,
    PipelineHealthService,
    PipelineStreamService,
    RabbitMqStateService,
    PlatformAdminGuard,
    UserQuotaService,
    UserQuotaCheckerAdapter,
    { provide: LLM_CALL_RECORDER, useExisting: LlmCallRepository },
    { provide: LLM_QUOTA_CHECK, useExisting: UserQuotaCheckerAdapter },
  ],
  exports: [
    LlmCallRepository,
    UserQuotaService,
    UserQuotaCheckerAdapter,
    LlmCallQueryService,
    LLM_CALL_RECORDER,
    LLM_QUOTA_CHECK,
  ],
})
export class ObservabilityModule {}
