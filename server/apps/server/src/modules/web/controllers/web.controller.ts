import { Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { z } from "zod";

import { buildUserPrincipal, mapRequestMetadata } from "@openkt/auth-principal";
import type { ActorContext } from "@openkt/core-context";
import { DomainError } from "@openkt/core-errors";

import { AccountsService, type SignedInUser } from "../../accounts/services/accounts.service";
import { MAX_PASSWORD_LENGTH } from "../../accounts/services/password-policy";
import { ActorContextFactory } from "../../auth/services/actor-context.factory";
import { accountErrorMessage } from "../../oauth/controllers/authorize.controller";
import { esc } from "../../oauth/views/sign-in-page";
import { PersonalTokensService } from "../../personal-tokens/services/personal-tokens.service";
import { TeamsService } from "../../teams/services/teams.service";
import {
  connectPage,
  connectSignInPage,
  joinMissingPage,
  joinPage,
  TOKEN_TOOLS,
  type Page,
  type TokenTool,
} from "../views/pages";
import { WebSessionService, type WebUser } from "../services/web-session.service";

// Zero-install pages on the API host, for people who never install the app:
//
//   GET  /                         → 302 /connect
//   GET  /join/<code>              "<inviter> invited you to <team>" + sign up / sign in
//   POST /join/<code>              signs in or up, joins the team, → 303 /connect
//   GET  /connect                  sign-in form, or (signed in) how to connect every tool
//   POST /connect/signin           sign in / sign up → 303 /connect
//   POST /connect/signout
//   POST /connect/token            a fresh access token `connect:<tool>`, shown once
//   POST /connect/teams            create a team (space + editor join link)
//   POST /connect/teams/:id/links  another join link for a team, shown on the page
//
// Sign-in goes through AccountsService (same passwords, limits and errors as
// /v1/auth/*); joining goes through TeamsService (an ordinary grant). Every
// POST is CSRF-checked (WebSessionService). Excluded from the /v1 prefix in main.ts.

const TOKEN_DAYS = 90;

const AccountForm = z.object({
  csrf: z.string().max(200).optional(),
  mode: z.enum(["signin", "signup", "session"]).default("signin"),
  email: z.string().max(400).optional(),
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  display_name: z.string().max(120).optional(),
});
const Email = z.string().trim().toLowerCase().email().max(254);
const CsrfOnly = z.object({ csrf: z.string().max(200).optional() });
const TokenForm = CsrfOnly.extend({ tool: z.enum(TOKEN_TOOLS).default("other") });
const TeamForm = CsrfOnly.extend({ name: z.string().max(200).default("") });
const UuidParam = z.object({ id: z.string().uuid() });

const EXPIRED = "This page expired or was opened in another tab. Try again.";

@Controller()
@ApiExcludeController()
export class WebController {
  constructor(
    private readonly session: WebSessionService,
    private readonly accounts: AccountsService,
    private readonly teams: TeamsService,
    private readonly tokens: PersonalTokensService,
    private readonly actorContextFactory: ActorContextFactory,
  ) {}

  @Get()
  root(@Res() res: Response): void {
    res.redirect(302, "/connect");
  }

  // ── /join/<code> ───────────────────────────────────────────────────

  @Get("join/:code")
  async joinForm(@Param("code") code: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.renderJoin(req, res, code, { mode: "signup" });
  }

  @Post("join/:code")
  async join(@Param("code") code: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const form = AccountForm.safeParse(body ?? {});
    if (!form.success) return this.renderJoin(req, res, code, { mode: "signup", error: "Something in the form was not valid." });
    const input = form.data;
    const keep = { mode: input.mode === "signin" ? "signin" : "signup", email: input.email?.trim(), displayName: input.display_name?.trim() } as const;
    if (!this.session.csrfOk(req, input.csrf)) return this.renderJoin(req, res, code, { ...keep, error: EXPIRED });

    let user: { userId: string } | null = null;
    if (input.mode === "session") {
      user = await this.session.current(req);
      if (!user) return this.renderJoin(req, res, code, { mode: "signin", error: "Your session ended. Sign in again." });
    } else {
      const signedIn = await this.signInOrUp(req, input);
      if ("error" in signedIn) return this.renderJoin(req, res, code, { ...keep, error: signedIn.error }, signedIn.status);
      user = signedIn;
    }

    try {
      const joined = await this.teams.join(this.contextFor(req, user.userId), code);
      if (input.mode !== "session") await this.session.start(req, res, user.userId);
      res.redirect(303, `/connect?joined=${encodeURIComponent(joined.space.id)}`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      // The link ran out while they were signing up: they have an account now.
      if (input.mode !== "session") await this.session.start(req, res, user.userId);
      send(res, joinMissingPage());
    }
  }

  // ── /connect ──────────────────────────────────────────────────────

  @Get("connect")
  async connect(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.session.current(req);
    if (!user) return send(res, connectSignInPage({ csrf: this.session.csrfToken(req, res), mode: "signin" }));
    await this.renderConnect(req, res, user, { notice: await this.noticeFor(req, user, query) });
  }

  @Post("connect/signin")
  async signIn(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const form = AccountForm.safeParse(body ?? {});
    const csrf = this.session.csrfToken(req, res);
    if (!form.success) return send(res, connectSignInPage({ csrf, mode: "signin", error: "Something in the form was not valid." }));
    const input = form.data;
    const keep = { csrf, mode: input.mode === "signup" ? "signup" : "signin", email: input.email?.trim(), displayName: input.display_name?.trim() } as const;
    if (!this.session.csrfOk(req, input.csrf)) return send(res, connectSignInPage({ ...keep, error: EXPIRED }));
    const signedIn = await this.signInOrUp(req, input);
    if ("error" in signedIn) return send(res, { ...connectSignInPage({ ...keep, error: signedIn.error }), status: signedIn.status });
    await this.session.start(req, res, signedIn.userId);
    res.redirect(303, "/connect");
  }

  @Post("connect/signout")
  async signOut(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const form = CsrfOnly.safeParse(body ?? {});
    if (form.success && this.session.csrfOk(req, form.data.csrf)) await this.session.end(req, res);
    res.redirect(303, "/connect");
  }

  @Post("connect/token")
  async createToken(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.session.current(req);
    if (!user) return res.redirect(303, "/connect");
    const form = TokenForm.safeParse(body ?? {});
    if (!form.success || !this.session.csrfOk(req, form.data.csrf)) {
      return this.renderConnect(req, res, user, { error: EXPIRED, status: 400 });
    }
    const tool: TokenTool = form.data.tool;
    const issued = await this.tokens.create({
      userId: user.userId,
      name: `connect:${tool}`,
      scopes: ["read", "write"],
      expiresAt: new Date(Date.now() + TOKEN_DAYS * 86_400_000),
    });
    await this.renderConnect(req, res, user, { token: { value: issued.rawToken, tool } });
  }

  @Post("connect/teams")
  async createTeam(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.session.current(req);
    if (!user) return res.redirect(303, "/connect");
    const form = TeamForm.safeParse(body ?? {});
    if (!form.success || !this.session.csrfOk(req, form.data.csrf)) {
      return this.renderConnect(req, res, user, { error: EXPIRED, status: 400 });
    }
    const name = form.data.name.trim();
    if (!name || name.length > 120) {
      return this.renderConnect(req, res, user, { error: "Give the team a name (up to 120 characters).", status: 400 });
    }
    const created = await this.teams.createTeam(this.contextFor(req, user.userId), name);
    res.redirect(303, `/connect?created=${encodeURIComponent(created.space.id)}`);
  }

  @Post("connect/teams/:id/links")
  async newLink(@Param() params: unknown, @Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const user = await this.session.current(req);
    if (!user) return res.redirect(303, "/connect");
    const id = UuidParam.safeParse(params);
    const form = CsrfOnly.safeParse(body ?? {});
    if (!id.success || !form.success || !this.session.csrfOk(req, form.data.csrf)) {
      return this.renderConnect(req, res, user, { error: EXPIRED, status: 400 });
    }
    try {
      const link = await this.teams.createLink(this.contextFor(req, user.userId), id.data.id, { role: "editor" });
      await this.renderConnect(req, res, user, {
        notice: `New invite link — send it to whoever should join: <code>${esc(link.url)}</code>`,
      });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      await this.renderConnect(req, res, user, { error: "You cannot make invite links for that team.", status: 403 });
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private async renderJoin(
    req: Request,
    res: Response,
    code: string,
    view: { mode: "signin" | "signup"; email?: string; displayName?: string; error?: string },
    status?: number,
  ): Promise<void> {
    let preview;
    try {
      preview = await this.teams.preview(code);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      return send(res, joinMissingPage());
    }
    const user = await this.session.current(req);
    const page = joinPage({
      ...view,
      code,
      preview,
      csrf: this.session.csrfToken(req, res),
      signedInAs: user ? { name: user.displayName || user.email, email: user.email } : null,
    });
    send(res, { ...page, status: status ?? (view.error ? 400 : 200) });
  }

  private async renderConnect(
    req: Request,
    res: Response,
    user: WebUser,
    extra: { token?: { value: string; tool: TokenTool }; notice?: string; error?: string; status?: number },
  ): Promise<void> {
    const teams = await this.teams.listTeams(this.contextFor(req, user.userId));
    send(
      res,
      connectPage({
        csrf: this.session.csrfToken(req, res),
        user: { name: user.displayName || user.email, email: user.email },
        mcpUrl: this.teams.mcpUrl(),
        teams,
        ...extra,
      }),
    );
  }

  // HTML (escaped here) for the banner after a redirect back to /connect.
  private async noticeFor(req: Request, user: WebUser, query: Record<string, unknown>): Promise<string | undefined> {
    const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : undefined);
    const joined = pick("joined");
    const created = pick("created");
    if (!joined && !created) return undefined;
    const teams = await this.teams.listTeams(this.contextFor(req, user.userId));
    if (joined) {
      const team = teams.find((t) => t.id === joined);
      if (team) return `You joined <strong>${esc(team.name)}</strong> as ${esc(team.role)}. Connect a tool below, then ask it about the team.`;
    }
    if (created) {
      const team = teams.find((t) => t.id === created);
      const link = team?.links?.[0];
      if (team && link) {
        return `Created <strong>${esc(team.name)}</strong>. Send this link to your team: <code>${esc(link.url)}</code>`;
      }
    }
    return undefined;
  }

  private async signInOrUp(
    req: Request,
    input: z.infer<typeof AccountForm>,
  ): Promise<SignedInUser | { error: string; status: number }> {
    const email = Email.safeParse(input.email ?? "");
    if (!email.success) return { error: "Enter a valid email address.", status: 400 };
    if (!input.password) return { error: "Enter your password.", status: 400 };
    const meta = mapRequestMetadata(req);
    try {
      if (input.mode === "signup") {
        const displayName = input.display_name?.trim() ?? "";
        if (!displayName) return { error: "Enter your name.", status: 400 };
        return await this.accounts.registerWithPassword({ email: email.data, password: input.password, displayName }, meta);
      }
      return await this.accounts.authenticateWithPassword({ email: email.data, password: input.password }, meta);
    } catch (err) {
      const known = accountErrorMessage(err);
      if (!known) throw err;
      return { error: known.text, status: known.status };
    }
  }

  private contextFor(req: Request, userId: string): ActorContext {
    return this.actorContextFactory.createUserContext({
      principal: buildUserPrincipal({ userId, email: null, displayName: null, oauthIdentity: null }, "mcp-token"),
      request: mapRequestMetadata(req),
      jwt: null,
    });
  }
}

function send(res: Response, page: Page): void {
  res.status(page.status);
  for (const [k, v] of Object.entries(page.headers)) res.setHeader(k, v);
  res.send(page.html);
}
