import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import type { ActorContext } from "@openkt/core-context";
import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { OrgsApplicationService } from "../services/orgs-application.service";

const CreateOrgSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(41)
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "lowercase-kebab, 2-41 chars"),
  name: z.string().min(1).max(120),
});

const OrgSlugSchema = z.object({
  slug: z.string().min(1).max(64),
});

@Controller("orgs")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Orgs")
@ApiBearerAuth("supabase-bearer")
export class OrgsController {
  constructor(private readonly orgsApplicationService: OrgsApplicationService) {}

  @Get()
  @ApiOperation({ summary: "List organizations visible to the current principal" })
  async listMine(@ActorContextParam() context: ActorContext) {
    return okResponse(await this.orgsApplicationService.listMine(context));
  }

  @Post()
  @ApiOperation({ summary: "Create an organization" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          minLength: 2,
          maxLength: 41,
          pattern: "^[a-z0-9][a-z0-9-]{1,40}$",
        },
        name: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["slug", "name"],
    },
  })
  async create(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(CreateOrgSchema, body);
    return okResponse(await this.orgsApplicationService.create(context, input));
  }

  @Get("slug/:slug")
  @ApiOperation({ summary: "Get an organization by slug" })
  @ApiParam({ name: "slug", schema: { type: "string", maxLength: 64 } })
  async getBySlug(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(OrgSlugSchema, params);
    return okResponse(await this.orgsApplicationService.getBySlug(context, input.slug));
  }

  @Get("slug/:slug/members")
  @ApiOperation({ summary: "List organization members by organization slug" })
  @ApiParam({ name: "slug", schema: { type: "string", maxLength: 64 } })
  async listMembers(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(OrgSlugSchema, params);
    return okResponse(await this.orgsApplicationService.listMembers(context, input.slug));
  }
}
