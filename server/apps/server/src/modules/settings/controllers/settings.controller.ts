import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { SettingsApplicationService } from "../services/settings-application.service";
import type { ActorContext } from "@openkt/core-context";

const SettingsBagSchema = z.record(z.string(), z.unknown());
const UpdateSettingsSchema = z.object({ settings: SettingsBagSchema });
const ProjectIdSchema = z.object({ projectId: z.string().uuid() });
const OrgSlugSchema = z.object({ orgSlug: z.string().min(1).max(64) });

@Controller("settings")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Settings")
@ApiBearerAuth("supabase-bearer")
export class SettingsController {
  constructor(private readonly settingsApplicationService: SettingsApplicationService) {}

  @Get("user")
  @ApiOperation({ summary: "Get user settings" })
  async getUser(@ActorContextParam() context: ActorContext) {
    return okResponse(await this.settingsApplicationService.getUser(context));
  }

  @Put("user")
  @ApiOperation({ summary: "Update user settings" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        settings: { type: "object", additionalProperties: true },
      },
      required: ["settings"],
    },
  })
  async updateUser(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(UpdateSettingsSchema, body);
    return okResponse(await this.settingsApplicationService.updateUser(context, input.settings));
  }

  @Get("projects/:projectId")
  @ApiOperation({ summary: "Get project settings" })
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  async getProject(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(ProjectIdSchema, params);
    return okResponse(await this.settingsApplicationService.getProject(context, input.projectId));
  }

  @Put("projects/:projectId")
  @ApiOperation({ summary: "Update project settings" })
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        settings: { type: "object", additionalProperties: true },
      },
      required: ["settings"],
    },
  })
  async updateProject(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = parseWithSchema(ProjectIdSchema, params);
    const input = parseWithSchema(UpdateSettingsSchema, body);
    return okResponse(
      await this.settingsApplicationService.updateProject(
        context,
        route.projectId,
        input.settings,
      ),
    );
  }

  @Get("orgs/:orgSlug")
  @ApiOperation({ summary: "Get organization settings" })
  @ApiParam({ name: "orgSlug", schema: { type: "string", maxLength: 64 } })
  async getOrg(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(OrgSlugSchema, params);
    return okResponse(await this.settingsApplicationService.getOrg(context, input.orgSlug));
  }

  @Put("orgs/:orgSlug")
  @ApiOperation({ summary: "Update organization settings" })
  @ApiParam({ name: "orgSlug", schema: { type: "string", maxLength: 64 } })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        settings: { type: "object", additionalProperties: true },
      },
      required: ["settings"],
    },
  })
  async updateOrg(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = parseWithSchema(OrgSlugSchema, params);
    const input = parseWithSchema(UpdateSettingsSchema, body);
    return okResponse(
      await this.settingsApplicationService.updateOrg(context, route.orgSlug, input.settings),
    );
  }
}
