import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import type { ActorContext } from "@openkt/core-context";

import { MemoryTraceService } from "../services/memory-trace.service";

// The trace endpoint mounts on the same root as MemoriesController so
// the final route is GET /v1/memories/:memory_id/trace. It lives in a
// separate controller so the existing `memories.controller.ts` stays
// focused on CRUD/search/recall and the trace logic can grow its own
// shape independently.

const TraceMemoryIdParamsSchema = z.object({
  memory_id: z.string().uuid(),
});

@Controller("memories")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Memory Trace")
@ApiBearerAuth("supabase-bearer")
export class MemoryTraceController {
  constructor(private readonly memoryTraceService: MemoryTraceService) {}

  @Get(":memory_id/trace")
  @ApiOperation({
    summary:
      "Full pipeline trace for a memory — preprocess → embed → triage → " +
      "episode plus the resulting episode and similar memories.",
  })
  @ApiParam({ name: "memory_id", schema: { type: "string", format: "uuid" } })
  async trace(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const { memory_id } = parseWithSchema(TraceMemoryIdParamsSchema, params);
    return okResponse(await this.memoryTraceService.trace(context, memory_id));
  }
}
