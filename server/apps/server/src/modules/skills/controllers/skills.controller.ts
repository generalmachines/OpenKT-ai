import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { PutGrantByEmailBodySchema } from "../../grants/contracts/grant.contract";
import { GrantsApplicationService } from "../../grants/services/grants-application.service";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";

import {
  CreateSkillSchema,
  ListSkillsQuerySchema,
  PatchSkillSchema,
  RecordSkillRunSchema,
  SaveSkillVersionSchema,
  SkillGrantParamsSchema,
  SkillIdParamsSchema,
  SkillVersionParamsSchema,
} from "../contracts/skill.contract";
import { SkillsApplicationService } from "../services/skills-application.service";

const FILES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};
const ID_PARAM = { name: "id", schema: { type: "string", format: "uuid" } } as const;

// Skills — shared, versioned folders of text files (Spec 04 "Skills"). The
// access rules live in SkillsApplicationService; the access list itself is
// the same GrantsApplicationService spaces and sessions use.
@Controller("skills")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Skills")
@ApiBearerAuth("supabase-bearer")
export class SkillsController {
  constructor(
    private readonly skills: SkillsApplicationService,
    private readonly grants: GrantsApplicationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the skills the caller can use, newest first" })
  @ApiQuery({ name: "project_id", required: false, schema: { type: "string" } })
  @ApiQuery({ name: "q", required: false, schema: { type: "string" } })
  @ApiQuery({ name: "archived", required: false, schema: { type: "string", enum: ["true", "false"], default: "false" } })
  async list(@ActorContextParam() context: ActorContext, @Query() query: unknown) {
    return okResponse(await this.skills.list(context, parseWithSchema(ListSkillsQuerySchema, query)));
  }

  @Post()
  @ApiOperation({
    summary: "Create a skill (version 1). With neither `files` nor `skill_md`, a starter SKILL.md is written from the title.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        project_id: { type: "string", nullable: true, description: "The space it lives in. Omit for a personal skill." },
        files: FILES_SCHEMA,
        skill_md: { type: "string" },
        change_note: { type: "string", maxLength: 500, nullable: true },
      },
      required: ["title"],
    },
  })
  @RateLimit({ key: "user", name: "skill_write", capacity: 60, refillPerSec: 1 })
  async create(@ActorContextParam() context: ActorContext, @Body() body: unknown) {
    return okResponse(await this.skills.create(context, parseWithSchema(CreateSkillSchema, body)));
  }

  @Get(":id")
  @ApiOperation({ summary: "A skill with the files of its current version, its version history and the caller's role" })
  @ApiParam(ID_PARAM)
  async get(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    return okResponse(await this.skills.get(context, id));
  }

  @Put(":id")
  @ApiOperation({
    summary: "Save a new version (editor). `base_version` must equal the current version, else 409 `version_conflict`.",
  })
  @ApiParam(ID_PARAM)
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        files: FILES_SCHEMA,
        change_note: { type: "string", maxLength: 500, nullable: true },
        title: { type: "string", maxLength: 200 },
        base_version: { type: "integer", minimum: 1 },
      },
      required: ["files", "base_version"],
    },
  })
  @RateLimit({ key: "user", name: "skill_write", capacity: 60, refillPerSec: 1 })
  async save(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    return okResponse(await this.skills.saveVersion(context, id, parseWithSchema(SaveSkillVersionSchema, body)));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Move a skill to another space, or archive / unarchive it (editor)" })
  @ApiParam(ID_PARAM)
  @ApiBody({
    schema: {
      type: "object",
      properties: { project_id: { type: "string", nullable: true }, archived: { type: "boolean" } },
    },
  })
  async patch(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    return okResponse(await this.skills.patch(context, id, parseWithSchema(PatchSkillSchema, body)));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a skill with all its versions (owner)" })
  @ApiParam(ID_PARAM)
  async remove(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    return okResponse(await this.skills.delete(context, id));
  }

  @Get(":id/versions/:n")
  @ApiOperation({ summary: "The files of one version" })
  @ApiParam(ID_PARAM)
  @ApiParam({ name: "n", schema: { type: "integer", minimum: 1 } })
  async getVersion(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id, n } = parseWithSchema(SkillVersionParamsSchema, params);
    return okResponse(await this.skills.getVersion(context, id, n));
  }

  @Post(":id/versions/:n/restore")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Restore an old version — as a NEW version copying it (editor)" })
  @ApiParam(ID_PARAM)
  @ApiParam({ name: "n", schema: { type: "integer", minimum: 1 } })
  @RateLimit({ key: "user", name: "skill_write", capacity: 60, refillPerSec: 1 })
  async restore(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id, n } = parseWithSchema(SkillVersionParamsSchema, params);
    return okResponse(await this.skills.restore(context, id, n));
  }

  @Post(":id/runs")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record one use of the skill and return its current files" })
  @ApiParam(ID_PARAM)
  @ApiBody({ schema: { type: "object", properties: { surface: { type: "string", enum: ["app", "mcp", "api"], default: "api" } } } })
  @RateLimit({ key: "user", name: "skill_run", capacity: 600, refillPerSec: 10 })
  async run(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    const { surface } = parseWithSchema(RecordSkillRunSchema, body ?? {});
    return okResponse(await this.skills.recordRun(context, id, surface));
  }

  @Get(":id/export")
  @ApiOperation({ summary: "The current files as JSON, for a client that writes the folder to disk itself" })
  @ApiParam(ID_PARAM)
  async export(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    return okResponse(await this.skills.exportFiles(context, id));
  }

  // ── who can use it ────────────────────────────────────────────────
  // Same shapes, same code as /v1/projects/:id/grants. A caller who cannot
  // read the skill gets 404 before the owner check can answer 403.

  @Get(":id/grants")
  @ApiOperation({ summary: "List grants and pending shares on a skill (owner-only)" })
  @ApiParam(ID_PARAM)
  async listGrants(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    await this.skills.assertReadable(context, id);
    return okResponse(await this.grants.list(context, "skill", id));
  }

  @Put(":id/grants")
  @ApiOperation({
    summary: "Share a skill by email (owner-only). An unknown email becomes a pending share that converts at sign-up.",
  })
  @ApiParam(ID_PARAM)
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        subject_id: { type: "string", format: "uuid" },
        role: { type: "string", enum: ["reader", "editor", "owner"] },
      },
      required: ["role"],
    },
  })
  async putGrant(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(SkillIdParamsSchema, params);
    const { role, ...target } = parseWithSchema(PutGrantByEmailBodySchema, body);
    await this.skills.assertReadable(context, id);
    return okResponse(await this.grants.putByEmailOrSubject(context, "skill", id, target, role));
  }

  @Delete(":id/grants/:grantId")
  @ApiOperation({ summary: "Revoke a grant (by the grantee's user id) or withdraw a pending share (by its id) — owner-only" })
  @ApiParam(ID_PARAM)
  @ApiParam({ name: "grantId", schema: { type: "string", format: "uuid" } })
  async removeGrant(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id, grantId } = parseWithSchema(SkillGrantParamsSchema, params);
    await this.skills.assertReadable(context, id);
    return okResponse(await this.grants.remove(context, "skill", id, grantId));
  }
}
