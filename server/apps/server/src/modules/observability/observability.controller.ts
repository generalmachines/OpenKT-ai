import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../common/http/ok-response";
import { ActorContextParam } from "../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../auth/guards/supabase-jwt.guard";
import { ObservabilityService } from "./observability.service";

@Controller("observability")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Observability")
@ApiBearerAuth("supabase-bearer")
export class ObservabilityController {
  constructor(private readonly observabilityService: ObservabilityService) {}

  @Get("summary")
  async summary(@ActorContextParam() context: ActorContext, @Query() query: unknown): Promise<unknown> {
    return okResponse(await this.observabilityService.summary(context, query));
  }

  @Get("tools")
  async tools(@ActorContextParam() context: ActorContext, @Query() query: unknown): Promise<unknown> {
    return okResponse(await this.observabilityService.tools(context, query));
  }

  @Get("tools/:name")
  async toolDetail(
    @ActorContextParam() context: ActorContext,
    @Param("name") name: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    return okResponse(await this.observabilityService.toolDetail(context, name, query));
  }

  @Get("invocations")
  async invocations(@ActorContextParam() context: ActorContext, @Query() query: unknown): Promise<unknown> {
    return okResponse(await this.observabilityService.invocations(context, query));
  }

  @Get("invocations/:id")
  async invocation(@ActorContextParam() context: ActorContext, @Param("id") id: string): Promise<unknown> {
    return okResponse(await this.observabilityService.invocation(context, id));
  }

  @Get("memories/:id/activity")
  async memoryActivity(
    @ActorContextParam() context: ActorContext,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    return okResponse(await this.observabilityService.memoryActivity(context, id, query));
  }

}
