#!/usr/bin/env node
// OpenKT optional hook for Claude Code. Dependency-free, no network, never blocks.
//   session-start  → tells Claude to open (or keep using) an OpenKT session
//   track          → remembers the OpenKT session_id returned by kt_session_start / clears it on kt_session_end
//   session-end    → housekeeping only; the server closes idle sessions on its own
// Why a script: SessionStart supports only `command` and `mcp_tool` hooks, and `mcp_tool` hooks are
// skipped at launch because MCP servers are not connected yet (code.claude.com/docs/en/hooks).
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];
const dir = join(process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "plugins", "data", "openkt"), "sessions");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function readInput() {
  try { return JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}
const fileFor = (id) => join(dir, String(id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
function load(id) { try { return JSON.parse(readFileSync(fileFor(id), "utf8")); } catch { return null; } }
function save(id, data) { mkdirSync(dir, { recursive: true }); writeFileSync(fileFor(id), JSON.stringify(data)); }

function findSessionId(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const keyed = text.match(new RegExp('session_id\\\\*"?\\s*[:=]\\s*\\\\*"?(' + UUID.source + ")", "i"));
  return keyed ? keyed[1] : (text.match(UUID) || [])[0] || null;
}

try {
  const input = readInput();
  if (mode === "session-start") {
    const known = load(input.session_id);
    const context = known && known.kt_session_id && !known.ended
      ? `OpenKT: this conversation already has an open OpenKT session. session_id = ${known.kt_session_id}` +
        (known.space ? ` (space: ${known.space})` : "") +
        ". Keep passing it to kt_recall, kt_save_memory and kt_session_end. Do not start a new session."
      : "OpenKT is installed. Before starting the user's task, call the OpenKT MCP tool kt_session_start (give it a short title; pass a space only if you know it) " +
        "and keep the returned session_id for kt_recall, kt_save_memory and kt_session_end. Read the brief it returns. " +
        "If the OpenKT tools are missing or ask for sign-in, tell the user to run /mcp and authenticate the openkt server, then continue without blocking their task.";
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  } else if (mode === "track") {
    const tool = String(input.tool_name || "");
    if (/kt_session_start$/.test(tool)) {
      const id = findSessionId(input.tool_response);
      if (id) save(input.session_id, { kt_session_id: id, space: (input.tool_input && (input.tool_input.project || input.tool_input.project_id)) || null, started_at: new Date().toISOString(), ended: false });
    } else if (/kt_session_end$/.test(tool)) {
      const known = load(input.session_id);
      if (known) save(input.session_id, { ...known, ended: true });
    }
  } else if (mode === "session-end") {
    // Drop state older than 14 days. Open sessions are left for `claude --resume`; the server closes idle ones.
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (Date.now() - statSync(file).mtimeMs > 14 * 86400000) rmSync(file, { force: true });
    }
  }
} catch {
  // A hook must never get in the way of the session.
}
process.exit(0);
