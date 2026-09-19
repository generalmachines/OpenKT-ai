import { Body, Controller, Delete, Get, Param, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";

import {
  GrantSubjectParamsSchema,
  PutGrantBodySchema,
  ResourceIdParamsSchema,
} from "../contracts/grant.contract";
import { GrantsApplicationService } from "../services/grants-application.service";

// Owner-only grant management on a single session — the "share this
// one conversation without opening my whole personal space" case
// (architecture.md §3).
@Controller("sessions/:id/grants")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Grants")
@ApiBearerAuth("supabase-bearer")
export class SessionGrantsController {
  constructor(private readonly grantsApplicationService: GrantsApplicationService) {}

  @Get()
  @ApiOperation({ summary: "List grants on a session (owner-only)" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async list(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(ResourceIdParamsSchema, params);
    return okResponse(await this.grantsApplicationService.list(context, "session", id));
  }

  @Put(":userId")
  @ApiOperation({ summary: "Grant (or update) a user's role on a session (owner-only)" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "userId", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      properties: { role: { type: "string", enum: ["reader", "editor", "owner"] } },
      required: ["role"],
    },
  })
  async put(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id, userId } = parseWithSchema(GrantSubjectParamsSchema, params);
    const { role } = parseWithSchema(PutGrantBodySchema, body);
    return okResponse(await this.grantsApplicationService.put(context, "session", id, userId, role));
  }

  @Delete(":userId")
  @ApiOperation({ summary: "Revoke a user's grant on a session (owner-only)" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "userId", schema: { type: "string", format: "uuid" } })
  async remove(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id, userId } = parseWithSchema(GrantSubjectParamsSchema, params);
    return okResponse(await this.grantsApplicationService.remove(context, "session", id, userId));
  }
}
