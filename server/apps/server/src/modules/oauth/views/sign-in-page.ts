import { randomBytes } from "node:crypto";

import type { AuthorizeParams } from "../services/oauth-form-token.service";

// The OAuth sign-in + consent page, rendered by the server itself so an MCP
// client (claude.ai, Cowork, ChatGPT, Codex, Cursor…) can connect without any
// dashboard. Plain HTML with one inline <style> allowed by a per-response
// nonce; no script at all. The "Create an account" toggle is two radio
// buttons and CSS sibling selectors.
//
// Everything that comes from the request or from Dynamic Client Registration
// (client_name above all) is escaped before it is written.

export type SignInMode = "signin" | "signup";

export interface SignInPageInput {
  clientName: string;
  redirectUri: string;
  params: AuthorizeParams;
  formToken: string;
  mode: SignInMode;
  email?: string;
  displayName?: string;
  error?: string;
}

export interface RenderedPage {
  html: string;
  headers: Record<string, string>;
}

export function renderSignInPage(input: SignInPageInput): RenderedPage {
  const nonce = randomBytes(16).toString("base64");
  const client = input.clientName.trim() || "An AI tool";
  const returnTo = describeRedirect(input.redirectUri);
  const hidden = hiddenFields({ ...input.params, form_token: input.formToken });
  const signup = input.mode === "signup";

  const body = `
<main class="card">
  <p class="brand">OpenKT</p>
  <h1><span class="client">${esc(client)}</span> wants to use your OpenKT context</h1>
  <p class="lede">Sign in to let it recall what your team already knows and save what you decide, in the spaces you can open. You will go back to <strong>${esc(returnTo)}</strong> afterwards.</p>
  ${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
  <form method="post" action="/oauth/authorize" autocomplete="on">
    ${hidden}
    <input class="mode" type="radio" name="mode" value="signin" id="mode-signin"${signup ? "" : " checked"}>
    <input class="mode" type="radio" name="mode" value="signup" id="mode-signup"${signup ? " checked" : ""}>
    <div class="tabs" role="presentation">
      <label for="mode-signin">Sign in</label>
      <label for="mode-signup">Create an account</label>
    </div>
    <div class="field only-signup">
      <label for="display_name">Your name</label>
      <input id="display_name" name="display_name" type="text" maxlength="120" autocomplete="name" value="${esc(input.displayName ?? "")}">
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(input.email ?? "")}"${input.email ? "" : " autofocus"}>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password"${input.email ? " autofocus" : ""}>
      <p class="hint only-signup">At least 10 characters, not your email address.</p>
    </div>
    <div class="actions">
      <button type="submit" name="action" value="allow" class="primary">Allow</button>
      <button type="submit" name="action" value="deny" class="secondary" formnovalidate>Cancel</button>
    </div>
  </form>
  <p class="fine">Allowing gives ${esc(client)} an access token for your OpenKT account, valid for 90 days. It can read and save context only where you can.</p>
</main>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect ${esc(client)} to OpenKT</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>${body}
</body>
</html>`;

  return { html, headers: pageHeaders(nonce) };
}

export function renderErrorPage(title: string, message: string): RenderedPage {
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>OpenKT — ${esc(title)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main class="card">
  <p class="brand">OpenKT</p>
  <h1>${esc(title)}</h1>
  <p class="lede">${esc(message)}</p>
  <p class="fine">Go back to the app you were connecting and start the connection again.</p>
</main>
</body>
</html>`;
  return { html, headers: pageHeaders(nonce) };
}

function pageHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    // No script-src at all: the page runs no JavaScript. form-action is left
    // out on purpose — Chrome applies it to the redirect that follows the
    // POST, and that redirect goes to the client's own callback.
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    // The URL carries state and the PKCE challenge; keep it out of Referer.
    "Referrer-Policy": "no-referrer",
  };
}

// "claude.ai", "chatgpt.com", "127.0.0.1:1455", or "the cursor app".
function describeRedirect(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host;
    return `the ${url.protocol.replace(/:$/, "")} app`;
  } catch {
    return "the app";
  }
}

function hiddenFields(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v as string)}">`)
    .join("\n    ");
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Neutral greys, system fonts, one dark primary button — the same look as the
// OpenKT MCP cards. Light and dark follow the viewer's system setting.
export const CSS = `
:root{--bg:#f6f6f4;--card:#fff;--ink:#1a1a18;--ink-2:#55554f;--ink-3:#8a8a83;--line:#e4e4df;--field:#fff;--focus:#1a1a18;--err-bg:#fbeeec;--err-ink:#8a2a1c;--btn:#1a1a18;--btn-ink:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--ink:#f1f1ee;--ink-2:#b9b9b2;--ink-3:#85857e;--line:#33332f;--field:#232321;--focus:#f1f1ee;--err-bg:#3a1f1a;--err-ink:#f3b4a8;--btn:#f1f1ee;--btn-ink:#141413;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;padding:48px 16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 28px 20px}
.brand{margin:0 0 20px;font-weight:650;letter-spacing:.01em;font-size:14px;color:var(--ink-2)}
h1{margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600}
.client{word-break:break-word}
.lede{margin:0 0 20px;color:var(--ink-2);font-size:14px}
.error{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:var(--err-bg);color:var(--err-ink);font-size:14px}
form{margin:0}
.mode{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.tabs{display:flex;gap:4px;padding:3px;margin:0 0 16px;border:1px solid var(--line);border-radius:10px}
.tabs label{flex:1;text-align:center;padding:7px 8px;border-radius:7px;font-size:14px;color:var(--ink-2);cursor:pointer}
#mode-signin:checked~.tabs label[for=mode-signin],#mode-signup:checked~.tabs label[for=mode-signup]{background:var(--bg);color:var(--ink);font-weight:550}
#mode-signin:focus-visible~.tabs label[for=mode-signin],#mode-signup:focus-visible~.tabs label[for=mode-signup]{outline:2px solid var(--focus);outline-offset:1px}
.only-signup{display:none}
#mode-signup:checked~.only-signup,#mode-signup:checked~.field .only-signup{display:block}
.field{margin:0 0 14px}
.field label{display:block;margin:0 0 5px;font-size:13px;font-weight:550;color:var(--ink-2)}
.field input{width:100%;padding:10px 12px;font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:10px}
.field input:focus{outline:2px solid var(--focus);outline-offset:0;border-color:transparent}
.hint{margin:6px 0 0;font-size:12px;color:var(--ink-3)}
.actions{display:flex;gap:8px;margin:20px 0 0}
button{font:inherit;font-size:15px;border-radius:10px;padding:10px 16px;cursor:pointer}
.primary{flex:1;background:var(--btn);color:var(--btn-ink);border:1px solid var(--btn);font-weight:600}
.secondary{background:transparent;color:var(--ink-2);border:1px solid var(--line)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.fine{margin:18px 0 0;font-size:12px;color:var(--ink-3)}
@media (max-width:400px){body{padding:16px}.card{padding:22px 18px 16px}}
`;
