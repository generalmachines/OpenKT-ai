import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { requireProjectAccess } from "@openkt/auth-authorization";
import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError } from "@openkt/core-errors";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import {
  ProjectUsageParamsSchema,
  UserQuotaParamsSchema,
  UsageQuerySchema,
} from "../contracts/observability.contract";
import { LlmCallQueryService } from "../services/llm-call-query.service";
import { UserQuotaService } from "../services/user-quota.service";

// /v1/users/:user_id/quota — caller must be the same user.
// /v1/projects/:project_id/usage — caller must have project read access.
@Controller()
@UseGuards(SupabaseJwtGuard)
@ApiTags("Observability")
@ApiBearerAuth("supabase-bearer")
export class UserQuotaController {
  constructor(
    private readonly userQuotaService: UserQuotaService,
    private readonly llmCallQueryService: LlmCallQueryService,
  ) {}

  @Get("users/:user_id/quota")
  async userQuota(
    @ActorContextParam() context: ActorContext,
    @Param("user_id") userIdParam: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    const { user_id } = parseWithSchema(UserQuotaParamsSchema, { user_id: userIdParam });
    if (context.principal.userId !== user_id) {
      throw new ForbiddenDomainError("cannot read another user's quota");
    }
    const provider =
      typeof (query as { provider?: unknown })?.provider === "string"
        ? ((query as { provider: string }).provider ?? "minimax")
        : "minimax";
    return okResponse(await this.userQuotaService.getCurrentQuota(user_id, provider));
  }

  @Get("projects/:project_id/usage")
  async projectUsage(
    @ActorContextParam() context: ActorContext,
    @Param("project_id") projectIdParam: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    const { project_id } = parseWithSchema(ProjectUsageParamsSchema, {
      project_id: projectIdParam,
    });
    await requireProjectAccess(context, project_id, "read");
    const parsed = parseWithSchema(UsageQuerySchema, {
      ...((query as Record<string, unknown> | null) ?? {}),
      project_id,
    });
    return okResponse(await this.llmCallQueryService.usage(context, parsed));
  }
}
