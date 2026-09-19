import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
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

import { QUERY_NAMES } from "../queries";
import { GraphQueryService } from "../services/graph-query.service";

// Schema for the project_id path param. Same UUID shape the existing
// graph controller uses.
const ProjectIdParamSchema = z.object({
  project_id: z.string().uuid(),
});

// Top-level body schema. The query NAME is validated to be a string
// here, but resolving it against the whitelist (and producing the
// `unknown_query` error code with the available list) is done inside
// GraphQueryService — that keeps the controller thin and the dispatch
// logic centralized.
const QueryBodySchema = z.object({
  query: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

@Controller("projects")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Knowledge Graph")
@ApiBearerAuth("supabase-bearer")
export class GraphQueryController {
  constructor(private readonly graphQueryService: GraphQueryService) {}

  @Post(":project_id/graph/query")
  // This is a read-only RPC. Nest defaults POST to 201; we want a
  // standard 200 OK because nothing was created.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Run a named Cypher / SQL query from the OpenKT graph query library. " +
      "Whitelisted queries only — no raw Cypher from clients.",
    description: `Available queries: ${QUERY_NAMES.join(", ")}`,
  })
  @ApiParam({ name: "project_id", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          enum: QUERY_NAMES,
          description: "Name of a registered graph query (see `GraphQueryService.availableQueries()`).",
        },
        params: {
          type: "object",
          description: "Per-query params. Schema differs per query — see registry docs.",
          additionalProperties: true,
        },
      },
    },
  })
  @RateLimit({
    key: "user",
    name: "graph_query",
    // 30/min/user — Cypher reads are heavy enough to deserve a tight cap.
    capacity: 30,
    refillPerSec: 30 / 60,
  })
  async run(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { project_id } = parseWithSchema(ProjectIdParamSchema, params);
    const parsedBody = parseWithSchema(QueryBodySchema, body);
    const result = await this.graphQueryService.execute(context, project_id, {
      query: parsedBody.query,
      params: parsedBody.params,
    });
    return okResponse(result);
  }
}
