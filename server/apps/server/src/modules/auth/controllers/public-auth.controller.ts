import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";
import { resolveSupabaseEnvironment } from "@openkt/data-supabase";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../guards/supabase-jwt.guard";
import {
  AuthApplicationService,
  type AuthRequestMeta,
} from "../services/auth-application.service";
import { DeviceCodeService } from "../services/device-code.service";

function metaFromRequest(req: RequestWithContext): AuthRequestMeta {
  const rm = req.requestMetadata;
  return {
    ip: rm?.ip ?? null,
    userAgent: rm?.userAgent ?? null,
    requestId:
      rm?.requestId ?? (req.headers["x-request-id"] as string | undefined) ?? "-",
  };
}

// /v1/auth/* — the public auth surface every client (CLI, dashboard,
// future harnesses) talks to. Thin wrappers over Supabase Auth so the
// CLI never sees a Supabase URL. Keeps Supabase as the identity engine
// and Nest as the trust gate / contract owner.
//
// Audit: every endpoint stamps an `audit_log` row via
// AuthApplicationService.writeAudit. Anonymous events (failed logins,
// magic-link requests) get actorKind=system to avoid leaking existence.

const EmailSchema = z.string().email().max(254);
const PasswordSchema = z.string().min(8).max(256);

const PasswordLoginBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

const SignupBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

// Magic link accepts the legacy `next` field as a hint that's
// currently ignored on the server side — Supabase's OTP redirect is
// project-config-driven. Kept on the contract so older CLI builds
// don't 400 on an unknown field.
const MagicLinkBody = z.object({
  email: EmailSchema,
  next: z.string().max(2048).optional(),
});

const RefreshBody = z.object({
  refresh_token: z.string().min(1).max(8192),
});

// Device-code is constrained to the same alphabet the issuer uses
// (32 chars, no 0/O/1/I/l) so a CLI typo gets rejected before we
// hit the DB.
const DeviceCodeParam = z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/);
const DeviceConfirmBody = z.object({
  code: DeviceCodeParam,
  // Optional so older dashboard builds (pre refresh_token plumbing)
  // can still confirm — they just won't get a refresh path on the CLI
  // side. Newer builds pass the refresh_token from the user's session
  // so the CLI can persist it and auto-refresh on 401.
  refresh_token: z.string().min(1).max(8192).optional(),
});

// GitHub OAuth start helper accepts an optional redirect_to that Supabase
// will append to the authorize URL. Constrained to absolute HTTPS URLs
// (or http://localhost for dev) to avoid being used as an open redirect.
const GithubStartQuery = z
  .object({
    redirect_to: z
      .string()
      .max(2048)
      .url()
      .refine(
        (value) =>
          value.startsWith("https://") ||
          value.startsWith("http://localhost") ||
          value.startsWith("http://127.0.0.1"),
        { message: "redirect_to must be https:// or http://localhost" },
      )
      .optional(),
  })
  .transform((value) => ({ redirectTo: value.redirect_to }));

@Controller("auth")
@UseGuards(RateLimitGuard)
@ApiTags("Auth")
export class PublicAuthController {
  constructor(
    private readonly authApplicationService: AuthApplicationService,
    private readonly deviceCodeService: DeviceCodeService,
    private readonly configService: ConfigService,
  ) {}

  @Post("password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Email + password login. Returns access token + refresh token.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 8 },
      },
    },
  })
  // Rate limit tuned 2026-05-16 after public-launch user reports of 429s
  // during normal use. Old value (capacity 10, refill 10/min ≈ 1 per 6s)
  // was too aggressive: 2-3 password retries + a single dashboard auto-
  // refresh would blow the bucket. New value: 60 capacity, 1/sec refill.
  // Still rejects brute-force (sustained >60/min ⇒ 429) but a real user
  // typing the wrong password three times never hits it.
  @RateLimit({ key: "ip", name: "auth_signin", capacity: 60, refillPerSec: 1 })
  async password(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(PasswordLoginBody, body);
    return okResponse(
      await this.authApplicationService.passwordLogin(
        input.email,
        input.password,
        metaFromRequest(req),
      ),
    );
  }

  @Post("signup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Sign up with email + password. Returns a session if the project doesn't " +
      "require confirmation; otherwise an empty session — caller should prompt the user " +
      "to check their inbox.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 8 },
      },
    },
  })
  // Rate limit (matching auth_signin policy): 60/burst, 1/sec refill.
  // Same rationale — public launch + accidental dashboard double-submit
  // shouldn't lock a real signer-upper out.
  @RateLimit({ key: "ip", name: "auth_signup", capacity: 60, refillPerSec: 1 })
  async signup(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(SignupBody, body);
    return okResponse(
      await this.authApplicationService.signup(
        input.email,
        input.password,
        metaFromRequest(req),
      ),
    );
  }

  @Post("magic-link")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Send a passwordless magic-link email. Always returns 200 to avoid revealing " +
      "whether the email exists. Idempotent.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email" },
        next: { type: "string", description: "Currently ignored — Supabase project config decides redirect" },
      },
    },
  })
  async magicLink(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(MagicLinkBody, body);
    await this.authApplicationService.sendMagicLink(
      input.email,
      metaFromRequest(req),
    );
    return okResponse({ sent: true });
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Trade a refresh token for a fresh access token.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["refresh_token"],
      properties: { refresh_token: { type: "string" } },
    },
  })
  async refresh(@Body() body: unknown, @Req() req: RequestWithContext) {
    const input = parseWithSchema(RefreshBody, body);
    return okResponse(
      await this.authApplicationService.refresh(
        input.refresh_token,
        metaFromRequest(req),
      ),
    );
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Revoke the caller's refresh token. The access token stays valid until expiry " +
      "(Supabase contract); clients should also clear local state.",
  })
  async logout(
    @Headers("authorization") authorization: string | undefined,
    @Req() req: RequestWithContext,
  ) {
    const bearer = (authorization ?? "").toLowerCase().startsWith("bearer ")
      ? (authorization ?? "").slice(7).trim()
      : "";
    if (!bearer) {
      throw new UnauthorizedException("authorization bearer token required");
    }
    await this.authApplicationService.logout(bearer, metaFromRequest(req));
    return okResponse({ revoked: true });
  }

  // ── Device-code (browser) login flow ────────────────────────────
  // CLI calls POST /v1/auth/device-code, prints a short code + dashboard
  // URL, and polls GET /v1/auth/device-code/{code}/status. Dashboard's
  // /signin/device page POSTs /v1/auth/device-confirm once the user pastes
  // the code while signed in.

  @Post("device-code")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Start a browser-based device-code login. Returns a short human-typeable " +
      "code, a dashboard URL to paste it into, and an absolute expiry (epoch s).",
  })
  async deviceCode() {
    return okResponse(await this.deviceCodeService.start());
  }

  @Get("device-code/:code/status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Poll a device-code's status. Returns {status: 'pending'|'approved'|'expired'} " +
      "and includes a token when approved. Single-use: the first poll that sees " +
      "'approved' consumes the code.",
  })
  async deviceCodeStatus(@Param("code") code: string) {
    const parsed = parseWithSchema(DeviceCodeParam, code);
    return okResponse(await this.deviceCodeService.pollStatus(parsed));
  }

  @Post("device-confirm")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseJwtGuard)
  @ApiBearerAuth("supabase-bearer")
  @ApiOperation({
    summary:
      "Confirm a device-code as the signed-in dashboard user. Binds the caller's " +
      "session to the code so the polling CLI can pick up a token. Single-use.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string", minLength: 10, maxLength: 10 },
        refresh_token: {
          type: "string",
          description:
            "Caller's Supabase refresh_token. Optional for backward compat, but " +
            "the CLI needs it to avoid forcing re-login every hour.",
        },
      },
    },
  })
  async deviceConfirm(
    @Body() body: unknown,
    @ActorContextParam() actorContext: ActorContext,
    @Headers("authorization") authorization: string | undefined,
  ) {
    const input = parseWithSchema(DeviceConfirmBody, body);
    const userId = actorContext.principal.userId;
    if (!userId) {
      // SupabaseJwtGuard already 401s for non-user principals, but keep
      // the type-narrowing explicit so downstream callers can rely on it.
      throw new UnauthorizedException("user principal required");
    }
    const bearer = (authorization ?? "").toLowerCase().startsWith("bearer ")
      ? (authorization ?? "").slice(7).trim()
      : "";
    await this.deviceCodeService.confirm(
      userId,
      bearer,
      input.code,
      input.refresh_token,
    );
    return okResponse({ confirmed: true });
  }

  // ── GitHub OAuth start helper ────────────────────────────────────
  // Returns the Supabase authorize URL the client should redirect / open
  // in a browser. We don't perform the OAuth dance server-side — Supabase
  // owns the callback at https://<project>.supabase.co/auth/v1/callback.
  // The CLI flow uses this with `redirect_to=http://localhost:<port>/...`
  // so a local listener can pick up the resulting access token. The
  // dashboard flow uses it with `redirect_to=https://app.openkt.ai/auth/
  // callback`.
  //
  // No JWT required — the response is just a URL the client constructs
  // anyway. Centralising it here means the Supabase project URL stays in
  // one place (here, sourced from SUPABASE_URL config).

  @Get("github/start")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Return the Supabase GitHub authorize URL the client should open. " +
      "No server-side OAuth dance — Supabase handles the callback.",
  })
  @ApiQuery({
    name: "redirect_to",
    required: false,
    description:
      "Where Supabase should redirect after the OAuth dance completes. " +
      "Must be https:// or http://localhost.",
  })
  githubStart(@Query() query: unknown) {
    const { redirectTo } = parseWithSchema(GithubStartQuery, query ?? {});
    const environment = resolveSupabaseEnvironment(this.configService);
    const base = environment.url.replace(/\/+$/, "");

    const params = new URLSearchParams({ provider: "github" });
    if (redirectTo) {
      params.set("redirect_to", redirectTo);
    }
    const authorizeUrl = `${base}/auth/v1/authorize?${params.toString()}`;

    return okResponse({ authorize_url: authorizeUrl });
  }
}
