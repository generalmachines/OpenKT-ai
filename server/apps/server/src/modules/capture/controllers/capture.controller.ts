import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { BearerAuthGuard } from "../../auth/guards/bearer-auth.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import { CaptureService } from "../services/capture.service";

// CapturePromptBody — the body the openkt-cli's capture.py POSTs
// after its Stage-1 regex gate matches. Server runs Stage-2 LLM
// classification + extraction (CaptureService.capture) and either
// saves the resulting memory or returns saved:false with a reason
// for the CLI to log.
const CapturePromptBody = z.object({
  // Hard input ceiling at 8000 chars. The CLI ships a 4000-char
  // cap; this is belt-and-suspenders for any future caller.
  prompt: z.string().min(20).max(8000),
  // project_id accepts UUID or slug — ProjectScopeService.resolveProjectIdOrSlug
  // handles the disambiguation inside the memory write path.
  project_id: z.string().min(1).max(256),
});

@Controller("capture")
@UseGuards(BearerAuthGuard, RateLimitGuard)
@ApiBearerAuth("openkt-bearer")
@ApiTags("Capture")
export class CaptureController {
  constructor(private readonly captureService: CaptureService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Classify+extract a user prompt as a saveable project memory. " +
      "Called by openkt-cli's capture.py (Stage 2). Cheap LLM call (~$0.001) decides " +
      "whether the prompt contains durable context worth saving; if yes, saves it via " +
      "the same memoryCommands.create path that kt_save_memory uses.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["prompt", "project_id"],
      properties: {
        prompt: { type: "string", minLength: 20, maxLength: 8000 },
        project_id: {
          type: "string",
          description: "UUID or slug of the target project",
        },
      },
    },
  })
  // Per-user rate limit so a runaway hook can't burn through LLM
  // budget. Capacity 30 / refill 30-per-hour = roughly one capture
  // every 2 minutes on average, with burst headroom.
  @RateLimit({
    key: "user",
    name: "capture",
    capacity: 30,
    refillPerSec: 30 / 3600,
  })
  async capture(
    @Body() body: unknown,
    @ActorContextParam() actor: ActorContext,
  ) {
    const input = parseWithSchema(CapturePromptBody, body);
    const result = await this.captureService.capture(actor, input);
    return okResponse(result);
  }
}
