import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// MCP Apps (the `io.modelcontextprotocol/ui` extension) — what OpenKT needs
// to serve its cards to hosts that render them (claude.ai, Claude Desktop,
// Cowork, ChatGPT, VS Code, …).
//
// Sources, checked 2026-09-19:
// - MCP Apps spec, SEP-1865, revision 2026-01-26:
//   https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
//   · a client advertises support in its capabilities:
//       capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }
//   · a tool links its UI with `_meta.ui.resourceUri` and scopes itself with
//     `_meta.ui.visibility` (["model","app"] default; ["app"] = callable by the
//     view only, hidden from the model). The flat `_meta["ui/resourceUri"]` is
//     deprecated but still read by older hosts, so both are sent (as the
//     official `registerAppTool` helper does).
//   · the resource MIME type MUST be `text/html;profile=mcp-app`.
//   · "Servers SHOULD check client capabilities before registering UI-enabled
//     tools"; tools MUST still return a meaningful text `content`.
// - MCP base protocol, current revision 2026-07-28 (stateless):
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta
//   · every request carries `_meta["io.modelcontextprotocol/clientCapabilities"]`;
//     servers "MUST NOT rely on prior requests … to establish context
//     (e.g., capabilities)".
// - ChatGPT reads `_meta.ui.resourceUri` and the alias `_meta["openai/outputTemplate"]`:
//   https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
//
// This server runs the SDK's Streamable HTTP transport statelessly (a fresh
// server per request), and the clients in use today (2025-06-18 / 2025-11-25)
// only send capabilities once, in `initialize`. So the UI flag is carried like
// this, in order of preference:
//   1. `_meta["io.modelcontextprotocol/clientCapabilities"]` on the request (2026-07-28 clients);
//   2. `params.capabilities` on an `initialize` request;
//   3. the `Mcp-Session-Id` we return on `initialize` — `okt1.ui.<random>` or
//      `okt1.no.<random>` — which clients MUST echo on every later request.
// The flag only decides which tools are listed; authorisation never depends
// on it, so the session id needs no signature.

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const CARDS_URI = "ui://openkt/cards.html";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SESSION_PREFIX = "okt1";

type JsonRpcMessage = { method?: unknown; params?: { capabilities?: unknown; _meta?: Record<string, unknown> } };

export function capabilitiesAdvertiseUi(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | null | undefined)?.extensions?.[
    UI_EXTENSION_ID
  ];
  return Array.isArray(ext?.mimeTypes) && ext!.mimeTypes.includes(MCP_APP_MIME_TYPE);
}

export interface ClientUiSupport {
  ui: boolean;
  // Set on an initialize request: the Mcp-Session-Id to hand back.
  sessionId: string | null;
}

export function resolveClientUiSupport(body: unknown, sessionHeader: string | undefined): ClientUiSupport {
  const messages = (Array.isArray(body) ? body : [body]).filter(
    (m): m is JsonRpcMessage => typeof m === "object" && m !== null,
  );

  for (const m of messages) {
    const perRequest = m.params?._meta?.[CLIENT_CAPABILITIES_META_KEY];
    if (perRequest !== undefined) return { ui: capabilitiesAdvertiseUi(perRequest), sessionId: null };
  }

  const init = messages.find((m) => m.method === "initialize");
  if (init) {
    const ui = capabilitiesAdvertiseUi(init.params?.capabilities);
    return { ui, sessionId: `${SESSION_PREFIX}.${ui ? "ui" : "no"}.${randomBytes(16).toString("hex")}` };
  }

  const [prefix, flag] = (sessionHeader ?? "").split(".");
  return { ui: prefix === SESSION_PREFIX && flag === "ui", sessionId: null };
}

// `_meta` for a tool that renders (or, with visibility ["app"], is called by) the cards.
export function cardToolMeta(visibility: Array<"model" | "app"> = ["model", "app"]): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    ui: { resourceUri: CARDS_URI, visibility },
    "ui/resourceUri": CARDS_URI,
  };
  if (visibility.includes("model")) meta["openai/outputTemplate"] = CARDS_URI;
  return meta;
}

// The built bundle from packages/mcp-cards (one self-contained HTML file: inline
// CSS + JS, no network access, runs under the default `default-src 'none'`).
// Looked up next to the server — `../packages/mcp-cards/dist/` from the server
// directory, which is where both a checkout and the Docker image
// (docker/Dockerfile.api) keep it — or at OPENKT_CARDS_HTML.
let cached: string | null | undefined;
export function loadCardsHtml(): string | null {
  if (cached !== undefined) return cached;
  const candidates = [
    process.env.OPENKT_CARDS_HTML,
    resolve(process.cwd(), "../packages/mcp-cards/dist/openkt-cards.html"),
    resolve(process.cwd(), "packages/mcp-cards/dist/openkt-cards.html"),
    resolve(__dirname, "../../../../../../../packages/mcp-cards/dist/openkt-cards.html"),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  cached = found ? readFileSync(found, "utf8") : null;
  return cached;
}
