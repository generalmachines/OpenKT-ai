import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CSS as BASE_CSS, esc } from "../../oauth/views/sign-in-page";
import type { JoinLinkView, JoinPreview } from "../../teams/contracts/join-link.contract";
import type { TeamView } from "../../teams/services/teams.service";

// The zero-install pages on the API host: /join/<code> and /connect. Plain
// HTML with one inline <style> and one tiny inline <script> (copy buttons),
// both allowed by a per-response nonce. The look is the OAuth sign-in page's
// (same stylesheet), with one terracotta accent. Everything that comes from a
// person or the database is escaped.

export interface Page {
  status: number;
  html: string;
  headers: Record<string, string>;
}

export const DESKTOP_DMG_URL =
  "https://openkt-downloads-724772068721.s3.ap-south-1.amazonaws.com/desktop/OpenKT-latest-arm64.dmg";
export const UNBLOCK_COMMAND = "xattr -dr com.apple.quarantine /Applications/OpenKT.app";
export const FULL_SETUP_PROMPT_URL = "https://github.com/masti-ai/OpenKT-ai/blob/main/plugin/SETUP-PROMPT.md";
export const TOKEN_TOOLS = ["claude-code", "codex", "cursor", "other"] as const;
export type TokenTool = (typeof TOKEN_TOOLS)[number];
const TOOL_LABEL: Record<TokenTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  other: "another tool",
};

type Mode = "signin" | "signup";

interface FormFields {
  csrf: string;
  mode: Mode;
  email?: string;
  displayName?: string;
  error?: string;
}

// ── /join/<code> ─────────────────────────────────────────────────────

export function joinPage(input: FormFields & {
  code: string;
  preview: JoinPreview;
  signedInAs: { name: string; email: string } | null;
}): Page {
  const { preview } = input;
  const can = preview.role === "reader" ? "read" : "read and add to";
  const action = `/join/${encodeURIComponent(input.code)}`;
  const asYou = input.signedInAs
    ? `
  <form method="post" action="${esc(action)}" class="as-you">
    ${hidden({ csrf: input.csrf, mode: "session" })}
    <button type="submit" class="primary wide">Join as ${esc(input.signedInAs.name)}</button>
    <p class="hint">Signed in as ${esc(input.signedInAs.email)}. Or use another account below.</p>
  </form>`
    : "";
  const body = `
<main class="card">
  <p class="brand">OpenKT</p>
  <h1>${esc(preview.inviter_name)} invited you to <span class="accent">${esc(preview.space_name)}</span> on OpenKT</h1>
  <p class="lede">OpenKT is your team's shared context. Join to ${can} what the team knows from Claude, ChatGPT, Codex or Cursor — no install needed.</p>
  ${errorBlock(input.error)}
  ${asYou}
  ${accountForm({ ...input, action, submitLabel: `Join ${preview.space_name}`, defaultMode: "signup" })}
  <p class="fine">You join as ${preview.role === "reader" ? "a reader: you can recall the team's context" : "an editor: you can recall and save the team's context"}. Next you'll see how to connect your AI tools.</p>
</main>`;
  return page(200, `Join ${preview.space_name} on OpenKT`, body);
}

export function joinMissingPage(): Page {
  const body = `
<main class="card">
  <p class="brand">OpenKT</p>
  <h1>This invite link does not work</h1>
  <p class="lede">It may have expired, been used up, or been deleted. Ask the person who sent it for a new one.</p>
  <p class="fine"><a href="/connect.html">Go to OpenKT</a></p>
</main>`;
  return page(404, "Invite link not found — OpenKT", body);
}

// ── /connect, signed out ─────────────────────────────────────────────

export function connectSignInPage(input: FormFields & { mcpUrl?: string }): Page {
  const body = `
<main class="card">
  <p class="brand">OpenKT</p>
  <h1>Connect your AI tools to OpenKT</h1>
  <p class="lede">Add this MCP server to your AI tool: <code>${esc(input.mcpUrl ?? "https://mcp.openkt.ai/mcp")}</code> — it signs you in by itself. Sign in here to create or share a team, or to get an access token for tools without browser sign-in.</p>
  ${errorBlock(input.error)}
  ${accountForm({ ...input, action: "/connect/signin", submitLabel: "Continue", defaultMode: "signin" })}
</main>`;
  return page(input.error ? 400 : 200, "Connect to OpenKT", body);
}

// ── /connect, signed in ──────────────────────────────────────────────

export interface ConnectPageInput {
  csrf: string;
  user: { name: string; email: string };
  mcpUrl: string;
  teams: TeamView[];
  // A token created by this very request — shown once.
  token?: { value: string; tool: TokenTool };
  notice?: string;
  error?: string;
  status?: number;
}

export function connectPage(input: ConnectPageInput): Page {
  const token = input.token?.value ?? "<token>";
  const has = Boolean(input.token);
  const bearer = `Authorization: Bearer ${token}`;
  const claudeCode = `claude mcp add --transport http openkt ${input.mcpUrl} --header "${bearer}"`;
  const codex = `[mcp_servers.openkt]\nurl = "${input.mcpUrl}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`;
  const cursor = JSON.stringify(
    { mcpServers: { openkt: { url: input.mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );

  const tokenBlock = input.token
    ? `
    <div class="notice" role="status">
      <p><strong>Your new access token for ${esc(TOOL_LABEL[input.token.tool])}.</strong> Copy it now — it is not shown again. It is already filled into the steps below.</p>
      ${codeBlock("token", input.token.value)}
    </div>`
    : `
    <form method="post" action="/connect/token" class="row">
      ${hidden({ csrf: input.csrf })}
      <label class="sr" for="tool">For</label>
      <select id="tool" name="tool">
        ${TOKEN_TOOLS.map((t) => `<option value="${t}">${esc(TOOL_LABEL[t])}</option>`).join("")}
      </select>
      <button type="submit" class="primary">Create a new access token</button>
    </form>
    <p class="hint">Claude Code, Codex and Cursor sign in with a token. Claude and ChatGPT do not need one: they sign you in on an OpenKT page.</p>`;

  const body = `
<main class="card wide">
  <div class="top">
    <p class="brand">OpenKT</p>
    <form method="post" action="/connect/signout">${hidden({ csrf: input.csrf })}<button type="submit" class="link">Sign out</button></form>
  </div>
  <h1>Connect your AI tools</h1>
  <p class="lede">Signed in as <strong>${esc(input.user.name)}</strong> (${esc(input.user.email)}). Your tools recall and save through one MCP server.</p>
  ${input.notice ? `<div class="notice" role="status"><p>${input.notice}</p></div>` : ""}
  ${errorBlock(input.error)}

  <section>
    <h2>1. The server</h2>
    <p>Add this MCP server: <code>${esc(input.mcpUrl)}</code> — it signs you in by itself.</p>
    ${codeBlock("mcp-url", input.mcpUrl)}
    ${tokenBlock}
  </section>

  <section>
    <h2>2. Add it to your tool</h2>
    <details open>
      <summary>Claude and Cowork</summary>
      <p>Customize → Connectors → <strong>+</strong> → Add custom connector. Name <code>OpenKT</code>, URL <code>${esc(input.mcpUrl)}</code> → Add → Connect, then sign in on the OpenKT page that opens. No token needed.</p>
    </details>
    <details>
      <summary>ChatGPT</summary>
      <p>Settings → Security and login → turn on Developer mode. Then open <code>chatgpt.com/plugins</code> → <strong>+</strong>: name <code>OpenKT</code>, MCP server URL <code>${esc(input.mcpUrl)}</code>, authentication OAuth → Create, and sign in on the OpenKT page. Add OpenKT to a chat from the tools menu. No token needed.</p>
    </details>
    <details${has && input.token?.tool === "claude-code" ? " open" : ""}>
      <summary>Claude Code</summary>
      <p>Run this in a terminal${has ? "" : " (create a token above first)"}:</p>
      ${codeBlock("claude-code", claudeCode)}
    </details>
    <details${has && input.token?.tool === "codex" ? " open" : ""}>
      <summary>Codex</summary>
      <p>Add this to <code>~/.codex/config.toml</code>${has ? "" : " (create a token above first)"}:</p>
      ${codeBlock("codex", codex)}
    </details>
    <details${has && input.token?.tool === "cursor" ? " open" : ""}>
      <summary>Cursor</summary>
      <p>Add this to <code>~/.cursor/mcp.json</code> (merge into <code>mcpServers</code> if the file exists)${has ? "" : " — create a token above first"}:</p>
      ${codeBlock("cursor", cursor)}
    </details>
  </section>

  <section>
    <h2>3. Or let your AI tool do it</h2>
    <p>Paste this into the tool you use and it will set OpenKT up, asking before it changes anything.</p>
    ${codeBlock("prompt", setupPrompt(input.mcpUrl))}
    <p class="hint">Also on GitHub: <a href="${FULL_SETUP_PROMPT_URL}">SETUP-PROMPT.md</a>.</p>
  </section>

  <section>
    <h2>Teams</h2>
    <form method="post" action="/connect/teams" class="row">
      ${hidden({ csrf: input.csrf })}
      <label class="sr" for="team-name">Team name</label>
      <input id="team-name" name="name" type="text" required maxlength="120" placeholder="Team name, e.g. Hackathon crew">
      <button type="submit" class="primary">Create a team</button>
    </form>
    <p class="hint">A team is a shared space. You get a link to send; whoever opens it signs up and joins.</p>
    <h3>Your teams</h3>
    ${teamsList(input.teams, input.csrf)}
  </section>

  <section>
    <h2>The Mac app</h2>
    <p><a href="${DESKTOP_DMG_URL}">Download OpenKT for Mac</a> (Apple silicon). Move it to Applications; if macOS says it cannot be opened, run:</p>
    ${codeBlock("unblock", UNBLOCK_COMMAND)}
  </section>

  <p class="fine">Try it: ask your tool “what does OpenKT know about ${esc(input.teams[0]?.name ?? "my team")}?”</p>
</main>`;
  return page(input.status ?? 200, "Connect to OpenKT", body);
}

function teamsList(teams: TeamView[], csrf: string): string {
  if (teams.length === 0) {
    return `<p class="empty">You are not in any team yet. Create one above, or open a join link someone sent you.</p>`;
  }
  return `<ul class="teams">${teams
    .map(
      (t) => `
    <li class="team" id="team-${esc(t.id)}">
      <div class="team-head"><strong>${esc(t.name)}</strong> <span class="role">${esc(t.role)}</span></div>
      <p class="hint">project_id <code>${esc(t.id)}</code></p>
      ${(t.links ?? []).map((l) => linkRow(l)).join("")}
      ${
        t.role === "reader"
          ? ""
          : `<form method="post" action="/connect/teams/${esc(t.id)}/links">${hidden({ csrf })}<button type="submit" class="secondary small">New invite link</button></form>`
      }
    </li>`,
    )
    .join("")}</ul>`;
}

function linkRow(link: JoinLinkView): string {
  const limits = [
    link.expires_at ? `until ${link.expires_at.slice(0, 10)}` : "no expiry",
    link.max_uses !== null ? `${link.uses} of ${link.max_uses} used` : `${link.uses} joined`,
  ].join(" · ");
  return `<div class="link-row">${codeBlock(`link-${link.code}`, link.url)}<p class="hint">${esc(link.role)} link · ${esc(limits)}</p></div>`;
}

// The paste-in prompt: plugin/SETUP-PROMPT.md (the part below its `---`
// line), which the API image carries; the short version below when the file
// is not there (a bare checkout of server/ only).
let promptFile: string | null | undefined;
function setupPromptFile(): string | null {
  if (promptFile !== undefined) return promptFile;
  const found = [
    process.env.OPENKT_SETUP_PROMPT,
    resolve(process.cwd(), "../plugin/SETUP-PROMPT.md"),
    resolve(process.cwd(), "plugin/SETUP-PROMPT.md"),
    resolve(__dirname, "../../../../../../../plugin/SETUP-PROMPT.md"),
  ].find((p): p is string => Boolean(p) && existsSync(p as string));
  const text = found ? readFileSync(found, "utf8") : "";
  const cut = text.indexOf("\n---\n");
  promptFile = cut >= 0 ? text.slice(cut + 5).trim() || null : null;
  return promptFile;
}

export function setupPrompt(mcpUrl: string): string {
  const file = setupPromptFile();
  if (file) return file.split("https://mcp.openkt.ai/mcp").join(mcpUrl);
  return [
    `Connect OpenKT to this tool for me. OpenKT is my team's shared context: a remote MCP server at ${mcpUrl} (name it "openkt").`,
    "Add it the way this client adds remote (Streamable HTTP) MCP servers. Sign-in happens in my browser through OAuth — never ask me to paste a password or token into this chat. Before you create or edit any file, show me the change and wait for my yes.",
    "Then call kt_list_projects and tell me which spaces I can see. From now on: call kt_recall before non-trivial work, save decisions and facts with kt_save_memory as they happen (in the team's space when it is team context), and call kt_session_end with a short summary when we finish.",
  ].join("\n\n");
}

// ── building blocks ──────────────────────────────────────────────────

function accountForm(input: FormFields & { action: string; submitLabel: string; defaultMode: Mode }): string {
  const mode = input.mode ?? input.defaultMode;
  const signup = mode === "signup";
  return `
  <form method="post" action="${esc(input.action)}" autocomplete="on">
    ${hidden({ csrf: input.csrf })}
    <input class="mode" type="radio" name="mode" value="signup" id="mode-signup"${signup ? " checked" : ""}>
    <input class="mode" type="radio" name="mode" value="signin" id="mode-signin"${signup ? "" : " checked"}>
    <div class="tabs" role="presentation">
      <label for="mode-signup">Create an account</label>
      <label for="mode-signin">Sign in</label>
    </div>
    <div class="field only-signup">
      <label for="display_name">Your name</label>
      <input id="display_name" name="display_name" type="text" maxlength="120" autocomplete="name" value="${esc(input.displayName ?? "")}">
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(input.email ?? "")}">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password">
      <p class="hint only-signup">At least 10 characters, not your email address.</p>
    </div>
    <div class="actions">
      <button type="submit" class="primary">${esc(input.submitLabel)}</button>
    </div>
  </form>`;
}

function codeBlock(id: string, text: string): string {
  const domId = `c-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  return `<div class="code"><pre id="${domId}">${esc(text)}</pre><button type="button" class="copy" data-copy="${domId}">Copy</button></div>`;
}

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
}

function errorBlock(error?: string): string {
  return error ? `<p class="error" role="alert">${esc(error)}</p>` : "";
}

function page(status: number, title: string, body: string): Page {
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style nonce="${nonce}">${BASE_CSS}${CSS}</style>
</head>
<body>${body}
<script nonce="${nonce}">${COPY_SCRIPT}</script>
</body>
</html>`;
  return {
    status,
    html,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  };
}

// Copy buttons: the only script on the page. Without it (or without clipboard
// access) the text is still there to select.
const COPY_SCRIPT = `document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("button[data-copy]");if(!b)return;var el=document.getElementById(b.getAttribute("data-copy"));if(!el||!navigator.clipboard)return;navigator.clipboard.writeText(el.textContent).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)})});`;

// On top of the OAuth page's stylesheet: one terracotta accent, a wider card
// for /connect, code blocks, sections, the team list. Works at 400px.
const CSS = `
:root{--accent:#b4532a;--accent-ink:#fff;--accent-soft:#f7ebe5;--code:#f6f6f4}
@media (prefers-color-scheme:dark){:root{--accent-soft:#3a241b;--code:#232321}}
.accent{color:var(--accent)}
a{color:var(--accent)}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.primary.wide{width:100%}
.card.wide{max-width:720px}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.top form{margin:0}
button.link{background:none;border:0;padding:0;color:var(--ink-2);font-size:13px;text-decoration:underline;cursor:pointer}
h2{font-size:16px;margin:0 0 10px;font-weight:600}
h3{font-size:14px;margin:16px 0 0;font-weight:600}
section{border-top:1px solid var(--line);padding:18px 0 4px;margin-top:18px}
section p{font-size:14px;color:var(--ink-2);margin:0 0 10px}
.notice{margin:0 0 16px;padding:12px 14px;border-radius:10px;background:var(--accent-soft);border:1px solid var(--accent)}
.notice p{margin:0 0 8px;font-size:14px;color:var(--ink)}
.notice code.paste{display:block;margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;user-select:all}
.notice p:last-child{margin-bottom:0}
.code{position:relative;margin:0 0 10px}
.code pre{margin:0;padding:10px 70px 10px 12px;background:var(--code);border:1px solid var(--line);border-radius:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:auto}
.copy{position:absolute;top:6px;right:6px;font-size:12px;padding:4px 10px;border-radius:8px;background:var(--card);color:var(--ink-2);border:1px solid var(--line)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:5px;word-break:break-all}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}
.row input,.row select{flex:1 1 200px;min-width:0;padding:10px 12px;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:10px}
.row .primary{flex:0 0 auto}
details{border:1px solid var(--line);border-radius:10px;padding:0 12px;margin:0 0 8px}
details[open]{padding-bottom:4px}
summary{cursor:pointer;padding:10px 0;font-weight:550;font-size:14px}
.teams{list-style:none;margin:12px 0 0;padding:0}
.team{border:1px solid var(--line);border-radius:10px;padding:12px;margin:0 0 10px}
.team-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin:0 0 4px}
.role{font-size:12px;color:var(--ink-3);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.link-row{margin:8px 0 0}
.small{font-size:13px;padding:6px 12px}
.empty{font-size:14px;color:var(--ink-3)}
.as-you{margin:0 0 18px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:400px){.row .primary{flex:1 1 100%}}
`;
