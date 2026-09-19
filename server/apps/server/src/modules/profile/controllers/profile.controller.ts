import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
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
import { ProfileApplicationService } from "../services/profile-application.service";
import type { ActorContext } from "@openkt/core-context";

// Wire body keys are snake_case per the v1 contract. The application
// service still works with camelCase internally (idiomatic TS); the
// body decorator + global response interceptor do the boundary
// translation.
//
// PATCH only accepts user-editable fields. `email`, `github_username`,
// `github_id`, `auth_provider`, `avatar_url-from-oauth` all flow from the
// Supabase JWT and are owned by the auth provider, not the user.
const UpdateProfileSchema = z
  .object({
    display_name: z.string().min(1).max(120).nullable().optional(),
    avatar_url: z.string().url().nullable().optional(),
    bio: z.string().max(2000).nullable().optional(),
  })
  .transform((value) => ({
    displayName: value.display_name,
    avatarUrl: value.avatar_url,
    bio: value.bio,
  }));

// Two controllers in one file — the existing `/v1/me` surface (kept for
// back-compat with the dashboard / CLI builds shipping today) and the
// canonical `/v1/profile/me` surface introduced for the GitHub OAuth
// wiring. Both delegate to the same application service so the lazy-
// create / upgrade behaviour is identical regardless of which path the
// client uses. The new path is the one we'll document going forward.

@Controller("me")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Me")
@ApiBearerAuth("supabase-bearer")
export class ProfileController {
  constructor(private readonly profileApplicationService: ProfileApplicationService) {}

  @Get()
  @ApiOperation({ summary: "Get the current user's profile (legacy alias)" })
  async getMe(@ActorContextParam() context: ActorContext) {
    return okResponse(await this.profileApplicationService.getMe(context));
  }

  @Patch()
  @ApiOperation({ summary: "Update the current user's profile (legacy alias)" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        display_name: { type: "string", minLength: 1, maxLength: 120, nullable: true },
        avatar_url: { type: "string", format: "uri", nullable: true },
        bio: { type: "string", maxLength: 2000, nullable: true },
      },
    },
  })
  async updateMe(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(UpdateProfileSchema, body);
    return okResponse(await this.profileApplicationService.updateMe(context, input));
  }
}

@Controller("profile/me")
@UseGuards(SupabaseJwtGuard)
@ApiTags("Profile")
@ApiBearerAuth("supabase-bearer")
export class ProfileMeController {
  constructor(private readonly profileApplicationService: ProfileApplicationService) {}

  @Get()
  @ApiOperation({
    summary:
      "Get the current user's profile. Lazy-creates the row on first " +
      "authenticated request and backfills GitHub fields when a user signed " +
      "up with email later authenticates via GitHub.",
  })
  async getMe(@ActorContextParam() context: ActorContext) {
    return okResponse(await this.profileApplicationService.getMe(context));
  }

  @Patch()
  @ApiOperation({
    summary:
      "Update display_name / avatar_url / bio on the current user's profile. " +
      "Email, github_username and auth_provider flow from the auth provider " +
      "and cannot be set here.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        display_name: { type: "string", minLength: 1, maxLength: 120, nullable: true },
        avatar_url: { type: "string", format: "uri", nullable: true },
        bio: { type: "string", maxLength: 2000, nullable: true },
      },
    },
  })
  async updateMe(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(UpdateProfileSchema, body);
    return okResponse(await this.profileApplicationService.updateMe(context, input));
  }
}
