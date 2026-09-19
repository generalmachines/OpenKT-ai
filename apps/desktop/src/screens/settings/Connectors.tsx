import { ConnectorsAccess } from './ConnectorsAccess';
import { ConnectorsTools } from './ConnectorsTools';

/** Settings → Connectors connects the tools on this Mac (packages/connect); Access defaults keeps the sharing table. */
export function Connectors({ mode }: { mode: 'connectors' | 'access' }) {
  return mode === 'connectors' ? <ConnectorsTools /> : <ConnectorsAccess mode="access" />;
}
