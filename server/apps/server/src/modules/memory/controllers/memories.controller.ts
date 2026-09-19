import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { pagedResponse } from "../../../common/http/paged-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import type { ActorContext } from "@openkt/core-context";

import {
  AnswerRequestSchema,
  CreateMemorySchema,
  DeleteMemoryInputSchema,
  EnhanceMemorySchema,
  ListMemoriesQuerySchema,
  MemoryIdParamsSchema,
  MemoryNeighborParamsSchema,
  MemoryNeighborsQuerySchema,
  MemorySearchRequestSchema,
  RecallRequestSchema,
} from "../contracts/memory.contract";
import { MemoryAnswerService } from "../services/memory-answer.service";
import { MemoryCommandsApplicationService } from "../services/memory-commands.application.service";
import { MemoryEnhancementService } from "../services/memory-enhancement.service";
import { MemoryQueriesApplicationService } from "../services/memory-queries.application.service";
import { MemoryRecallService } from "../services/memory-recall.service";

@Controller("memories")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Memory")
@ApiBearerAuth("supabase-bearer")
export class MemoriesController {
  constructor(
    private readonly memoryCommandsApplicationService: MemoryCommandsApplicationService,
    private readonly memoryQueriesApplicationService: MemoryQueriesApplicationService,
    private readonly memoryRecallService: MemoryRecallService,
    private readonly memoryAnswerService: MemoryAnswerService,
    private readonly memoryEnhancementService: MemoryEnhancementService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List memories for a project" })
  @ApiQuery({ name: "project_id", required: true, schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } })
  @ApiQuery({ name: "offset", required: false, schema: { type: "integer", minimum: 0, default: 0 } })
  @ApiQuery({ name: "include_archived", required: false, schema: { oneOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }], default: false } })
  @ApiQuery({ name: "q", required: false, schema: { type: "string", maxLength: 200 } })
  @ApiQuery({ name: "kind", required: false, schema: { type: "string", enum: ["decision", "pattern", "incident", "skill", "context", "anti-pattern", "debug-recipe", "environment", "note", "fact", "other"] } })
  @ApiQuery({ name: "visibility", required: false, schema: { type: "string", enum: ["personal", "project", "org"] } })
  @ApiQuery({ name: "min_confidence", required: false, schema: { type: "number", minimum: 0, maximum: 1 } })
  @ApiQuery({ name: "tag", required: false, schema: { type: "string", maxLength: 100 } })
  async list(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ) {
    const input = parseWithSchema(ListMemoriesQuerySchema, query);
    const result = await this.memoryQueriesApplicationService.list(context, input);
    return pagedResponse(result.data, result.meta);
  }

  @Post()
  @ApiOperation({ summary: "Create a memory and enqueue async processing through the outbox" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 20000 },
        kind: { type: "string", enum: ["decision", "pattern", "incident", "skill", "context", "anti-pattern", "debug-recipe", "environment", "note", "fact", "other"], default: "note" },
        project_id: { type: "string", maxLength: 256 },
        visibility: { type: "string", enum: ["personal", "project", "org"], default: "project" },
        tag_slugs: {
          type: "array",
          maxItems: 8,
          items: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
            minLength: 2,
            maxLength: 40,
          },
        },
        category: { type: "string", nullable: true, maxLength: 64 },
        confidence: { type: "number", minimum: 0, maximum: 1, default: 1 },
        importance: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        source_refs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["commit", "pr", "issue", "url", "file", "decision"] },
              ref: { type: "string", minLength: 1, maxLength: 512 },
            },
            required: ["kind", "ref"],
          },
        },
      },
      required: ["content"],
    },
  })
  @RateLimit(
    { key: "user", name: "memory_create", capacity: 60, refillPerSec: 1 },
    { key: "org", name: "memory_create", capacity: 300, refillPerSec: 5 },
  )
  async create(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(CreateMemorySchema, body);
    return okResponse(await this.memoryCommandsApplicationService.create(context, input));
  }

  @Post("enhance")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Enhance memory content and suggest tags/kind" })
  async enhance(@Body() body: unknown) {
    const input = parseWithSchema(EnhanceMemorySchema, body);
    return okResponse(await this.memoryEnhancementService.enhance(input));
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a memory by id" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async getById(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(MemoryIdParamsSchema, params);
    return okResponse(await this.memoryQueriesApplicationService.get(context, input.id));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Forget a memory — archive (default) or hard-delete with ?hard=true" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "hard",
    required: false,
    schema: { oneOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }], default: false },
  })
  async forget(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const input = parseWithSchema(DeleteMemoryInputSchema, {
      ...(params as Record<string, unknown>),
      ...(query as Record<string, unknown>),
    });
    return okResponse(await this.memoryCommandsApplicationService.forget(context, input));
  }

  @Get(":id/access")
  @ApiOperation({ summary: "Get access and recall summary for a memory" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async getAccessSummary(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(MemoryIdParamsSchema, params);
    return okResponse(await this.memoryQueriesApplicationService.accessSummary(context, input.id));
  }

  @Get(":memory_id/neighbors")
  @ApiOperation({
    summary:
      "Pre-computed semantic neighbors for a memory — top-N pgvector matches " +
      "from the worker's neighbors stage, with preview + tags.",
  })
  @ApiParam({ name: "memory_id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } })
  @ApiQuery({ name: "min_similarity", required: false, schema: { type: "number", minimum: 0, maximum: 1, default: 0.5 } })
  async getNeighbors(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { memory_id } = parseWithSchema(MemoryNeighborParamsSchema, params);
    const { limit, min_similarity } = parseWithSchema(MemoryNeighborsQuerySchema, query);
    return okResponse(
      await this.memoryQueriesApplicationService.neighbors(
        context,
        memory_id,
        limit,
        min_similarity,
      ),
    );
  }

  @Post("search")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Search memories with hybrid/vector/keyword retrieval" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 2000, default: "" },
        mode: { type: "string", enum: ["vector", "keyword", "hybrid"], default: "hybrid" },
        vector_weight: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
        workspace_weight: { type: "number", minimum: 0, maximum: 1, default: 0.4 },
        filters: {
          type: "object",
          properties: {
            project_ids: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 50,
            },
            visibility: {
              type: "array",
              items: { type: "string", enum: ["personal", "project", "org"] },
            },
            authors: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 50,
            },
            kinds: {
              type: "array",
              items: { type: "string", enum: ["decision", "pattern", "incident", "skill", "context", "anti-pattern", "debug-recipe", "environment", "note", "fact", "other"] },
            },
            tags: {
              type: "object",
              properties: {
                any: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20 },
                all: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20 },
                none: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20 },
              },
            },
            created_after: { type: "string", format: "date-time" },
            created_before: { type: "string", format: "date-time" },
            min_confidence: { type: "number", minimum: 0, maximum: 1 },
            min_similarity: { type: "number", minimum: 0, maximum: 1 },
            include_archived: { type: "boolean", default: false },
            include_superseded: { type: "boolean", default: false },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        cursor: { type: "string" },
      },
    },
  })
  @RateLimit(
    { key: "user", name: "memory_search", capacity: 120, refillPerSec: 2 },
    { key: "org", name: "memory_search", capacity: 600, refillPerSec: 10 },
  )
  async search(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(MemorySearchRequestSchema, body);
    const result = await this.memoryQueriesApplicationService.search(context, input);
    return pagedResponse(result.data, result.meta);
  }

  @Post("recall")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Recall the most relevant memories for a question. " +
      "Set include_knowledge=true to also receive synthesised knowledge " +
      "nodes via meta.knowledge.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        project_id: { type: "string", maxLength: 256 },
        query: { type: "string", maxLength: 2000, default: "" },
        kind: { type: "string", enum: ["decision", "pattern", "incident", "skill", "context", "anti-pattern", "debug-recipe", "environment", "note", "fact", "other"] },
        min_confidence: { type: "number", minimum: 0, maximum: 1, default: 0 },
        workspace_weight: { type: "number", minimum: 0, maximum: 1, default: 0.4 },
        vector_weight: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        invocation_id: { type: "string", format: "uuid" },
        rerank: { type: "boolean", default: false },
        // Knowledge-synthesis opt-in. When true, `meta.knowledge` is
        // populated with LLM-summarised nodes (episodes) whose tag set
        // overlaps the recalled memories'. The `data` array remains the
        // raw Memory[] shape so existing CLI / SDK consumers keep
        // parsing the payload unchanged.
        include_knowledge: { type: "boolean", default: false },
      },
    },
  })
  @RateLimit(
    { key: "user", name: "memory_recall", capacity: 120, refillPerSec: 2 },
    { key: "org", name: "memory_recall", capacity: 600, refillPerSec: 10 },
  )
  async recall(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(RecallRequestSchema, body);
    const result = await this.memoryRecallService.recall(context, input);
    return pagedResponse(result.data, result.meta);
  }

  @Post("answer")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Answer a question by composing across recalled memories" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        project_id: { type: "string", maxLength: 256 },
        question: { type: "string", minLength: 1, maxLength: 2000 },
        limit: { type: "integer", minimum: 3, maximum: 30, default: 15 },
        vector_weight: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
      },
      required: ["question"],
    },
  })
  @RateLimit({ key: "user", name: "memory_answer", capacity: 30, refillPerSec: 0.5 })
  async answer(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(AnswerRequestSchema, body);
    return okResponse(await this.memoryAnswerService.answer(context, input));
  }
}
