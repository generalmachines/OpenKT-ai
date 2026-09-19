import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";

import { EpisodeIdParamsSchema } from "../contracts/memory.contract";
import { KnowledgeRepository } from "../repositories/knowledge.repository";

/**
 * Read-side controller for the knowledge-synthesis layer
 * (migration 0014). Episodes are the LLM-synthesised knowledge nodes
 * that sit above raw memories — see
 * `services/synthesize-stage.service.ts` for the worker that produces
 * and refreshes them.
 *
 * Only the unarchived read is exposed: archived episodes exist as an
 * audit trail and never surface through the read API.
 */
@Controller("episodes")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Knowledge")
@ApiBearerAuth("supabase-bearer")
export class EpisodesController {
  constructor(private readonly knowledgeRepository: KnowledgeRepository) {}

  @Get(":id")
  @ApiOperation({ summary: "Fetch a knowledge node (synthesised episode) by id" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async getById(@Param() params: unknown) {
    const { id } = parseWithSchema(EpisodeIdParamsSchema, params);
    return okResponse(await this.knowledgeRepository.getById(id));
  }
}
