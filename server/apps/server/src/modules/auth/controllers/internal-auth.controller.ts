import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { ActorContextParam } from "../decorators/actor-context.decorator";
import { ServicePrincipalGuard } from "../guards/service-principal.guard";
import { SupabaseJwtGuard } from "../guards/supabase-jwt.guard";

@Controller("internal/auth")
@ApiTags("Internal Auth")
export class InternalAuthController {
  @Get("me")
  @UseGuards(SupabaseJwtGuard)
  @ApiBearerAuth("supabase-bearer")
  @ApiOperation({ summary: "Inspect the current JWT-authenticated principal" })
  getCurrentPrincipal(
    @ActorContextParam() actorContext: ActorContext,
  ): { data: unknown; error: null; meta: null } {
    return {
      data: {
        principal: actorContext.principal,
        request: actorContext.request,
        client: actorContext.sb.kind,
      },
      error: null,
      meta: null,
    };
  }

  @Get("service")
  @UseGuards(ServicePrincipalGuard)
  @ApiOperation({ summary: "Inspect the current service principal" })
  getServicePrincipal(
    @ActorContextParam() actorContext: ActorContext,
  ): { data: unknown; error: null; meta: null } {
    return {
      data: {
        principal: actorContext.principal,
        request: actorContext.request,
        client: actorContext.sb.kind,
      },
      error: null,
      meta: null,
    };
  }
}
