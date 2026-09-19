import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import { WaitlistService } from "../services/waitlist.service";

const JoinBody = z.object({
  email: z.string().email().max(254),
  source: z.string().max(64).optional(),
  note: z.string().max(2000).optional(),
  use_case: z.string().max(2000).optional(),
  referrer: z.string().max(512).optional(),
});

@Controller("waitlist")
@ApiTags("Waitlist")
export class PublicWaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  // 5 joins per IP per minute. Closed-beta is not a high-volume signup
  // funnel; the cap is mostly to keep a single script from filling the
  // table with garbage emails.
  @RateLimit({ key: "ip", name: "waitlist_join", capacity: 5, refillPerSec: 5 / 60 })
  @ApiOperation({ summary: "Join the closed-beta waitlist" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email" },
        source: { type: "string", example: "landing" },
        note: { type: "string" },
        use_case: { type: "string" },
        referrer: { type: "string" },
      },
    },
  })
  async join(@Body() body: unknown, @Ip() _ip: string) {
    const input = parseWithSchema(JoinBody, body);
    const row = await this.waitlist.join({
      email: input.email,
      source: input.source,
      note: input.note,
      useCase: input.use_case,
      referrer: input.referrer,
    });
    return okResponse({
      id: row.id,
      email: row.email,
      status: row.approvedAt
        ? "approved"
        : row.deniedAt
          ? "denied"
          : "pending",
      requested_at: row.requestedAt,
      // Never leak admin internals (denied_reason, approved_by) here —
      // public surface only sees high-level state.
    });
  }
}
