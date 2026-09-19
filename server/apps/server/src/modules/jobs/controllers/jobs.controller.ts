import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import type { ActorContext } from "@openkt/core-context";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import { ClaimJobSchema, CompleteJobSchema, FailJobSchema, JobIdParamsSchema, LookupSchema } from "../contracts/job.contract";
import { JobsApplicationService } from "../services/jobs-application.service";

// The job protocol for members' Macs (the on-device worker). See contracts/job.contract.ts.
@Controller("jobs")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
@ApiTags("Jobs")
@ApiBearerAuth("supabase-bearer")
export class JobsController {
  constructor(private readonly jobs: JobsApplicationService) {}

  @Post("claim")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Claim the next background job in a space where you are an editor or owner (5-minute lease)" })
  @RateLimit({ key: "user", name: "jobs_claim", capacity: 120, refillPerSec: 2 })
  async claim(@ActorContextParam() context: ActorContext, @Body() body: unknown) {
    return okResponse(await this.jobs.claim(context, parseWithSchema(ClaimJobSchema, body ?? {})));
  }

  @Post(":id/lookup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Nearest facts and candidate pages for a claimed job; extends the lease" })
  @RateLimit({ key: "user", name: "jobs_lookup", capacity: 120, refillPerSec: 2 })
  async lookup(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(JobIdParamsSchema, params);
    return okResponse(await this.jobs.lookup(context, id, parseWithSchema(LookupSchema, body ?? {})));
  }

  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Post a claimed job's result; the server re-validates and applies it" })
  @RateLimit({ key: "user", name: "jobs_complete", capacity: 60, refillPerSec: 1 })
  async complete(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(JobIdParamsSchema, params);
    const { result } = parseWithSchema(CompleteJobSchema, body ?? {});
    return okResponse(await this.jobs.complete(context, id, result));
  }

  @Post(":id/fail")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Give a claimed job back: queued again with back-off, or failed after the sixth attempt" })
  @RateLimit({ key: "user", name: "jobs_fail", capacity: 60, refillPerSec: 1 })
  async fail(@ActorContextParam() context: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWithSchema(JobIdParamsSchema, params);
    return okResponse(await this.jobs.fail(context, id, parseWithSchema(FailJobSchema, body ?? {})));
  }
}
