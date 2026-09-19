import {
  CARDS_URI,
  capabilitiesAdvertiseUi,
  cardToolMeta,
  loadCardsHtml,
  resolveClientUiSupport,
} from "../../apps/server/src/modules/mcp/services/mcp-apps";
import { HOSTED_MCP_URL, setupGuidance } from "../../apps/server/src/modules/mcp/services/mcp-server-factory.service";

const UI = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

describe("MCP Apps capability negotiation", () => {
  it("reads the extension from initialize and hands back a session id that carries it", () => {
    const withUi = resolveClientUiSupport({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: UI } }, undefined);
    expect(withUi.ui).toBe(true);
    expect(withUi.sessionId).toMatch(/^okt1\.ui\.[0-9a-f]{32}$/);
    const without = resolveClientUiSupport({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }, undefined);
    expect(without).toEqual({ ui: false, sessionId: expect.stringMatching(/^okt1\.no\./) });
  });

  it("later requests use the echoed session id; unknown ids mean no UI", () => {
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    expect(resolveClientUiSupport(list, "okt1.ui.abc")).toEqual({ ui: true, sessionId: null });
    expect(resolveClientUiSupport(list, "okt1.no.abc").ui).toBe(false);
    expect(resolveClientUiSupport(list, "someone-elses-session").ui).toBe(false);
    expect(resolveClientUiSupport(list, undefined).ui).toBe(false);
  });

  it("per-request _meta clientCapabilities (2026-07-28) wins over the session id", () => {
    const req = { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": UI } } };
    expect(resolveClientUiSupport(req, "okt1.no.abc").ui).toBe(true);
    const noUi = { ...req, params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } } };
    expect(resolveClientUiSupport(noUi, "okt1.ui.abc").ui).toBe(false);
  });

  it("needs the mcp-app MIME type, not just the key", () => {
    expect(capabilitiesAdvertiseUi({ extensions: { "io.modelcontextprotocol/ui": {} } })).toBe(false);
    expect(capabilitiesAdvertiseUi({ extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } } })).toBe(false);
    expect(capabilitiesAdvertiseUi(UI)).toBe(true);
    expect(capabilitiesAdvertiseUi(null)).toBe(false);
  });

  it("tool _meta: nested ui, the deprecated flat key, and ChatGPT's alias for model-visible tools", () => {
    expect(cardToolMeta()).toEqual({
      ui: { resourceUri: CARDS_URI, visibility: ["model", "app"] },
      "ui/resourceUri": CARDS_URI,
      "openai/outputTemplate": CARDS_URI,
    });
    expect(cardToolMeta(["app"])).toEqual({ ui: { resourceUri: CARDS_URI, visibility: ["app"] }, "ui/resourceUri": CARDS_URI });
  });

  it("finds the committed cards bundle from the server directory", () => {
    const html = loadCardsHtml();
    expect(html).toMatch(/^<!doctype html>/i);
  });
});

describe("kt_setup guidance", () => {
  it("names the server, every client, the contract — and no token to paste", () => {
    const text = setupGuidance();
    expect(text).toContain(HOSTED_MCP_URL);
    for (const label of ["claude.ai, Claude Desktop, Cowork", "ChatGPT", "Codex", "Claude Code", "Cursor", "browser agent"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("codex mcp login openkt");
    expect(text).toContain("/plugin marketplace add masti-ai/OpenKT-ai");
    expect(text).toContain("kt_session_start");
    expect(text).not.toMatch(/okt_pat_|Bearer|\/v1\/me\/tokens/);
    expect(text).not.toMatch(/masti-ai\/openkt(?!-ai)/i);
  });

  it("puts the asked-for client first and uses this server's own URL", () => {
    const text = setupGuidance("codex", "https://kt.example.com/mcp");
    const bullets = text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets[0]).toMatch(/^• Codex/);
    expect(text).toContain("codex mcp add openkt --url https://kt.example.com/mcp");
    expect(text).not.toContain(HOSTED_MCP_URL);
    expect(setupGuidance("Cowork").split("\n").find((l) => l.startsWith("• "))).toMatch(/^• claude\.ai/);
  });
});
