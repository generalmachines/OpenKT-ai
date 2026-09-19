import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { ProjectsApplicationService } from "../services/projects-application.service";
import { ProjectScopeService } from "../services/project-scope.service";
import type { ActorContext } from "@openkt/core-context";

// Path params + body keys are snake_case per the v1 contract. The
// service still works with camelCase internally — schemas transform
// at the boundary so internal types stay idiomatic.
const ProjectIdSchema = z.object({ id: z.string().uuid() });
const ProjectSlugSchema = z
  .object({
    account_slug: z.string().min(1).max(64),
    project_slug: z.string().min(1).max(64),
  })
  .transform((value) => ({
    accountSlug: value.account_slug,
    projectSlug: value.project_slug,
  }));
const ListProjectsSchema = z
  .object({
    org_id: z.string().uuid().optional(),
    visibility: z.enum(["personal", "org", "public"]).optional(),
  })
  .transform((value) => ({
    orgId: value.org_id,
    visibility: value.visibility,
  }));
// `slug` is optional: without one it is made from the name (and made unique
// among the caller's own spaces), so `{name}` alone creates a team space.
const CreateProjectSchema = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(41)
      .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "lowercase-kebab, 2-41 chars")
      .optional(),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    visibility: z.enum(["personal", "org", "public"]).default("personal"),
    org_id: z.string().uuid().nullable().default(null),
  })
  .transform((value) => ({
    slug: value.slug,
    name: value.name,
    description: value.description ?? null,
    visibility: value.visibility,
    orgId: value.org_id,
  }));
// PATCH /v1/projects/:id (owner): name and/or description.
const UpdateProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, { message: "pass name and/or description" });

@Controller("projects")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Projects")
@ApiBearerAuth("supabase-bearer")
export class ProjectsController {
  constructor(
    private readonly projectsApplicationService: ProjectsApplicationService,
    private readonly projectScopeService: ProjectScopeService,
  ) {}

  // M2 "Personal default space" — product.md "Every person has a
  // private personal space, so nothing is ever dropped for lack of
  // somewhere to put it." Lazily creates the caller's personal project
  // on first call (ProjectScopeService.resolvePersonalProjectId is
  // already the fallback every save/recall/prime call uses when
  // project_id is omitted); this endpoint just exposes the same
  // get-or-create as a direct REST call so the dashboard (or any
  // client) can resolve "my personal space" without saving a memory
  // first. Registered before `:id` so the literal segment wins.
  @Get("personal")
  @ApiOperation({ summary: "Get (or lazily create) the caller's personal project" })
  async getPersonal(@ActorContextParam() context: ActorContext) {
    const projectId = await this.projectScopeService.resolvePersonalProjectId(context);
    return okResponse(await this.projectsApplicationService.getById(context, projectId));
  }

  @Get()
  @ApiOperation({ summary: "List projects visible to the current principal" })
  @ApiQuery({ name: "org_id", required: false, schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "visibility", required: false, schema: { type: "string", enum: ["personal", "org", "public"] } })
  async listVisible(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ) {
    const filters = parseWithSchema(ListProjectsSchema, query);
    return okResponse(await this.projectsApplicationService.listVisible(context, filters));
  }

  @Post()
  @ApiOperation({ summary: "Create a project (a space). `{name}` alone is enough: the slug is made from the name." })
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
        description: { type: "string", maxLength: 2000, nullable: true },
        visibility: { type: "string", enum: ["personal", "org", "public"], default: "personal" },
        org_id: { type: "string", format: "uuid", nullable: true, default: null },
      },
      required: ["name"],
    },
  })
  async create(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(CreateProjectSchema, body);
    return okResponse(await this.projectsApplicationService.create(context, input));
  }

  @Get("slug/:account_slug/:project_slug")
  @ApiOperation({ summary: "Get a project by account slug and project slug" })
  @ApiParam({ name: "account_slug", schema: { type: "string", maxLength: 64 } })
  @ApiParam({ name: "project_slug", schema: { type: "string", maxLength: 64 } })
  async getBySlug(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(ProjectSlugSchema, params);
    return okResponse(
      await this.projectsApplicationService.getBySlug(
        context,
        input.accountSlug,
        input.projectSlug,
      ),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a project by id" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async getById(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(ProjectIdSchema, params);
    return okResponse(await this.projectsApplicationService.getById(context, input.id));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Rename a space or change its description (owner)" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 2000, nullable: true },
      },
    },
  })
  async update(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(ProjectIdSchema, params);
    const patch = parseWithSchema(UpdateProjectSchema, body ?? {});
    return okResponse(await this.projectsApplicationService.update(context, id, patch));
  }

  @Get(":id/members")
  @ApiOperation({
    summary: "Who is in a space: names and roles, for every member. Emails and pending shares stay in the owner's grants list.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async members(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(ProjectIdSchema, params);
    return okResponse(await this.projectsApplicationService.members(context, id));
  }

  @Delete(":id")
  @ApiOperation({
    summary:
      "Delete a space (owner; not the personal space). It is gone for everyone: its facts leave recall, its shares and join links go.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async delete(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(ProjectIdSchema, params);
    return okResponse(await this.projectsApplicationService.delete(context, id));
  }
}
