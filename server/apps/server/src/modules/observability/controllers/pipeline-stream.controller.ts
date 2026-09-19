import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import { PipelineStreamService } from "../services/pipeline-stream.service";

// Chronological firehose for the UI's "live pipeline" view. One
// endpoint, three event sources (agentic_jobs / llm_calls /
// outbox_events) UNION'd in a single SQL pass.
//
// Auth: SupabaseJwtGuard (the project-level "JwtAuthGuard" everywhere
// else in the server app uses) plus per-call requireProjectAccess(read)
// inside the service so a token without project read is rejected.
//
// Rate limit: 60/min/user — the UI polls this for the live view, so
// the cap needs to accommodate ~1 request/sec without budget anxiety
// while still rejecting a scripted firehose.

const ProjectIdParamSchema = z.object({
  project_id: z.string().uuid(),
});

const PipelineStreamQuerySchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(512).optional(),
  })
  .passthrough();

@Controller("projects")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Observability")
@ApiBearerAuth("supabase-bearer")
export class PipelineStreamController {
  constructor(private readonly pipelineStreamService: PipelineStreamService) {}

  @Get(":project_id/pipeline-stream")
  @ApiOperation({
    summary:
      "Chronological firehose of pipeline events (stage runs, LLM calls, outbox " +
      "messages) for a project. UI polls this for the live pipeline view.",
  })
  @ApiParam({ name: "project_id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "since",
    required: false,
    schema: { type: "string", format: "date-time" },
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
  })
  @ApiQuery({ name: "cursor", required: false, schema: { type: "string" } })
  @RateLimit({
    key: "user",
    name: "pipeline_stream",
    // 60/min/user → ~1 poll/sec. The bucket is sized for steady UI
    // polling; bursts are capped at 60 before backpressure kicks in.
    capacity: 60,
    refillPerSec: 60 / 60,
  })
  async stream(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdParamSchema, params);
    const parsedQuery = parseWithSchema(PipelineStreamQuerySchema, query);
    const result = await this.pipelineStreamService.stream(context, {
      project_id,
      since: parsedQuery.since,
      limit: parsedQuery.limit,
      cursor: parsedQuery.cursor,
    });
    return okResponse(result);
  }
}
