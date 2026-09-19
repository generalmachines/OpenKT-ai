import { useEffect, useMemo, useState } from 'react';
import { Loading } from '../../components/bits';
import type { ConnectToolDto } from '../../shared/connect';
import { useTools } from '../settings/ConnectorsData';
import { ChangesDisclosure, GuideCard, ToolRow } from '../settings/ConnectorsShared';

/**
 * Onboarding step 3, "Connect your tools" (Onboarding.dc.html): the tools found on this Mac, ticked; one button
 * connects them all through packages/connect. Browser tools (claude.ai, ChatGPT) open their steps instead.
 */
export function ConnectTools({ onDone }: { onDone: () => void }) {
  const state = useTools();
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [nativeMemory, setNativeMemory] = useState<Record<string, boolean>>({});
  const [guideDone, setGuideDone] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const tools = useMemo(() => (state.tools ?? []).filter((t) => (t.detected.installed && t.kind !== 'agent') || t.status === 'connected'), [state.tools]);

  // Tick what is on this Mac by default; browser tools stay unticked until the person asks for them.
  useEffect(() => {
    if (!state.tools) return;
    setOn((prev) => {
      const next = { ...prev };
      for (const t of state.tools!) if (!(t.id in next)) next[t.id] = t.status === 'connected' || (t.detected.installed && t.kind !== 'browser' && t.kind !== 'agent');
      return next;
    });
  }, [state.tools]);

  const picked = tools.filter((t) => on[t.id] && (t.kind !== 'browser' || guideDone[t.id] || t.status === 'connected'));
  const failed = tools.filter((t) => state.results[t.id]?.ok === false);

  const connectAll = async () => {
    setRunning(true);
    let ok = true;
    for (const t of tools) {
      const want = !!on[t.id];
      const is = t.status === 'connected' || t.status === 'partial';
      if (t.kind === 'browser' && want && !guideDone[t.id] && !is) continue;
      if (want) ok = (await state.apply(t.id, { nativeMemory: nativeMemory[t.id] !== false })) && ok;
      else if (is) ok = (await state.undo(t.id)) && ok;
    }
    setRunning(false);
    setFinished(true);
    if (ok) onDone();
  };

  if (!state.available) {
    return (
      <div className="onb__main">
        <h2 className="onb__h2">Connect your tools</h2>
        <p className="lede onb__lede">Connecting Claude Code, Codex, Cursor and the others happens in the OpenKT app on your Mac. You can do it later in Settings → Connectors.</p>
        <div className="grow" />
        <div className="onb__foot">
          <span className="onb__note">You can add or remove tools later in Settings.</span>
          <button type="button" className="btn btn--accent" onClick={onDone}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  const label = (t: ConnectToolDto) => t.id;
  return (
    <div className="onb__main">
      <h2 className="onb__h2">Connect your tools</h2>
      <p className="lede onb__lede">Each conversation in a connected tool is saved as a session, private to you until you share it, and your context comes back into its prompts. Nothing to paste.</p>
      {!state.tools && <Loading />}
      {state.tools && tools.length === 0 && <p className="small-meta">No AI tools found on this Mac yet. Install one, then connect it in Settings → Connectors.</p>}
      <ul className="plain ctools">
        {tools.map((t) => (
          <ToolRow
            key={label(t)}
            tool={t}
            checked={!!on[t.id]}
            busy={state.busy[t.id] || running}
            onToggle={() => setOn((s) => ({ ...s, [t.id]: !s[t.id] }))}
            nativeMemory={nativeMemory[t.id] !== false}
            onNativeMemory={(v) => setNativeMemory((s) => ({ ...s, [t.id]: v }))}
          >
            {state.results[t.id] && !state.results[t.id]!.ok && <p className="ctool__reason">{state.results[t.id]!.message}</p>}
            {on[t.id] && t.kind === 'browser' && t.status !== 'connected' && (
              <GuideCard load={() => state.guide(t.id)} done={!!guideDone[t.id]} onDone={() => setGuideDone((s) => ({ ...s, [t.id]: true }))} />
            )}
            {on[t.id] && t.kind !== 'browser' && t.status !== 'connected' && <ChangesDisclosure load={() => state.plan(t.id, { nativeMemory: nativeMemory[t.id] !== false })} />}
          </ToolRow>
        ))}
      </ul>
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note">{finished && failed.length ? `${failed.map((t) => t.name).join(', ')} could not be connected: see above.` : 'You can add or remove tools later in Settings.'}</span>
        {finished && failed.length > 0 ? (
          <button type="button" className="btn btn--accent" onClick={onDone}>
            Continue anyway
          </button>
        ) : (
          <button type="button" className="btn btn--accent" disabled={running || !state.tools} onClick={() => void connectAll()}>
            {running ? 'Connecting…' : picked.length === 0 ? 'Continue' : `Connect ${picked.length} ${picked.length === 1 ? 'tool' : 'tools'}`}
          </button>
        )}
      </div>
    </div>
  );
}
