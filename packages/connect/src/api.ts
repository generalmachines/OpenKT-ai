import { ConnectError } from './errors.js';
import { getIntegration, INTEGRATIONS } from './registry.js';
import type { Capabilities, Change, ConnectEnv, ConnectionStatus, Detection, GuidedSetup, IntegrationKind, IntegrationOptions, StatusReport } from './types.js';

/** One row of the tool list: what the app's "Connect your tools" and `openkt-connect list --json` show. */
export interface ToolInfo {
  id: string;
  name: string;
  kind: IntegrationKind;
  capabilities: Capabilities;
  nativeMemoryNote?: string;
  detected: Detection;
  status: ConnectionStatus;
  reasons: string[];
  parts: Record<string, boolean>;
  /** Tools configured by hand in their own UI (claude.ai, ChatGPT, any agent) show a guide instead of a file plan. */
  guided: boolean;
  docs: string[];
}

/** The skill is ten files; people read it as one thing. */
function collapseSkill(changes: Change[]): Change[] {
  const out: Change[] = [];
  let skill: Change | undefined;
  for (const c of changes) {
    const m = /^(.*\/skills\/openkt)\//.exec(c.file);
    if (!m) {
      out.push(c);
      continue;
    }
    if (!skill) {
      skill = { file: `${m[1]}/`, action: c.action, summary: c.summary.startsWith('removed') ? 'removed: the openkt skill' : 'the openkt skill (when to recall, what to save, which space) with its references' };
      out.push(skill);
    }
  }
  return out;
}

async function info(env: ConnectEnv, id: string): Promise<ToolInfo> {
  const integration = getIntegration(id);
  const [detected, report] = await Promise.all([
    integration.detect(env).catch((): Detection => ({ installed: false })),
    integration.status(env).catch((err: unknown): StatusReport => ({ status: 'needs-attention', reasons: [err instanceof Error ? err.message : String(err)], parts: {} })),
  ]);
  return {
    id: integration.id,
    name: integration.name,
    kind: integration.kind,
    capabilities: integration.capabilities,
    ...(integration.nativeMemoryNote ? { nativeMemoryNote: integration.nativeMemoryNote } : {}),
    detected,
    status: report.status,
    reasons: report.reasons,
    parts: report.parts,
    guided: typeof integration.guide === 'function',
    docs: integration.docs,
  };
}

/** Every tool, detected ones first (deepest integration first within each group). */
export async function listTools(env: ConnectEnv): Promise<ToolInfo[]> {
  const all = await Promise.all(INTEGRATIONS.map((i) => info(env, i.id)));
  return [...all.filter((t) => t.detected.installed && t.kind !== 'browser' && t.kind !== 'agent'), ...all.filter((t) => !(t.detected.installed && t.kind !== 'browser' && t.kind !== 'agent'))];
}

export const toolInfo = info;

export async function planTool(env: ConnectEnv, id: string, options?: IntegrationOptions): Promise<Change[]> {
  return collapseSkill(await getIntegration(id).plan(env, options));
}

export async function connectTool(env: ConnectEnv, id: string, options?: IntegrationOptions, force = false): Promise<{ changes: Change[]; tool: ToolInfo }> {
  const integration = getIntegration(id);
  const detected = await integration.detect(env);
  if (!detected.installed && !force) throw new ConnectError('not_installed', `${integration.name} was not found on this machine`, { hint: 'install it first, or pass --force' });
  const changes = collapseSkill(await integration.apply(env, options));
  return { changes, tool: await info(env, id) };
}

export async function disconnectTool(env: ConnectEnv, id: string): Promise<{ changes: Change[]; tool: ToolInfo }> {
  const changes = collapseSkill(await getIntegration(id).undo(env));
  return { changes, tool: await info(env, id) };
}

export async function guideTool(env: ConnectEnv, id: string): Promise<GuidedSetup | null> {
  const integration = getIntegration(id);
  return integration.guide ? integration.guide(env) : null;
}
