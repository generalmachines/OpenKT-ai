import { readCredentials, DEFAULT_SERVER } from '../credentials.js';
import { defineFileIntegration } from '../engine.js';
import { call, type FetchLike, oauthConsentReachable } from '../server.js';
import { readState, writeState } from '../state.js';
import type { ConnectEnv, GuidedSetup, Integration, StatusReport } from '../types.js';
import { hookScriptEdit, hookScriptPath } from './common.js';

/** The public MCP URL for a server: the hosted API's MCP lives on its own host. */
export function mcpUrl(server: string): string {
  return server.replace(/\/+$/, '') === DEFAULT_SERVER ? 'https://mcp.openkt.ai/mcp' : `${server.replace(/\/+$/, '')}/mcp`;
}

/**
 * Tools that live in a browser (claude.ai, ChatGPT) cannot be configured from disk: they reach the server from their
 * own cloud, over OAuth. The card opens the right page, copies the MCP URL and lists the steps; success is detected
 * when a new `oauth:*` access token appears for this person (GET /v1/me/tokens), or ticked by hand.
 */
function webIntegration(opts: { id: string; name: string; page: string; steps: (url: string) => string[]; docs: string[] }): Integration & {
  detectConnection(env: ConnectEnv, since: Date, fetchImpl?: FetchLike): Promise<boolean>;
} {
  const record = (env: ConnectEnv) => readState(env).tools[opts.id];
  return {
    id: opts.id,
    name: opts.name,
    kind: 'browser',
    capabilities: { mcp: true, autoCapture: false, autoRecall: false, nativeMemorySync: false },
    docs: opts.docs,
    detect: async () => ({ installed: true, path: opts.page }),
    async status(env): Promise<StatusReport> {
      return record(env)
        ? { status: 'connected', reasons: [], parts: { connector: true } }
        : { status: 'not-connected', reasons: [], parts: { connector: false } };
    },
    plan: async () => [],
    async apply(env) {
      const state = readState(env);
      state.tools[opts.id] = { applied_at: env.now().toISOString(), options: {}, files: {} };
      writeState(env, state);
      return [];
    },
    async undo(env) {
      const state = readState(env);
      delete state.tools[opts.id];
      writeState(env, state);
      return [];
    },
    async guide(env, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<GuidedSetup> {
      const { server } = await readCredentials(env);
      const url = mcpUrl(server);
      const consent = await oauthConsentReachable(fetchImpl, new URL(url).origin);
      return {
        openUrl: opts.page,
        copy: url,
        steps: opts.steps(url),
        ...(consent.ok ? {} : { blocked: `The server's browser sign-in is not ready (${consent.detail}), so ${opts.name} cannot finish connecting yet. Your coding tools are not affected.` }),
      };
    },
    async detectConnection(env, since, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
      const creds = await readCredentials(env);
      if (!creds.token) return false;
      const res = await call<{ tokens?: { name?: string; created_at?: string }[] }>(fetchImpl, creds.server, 'GET', '/v1/me/tokens', { token: creds.token, timeoutMs: 8000 });
      const found = (res.data?.tokens ?? []).some((t) => t.name?.startsWith('oauth:') && Date.parse(t.created_at ?? '') >= since.getTime());
      if (found) await this.apply(env);
      return found;
    },
  };
}

// UNVERIFIED: the exact settings path; the docs describe Customize → Connectors → + → Add custom connector
// (https://claude.com/docs/connectors/custom/remote-mcp).
export const claudeAi = webIntegration({
  id: 'claude-ai',
  name: 'Claude (claude.ai)',
  page: 'https://claude.ai/settings/connectors',
  steps: (url) => ['Open Customize → Connectors and choose + → Add custom connector.', `Name it OpenKT and paste ${url}.`, 'Choose Connect and sign in to OpenKT when the sign-in page opens.'],
  docs: ['https://claude.com/docs/connectors/custom/remote-mcp'],
});

export const chatgpt = webIntegration({
  id: 'chatgpt',
  name: 'ChatGPT',
  page: 'https://chatgpt.com/plugins',
  steps: (url) => ['Turn on Settings → Security and login → Developer mode (Plus, Pro, Business, Enterprise or Education).', `On the apps page choose +, name it OpenKT, paste ${url} and pick OAuth.`, 'Sign in to OpenKT when the sign-in page opens.'],
  docs: ['https://developers.openai.com/api/docs/guides/developer-mode'],
});

/**
 * Any agent with a shell (personal agents, browser agents, scripts): the hook script is the whole interface.
 * It installs the script and shows how to call it; `kt` (packages/cli) is the richer route when Node is available.
 */
export const httpAgent = defineFileIntegration({
  id: 'agent',
  name: 'Any agent (shell or HTTP)',
  kind: 'agent',
  capabilities: { mcp: true, autoCapture: true, autoRecall: 'prompt', nativeMemorySync: false },
  docs: ['docs/specs/06-agent-interface.md'],
  detect: () => ({ installed: true }),
  edits: (env) => [hookScriptEdit(env)],
  async guide(env) {
    const script = hookScriptPath(env);
    const { server } = await readCredentials(env);
    return {
      copy: script,
      steps: [
        `Server: ${server} (REST, JSON; see docs/specs/04-api-contract.md). MCP: ${mcpUrl(server)}, or run "sh ${script} mcp" as a stdio MCP server.`,
        'Credentials come from the shared store (macOS keychain or ~/.openkt/credentials.json), never from the agent.',
        `S=run-$$; D=$PWD`,
        `printf '{"session_id":"%s","cwd":"%s"}' "$S" "$D" | sh ${script} agent session-start   # → {"context_md": …}`,
        `printf '{"session_id":"%s","cwd":"%s","prompt":"how do we deploy?"}' "$S" "$D" | sh ${script} agent prompt   # saves the turn, → {"context_md": …}`,
        `printf '{"session_id":"%s","last_assistant_message":"Deployed with make ship."}' "$S" | sh ${script} agent stop`,
        `printf '{"session_id":"%s"}' "$S" | sh ${script} agent session-end`,
      ],
    };
  },
});
