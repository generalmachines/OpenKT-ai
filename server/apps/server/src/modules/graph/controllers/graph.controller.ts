import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import type { ActorContext } from "@openkt/core-context";

import {
  GraphProjectIdParamsSchema,
  GraphQuerySchema,
} from "../contracts/graph.contract";
import { GraphService } from "../services/graph.service";

@Controller("projects")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Knowledge Graph")
@ApiBearerAuth("supabase-bearer")
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get(":project_id/graph")
  @ApiOperation({
    summary:
      "Knowledge graph for a project — nodes (memories, episodes, entities) " +
      "and edges (contributes_to, supersedes, mentions, similar)",
  })
  @ApiParam({ name: "project_id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "focus", required: false, schema: { type: "string", maxLength: 128 } })
  @ApiQuery({
    name: "depth",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 5, default: 2 },
  })
  @ApiQuery({
    name: "include",
    required: false,
    schema: {
      type: "string",
      description: "comma-separated subset of: memories,episodes,entities,similarity",
    },
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
  })
  @RateLimit({ key: "user", name: "graph_view", capacity: 30, refillPerSec: 0.5 })
  async getGraph(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { project_id } = parseWithSchema(GraphProjectIdParamsSchema, params);
    const parsed = parseWithSchema(GraphQuerySchema, query);
    return okResponse(await this.graphService.build(context, project_id, parsed));
  }
}
