import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  LlmCallListQuerySchema,
  PipelineHealthQuerySchema,
  UsageQuerySchema,
} from "../contracts/observability.contract";
import { LlmCallQueryService } from "../services/llm-call-query.service";
import { PipelineHealthService } from "../services/pipeline-health.service";

// New observability endpoints sit alongside the existing tool-invocation
// surface (summary, tools, invocations). They live under
// /v1/observability/* and require a Supabase JWT, mirroring the existing
// controller's auth contract.
@Controller("observability")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Observability")
@ApiBearerAuth("supabase-bearer")
export class LlmCallsController {
  constructor(
    private readonly llmCallQueryService: LlmCallQueryService,
    private readonly pipelineHealthService: PipelineHealthService,
  ) {}

  @Get("llm-calls")
  async listLlmCalls(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ): Promise<unknown> {
    const parsed = parseWithSchema(LlmCallListQuerySchema, query);
    return okResponse(await this.llmCallQueryService.listLlmCalls(context, parsed));
  }

  @Get("usage")
  async usage(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ): Promise<unknown> {
    const parsed = parseWithSchema(UsageQuerySchema, query);
    return okResponse(await this.llmCallQueryService.usage(context, parsed));
  }

  @Get("pipeline-health")
  async pipelineHealth(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ): Promise<unknown> {
    parseWithSchema(PipelineHealthQuerySchema, query);
    return okResponse(await this.pipelineHealthService.snapshot(context));
  }
}
