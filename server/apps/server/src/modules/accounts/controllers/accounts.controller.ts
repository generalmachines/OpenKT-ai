import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { mapRequestMetadata } from "@openkt/auth-principal";
import type { ActorContext, RequestMetadata } from "@openkt/core-context";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { BearerAuthGuard } from "../../auth/guards/bearer-auth.guard";
import { AccountsService } from "../services/accounts.service";
import { MAX_PASSWORD_LENGTH } from "../services/password-policy";

// /v1/auth/* — built-in accounts. Public routes (signup, login, google,
// providers) need no token; logout and password take the session token the
// sign-in returned. Brute-force limits live in LoginAttemptsService.

const Email = z.string().trim().toLowerCase().email().max(254);
const Client = z.enum(["desktop", "web", "cli"]).default("desktop");

const SignupBody = z.object({
  email: Email,
  // Strength is judged by the password policy (so the error can say why); the
  // schema only bounds the size.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  display_name: z.string().trim().min(1).max(120),
  client: Client,
});

const LoginBody = z.object({
  email: Email,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  client: Client,
});

const GoogleBody = z.object({
  id_token: z.string().min(1).max(8192),
  client: Client,
});

const ChangePasswordBody = z.object({
  current_password: z.string().min(1).max(MAX_PASSWORD_LENGTH).nullish(),
  new_password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

function metadataOf(req: RequestWithContext): RequestMetadata {
  return req.requestMetadata ?? mapRequestMetadata(req);
}

@Controller("auth")
@ApiTags("Auth")
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get("providers")
  @ApiOperation({ summary: "Which sign-in methods this server offers, so a client knows what to show." })
  providers() {
    return okResponse(this.accounts.providers());
  }

  @Post("signup")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Create an account with email + password. Returns a session (an access token valid 90 days). " +
      "409 `email_taken` when the email already has an account; 400 `weak_password` with the reason.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["email", "password", "display_name"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 10 },
        display_name: { type: "string", maxLength: 120 },
        client: { type: "string", enum: ["desktop", "web", "cli"], default: "desktop" },
      },
    },
  })
  async signup(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(SignupBody, body);
    return okResponse(
      await this.accounts.signup(
        { email: input.email, password: input.password, displayName: input.display_name, client: input.client },
        metadataOf(req),
      ),
    );
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Sign in with email + password. 401 `invalid_credentials` for every failure, whatever the reason.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" },
        client: { type: "string", enum: ["desktop", "web", "cli"], default: "desktop" },
      },
    },
  })
  async login(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(LoginBody, body);
    return okResponse(await this.accounts.login(input, metadataOf(req)));
  }

  @Post("google")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Sign in (or sign up) with a Google ID token. 404 `provider_disabled` unless OPENKT_GOOGLE_CLIENT_IDS is set.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["id_token"],
      properties: {
        id_token: { type: "string" },
        client: { type: "string", enum: ["desktop", "web", "cli"], default: "desktop" },
      },
    },
  })
  async google(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(GoogleBody, body);
    return okResponse(
      await this.accounts.googleSignIn({ idToken: input.id_token, client: input.client }, metadataOf(req)),
    );
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BearerAuthGuard)
  @ApiBearerAuth("supabase-bearer")
  @ApiOperation({ summary: "Sign out: revokes the token this request was made with." })
  async logout(@ActorContextParam() context: ActorContext): Promise<void> {
    await this.accounts.logout(context);
  }

  @Post("password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BearerAuthGuard)
  @ApiBearerAuth("supabase-bearer")
  @ApiOperation({
    summary:
      "Change the password. Signs out every other session of this account. `current_password` may be " +
      "omitted only by an account that has no password yet (created through Google).",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["new_password"],
      properties: { current_password: { type: "string" }, new_password: { type: "string", minLength: 10 } },
    },
  })
  async changePassword(@ActorContextParam() context: ActorContext, @Body() body: unknown): Promise<void> {
    const input = parseWithSchema(ChangePasswordBody, body);
    await this.accounts.changePassword(context, {
      currentPassword: input.current_password ?? null,
      newPassword: input.new_password,
    });
  }
}
