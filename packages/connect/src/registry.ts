import { claudeCode } from './integrations/claude-code.js';
import { claudeDesktop } from './integrations/claude-desktop.js';
import { codex } from './integrations/codex.js';
import { cursor } from './integrations/cursor.js';
import { gemini } from './integrations/gemini.js';
import { opencode } from './integrations/opencode.js';
import { vscode } from './integrations/vscode.js';
import { chatgpt, claudeAi, httpAgent } from './integrations/web.js';
import { windsurf } from './integrations/windsurf.js';
import { ConnectError } from './errors.js';
import type { Integration } from './types.js';

/** Every integration, deepest first. Ids are what `kt connect <tool>` takes. */
export const INTEGRATIONS: readonly Integration[] = [claudeCode, codex, cursor, gemini, claudeDesktop, vscode, windsurf, opencode, claudeAi, chatgpt, httpAgent];

export function getIntegration(id: string): Integration {
  const found = INTEGRATIONS.find((i) => i.id === id);
  if (!found) throw new ConnectError('unknown_tool', `No integration called "${id}"`, { hint: `one of: ${INTEGRATIONS.map((i) => i.id).join(', ')}` });
  return found;
}
