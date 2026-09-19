import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import type { ActorContext } from "@openkt/core-context";
import { LlmConfigsApplicationService } from "../services/llm-configs-application.service";

const ProviderSchema = z.enum(["minimax", "openai", "openrouter", "custom"]);
const ScopeSchema = z.object({
  scope_type: z.enum(["user", "org", "project"]),
  scope_id: z.string().uuid(),
});
const UpsertSchema = ScopeSchema.extend({
  provider: ProviderSchema,
  label: z.string().min(1).max(64).default("default"),
  base_url: z.string().url().nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
  api_key: z.string().min(1),
  enabled: z.boolean().default(true),
});
const IdSchema = z.object({ id: z.string().uuid() });
const EnabledSchema = z.object({ enabled: z.boolean() });

@Controller("llm-configs")
@UseGuards(SupabaseJwtGuard)
@ApiTags("LLM Configs")
@ApiBearerAuth("supabase-bearer")
export class LlmConfigsController {
  constructor(private readonly service: LlmConfigsApplicationService) {}

  @Get()
  @ApiOperation({ summary: "List masked LLM provider configs for a user, org, or project" })
  async list(@ActorContextParam() context: ActorContext, @Query() query: unknown) {
    const input = parseWithSchema(ScopeSchema, query);
    return okResponse(await this.service.list(context, input.scope_type, input.scope_id));
  }

  @Post()
  @ApiOperation({ summary: "Create or rotate an encrypted LLM provider config" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["scope_type", "scope_id", "provider", "api_key"],
      properties: {
        scope_type: { type: "string", enum: ["user", "org", "project"] },
        scope_id: { type: "string", format: "uuid" },
        provider: { type: "string", enum: ["minimax", "openai", "openrouter", "custom"] },
        label: { type: "string", default: "default" },
        base_url: { type: "string", nullable: true },
        model: { type: "string", nullable: true },
        api_key: { type: "string" },
        enabled: { type: "boolean", default: true },
      },
    },
  })
  async upsert(@ActorContextParam() context: ActorContext, @Body() body: unknown) {
    const input = parseWithSchema(UpsertSchema, body);
    return okResponse(
      await this.service.upsert(context, {
        scopeType: input.scope_type,
        scopeId: input.scope_id,
        provider: input.provider,
        label: input.label,
        baseUrl: input.base_url ?? null,
        model: input.model ?? null,
        apiKey: input.api_key,
        enabled: input.enabled,
      }),
    );
  }

  @Patch(":id/enabled")
  @ApiOperation({ summary: "Enable or disable an LLM provider config" })
  async setEnabled(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = parseWithSchema(IdSchema, params);
    const input = parseWithSchema(EnabledSchema, body);
    return okResponse(await this.service.setEnabled(context, route.id, input.enabled));
  }

  @Post(":id/test")
  @ApiOperation({ summary: "Call the provider with a tiny prompt to validate the saved key" })
  async test(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const route = parseWithSchema(IdSchema, params);
    return okResponse(await this.service.test(context, route.id));
  }
}
