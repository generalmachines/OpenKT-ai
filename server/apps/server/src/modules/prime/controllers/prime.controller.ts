import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import type { ActorContext } from "@openkt/core-context";

import { PrimeApplicationService } from "../services/prime-application.service";

const PrimeInputSchema = z.object({
  project_id: z.string().min(1).max(256).optional(),
  with_briefing: z.boolean().default(false),
  // with_categorized: when true, response.categorized is populated
  // with top-N memories per kind (decision/anti-pattern/incident/
  // pattern/context). See PrimeApplicationService for the shape.
  // Default false for backward compat with CLI builds ≤ v0.1.21.
  with_categorized: z.boolean().default(false),
});

@Controller("prime")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Prime")
@ApiBearerAuth("supabase-bearer")
export class PrimeController {
  constructor(private readonly primeApplicationService: PrimeApplicationService) {}

  @Post()
  @ApiOperation({ summary: "Compose the session-start prime payload for a project" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        project_id: { type: "string", maxLength: 256 },
        with_briefing: { type: "boolean", default: false },
        with_categorized: { type: "boolean", default: false },
      },
    },
  })
  async prime(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(PrimeInputSchema, body);
    return okResponse(await this.primeApplicationService.prime(context, input));
  }
}
