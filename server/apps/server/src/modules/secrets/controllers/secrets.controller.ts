import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { SecretsApplicationService } from "../services/secrets-application.service";
import type { ActorContext } from "@openkt/core-context";

const OrgSlugSchema = z.object({ orgSlug: z.string().min(1).max(64) });

@Controller("secrets")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Secrets")
@ApiBearerAuth("supabase-bearer")
export class SecretsController {
  constructor(private readonly secretsApplicationService: SecretsApplicationService) {}

  @Get("orgs/:orgSlug")
  @ApiOperation({ summary: "List secret metadata for an organization" })
  @ApiParam({ name: "orgSlug", schema: { type: "string", maxLength: 64 } })
  async listOrgSecrets(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const input = parseWithSchema(OrgSlugSchema, params);
    return okResponse(await this.secretsApplicationService.listOrgSecrets(context, input.orgSlug));
  }
}
