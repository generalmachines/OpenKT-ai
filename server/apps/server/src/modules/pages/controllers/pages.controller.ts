import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { pagedResponse } from "../../../common/http/paged-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import { EditSectionSchema, PageIdParamsSchema, ProjectParamsSchema, SectionParamsSchema } from "../contracts/page.contract";
import { PagesApplicationService } from "../services/pages-application.service";

// Living pages (T2) and the space brief (T3) — Spec 04 "Spaces, pages, briefs".
@Controller()
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Pages")
@ApiBearerAuth("supabase-bearer")
export class PagesController {
  constructor(private readonly pages: PagesApplicationService) {}

  @Get("projects/:id/pages")
  @ApiOperation({ summary: "A space's pages; meta.processing says whether sessions are waiting for a Mac to process them" })
  async list(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(ProjectParamsSchema, params);
    const { pages, processing } = await this.pages.list(context, id);
    return pagedResponse(pages, { processing });
  }

  @Get("projects/:id/brief")
  @ApiOperation({ summary: "The space brief: {brief_md, updated_at}" })
  async brief(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(ProjectParamsSchema, params);
    return okResponse(await this.pages.brief(context, id));
  }

  @Get("pages/:id")
  @ApiOperation({ summary: "A page with its sections, numbered citations and sources (who said it, in which session)" })
  async get(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(PageIdParamsSchema, params);
    return okResponse(await this.pages.get(context, id));
  }

  @Get("pages/:id/revisions")
  @ApiOperation({ summary: "A page's revisions, newest first" })
  async revisions(@ActorContextParam() context: ActorContext, @Param() params: unknown) {
    const { id } = parseWithSchema(PageIdParamsSchema, params);
    return okResponse(await this.pages.revisions(context, id));
  }

  @Put("pages/:id/sections/:sid")
  @ApiOperation({ summary: "Edit a section (editor). Locks it: agents never rewrite it again. Writes a revision." })
  @RateLimit({ key: "user", name: "page_section_edit", capacity: 60, refillPerSec: 1 })
  async edit(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id, sid } = parseWithSchema(SectionParamsSchema, params);
    return okResponse(await this.pages.editSection(context, id, sid, parseWithSchema(EditSectionSchema, body ?? {})));
  }
}
