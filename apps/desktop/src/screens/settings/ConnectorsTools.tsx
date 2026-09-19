import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../../api/hooks';
import { ErrorNote, Loading } from '../../components/bits';
import { Select } from '../../components/Select';
import type { ConnectTestDto, ConnectToolDto } from '../../shared/connect';
import { connectBridge, useFolders, useTools } from './ConnectorsData';
import { ChangesDisclosure, GuideCard, ToolRow } from './ConnectorsShared';

const COPY = {
  title: 'Connectors',
  lede: 'Tick a tool to connect it: its conversations are saved as sessions here, private to you until you share them, and it brings your context into its prompts. Untick to put its files back exactly as they were.',
  noBridge: 'Connecting tools happens in the OpenKT app on your Mac, or from a shell with openkt-connect.',
} as const;

function TestResult({ result }: { result: ConnectTestDto }) {
  const total = result.steps.reduce((a, s) => a + s.ms, 0);
  if (!result.ok || !result.session_id) return <p className="ctool__reason">Test failed: {result.problem ?? 'no session was created'}.</p>;
  return (
    <p className="ctool__result ctool__result--ok">
      Saved a test session through the hooks in {total} ms. <Link to={`/sessions/${result.session_id}`}>Open it</Link>
      {result.problem ? ` (${result.problem})` : ''}
    </p>
  );
}

function SettingsRow({ tool, state, home }: { tool: ConnectToolDto; state: ReturnType<typeof useTools>; home?: string }) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [nativeMemory, setNativeMemory] = useState(true);
  const [test, setTest] = useState<ConnectTestDto | null>(null);
  const [testing, setTesting] = useState(false);
  const connected = tool.status === 'connected' || tool.status === 'partial';
  const result = state.results[tool.id];

  // A browser connector counts as connected once the server sees a new OAuth sign-in for this person.
  useEffect(() => {
    const bridge = connectBridge();
    if (!guideOpen || !bridge || tool.status === 'connected') return;
    const since = new Date().toISOString();
    const timer = setInterval(() => {
      void bridge.detectWeb(tool.id, since).then((found) => {
        if (found === true) void state.refresh();
      });
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideOpen, tool.id, tool.status]);

  const toggle = () => {
    if (tool.guided && tool.kind === 'browser' && !connected) return setGuideOpen((o) => !o);
    void (connected ? state.undo(tool.id) : state.apply(tool.id, { nativeMemory }));
  };

  return (
    <ToolRow
      tool={tool}
      checked={connected}
      onToggle={toggle}
      busy={state.busy[tool.id]}
      home={home}
      nativeMemory={nativeMemory}
      onNativeMemory={(on) => {
        setNativeMemory(on);
        if (connected) void state.apply(tool.id, { nativeMemory: on });
      }}
    >
      {result && <p className={result.ok ? 'small-meta' : 'ctool__reason'}>{result.message}</p>}
      {!(tool.guided && tool.kind === 'browser') && <ChangesDisclosure key={`${tool.id}-${tool.status}-${nativeMemory}`} load={() => state.plan(tool.id, { nativeMemory })} />}
      {(guideOpen || (tool.guided && tool.kind === 'agent' && connected)) && (
        <GuideCard
          load={() => state.guide(tool.id)}
          done={tool.status === 'connected'}
          onDone={() => {
            setGuideOpen(false);
            void state.apply(tool.id);
          }}
        />
      )}
      {connected && tool.kind !== 'browser' && (
        <div className="ctool__actions">
          <button
            type="button"
            className="btn btn--box-sm"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setTest(null);
              state
                .test(tool.id)
                .then(setTest, (e: Error) => setTest({ ok: false, session_id: null, context_md: '', steps: [], problem: e.message }))
                .finally(() => setTesting(false));
            }}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          {test && <TestResult result={test} />}
        </div>
      )}
    </ToolRow>
  );
}

/** Git repositories the hooks have seen that nobody filed yet: their sessions stay private until filed in a space. */
function Folders() {
  const { folders, map } = useFolders();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const pending = folders.filter((f) => f.state === 'pending' || f.state === 'mapped');
  if (pending.length === 0) return null;
  const options = [{ value: '', label: 'Only me (personal)' }, ...(spaces.data ?? []).filter((s) => !/personal/i.test(s.name)).map((s) => ({ value: s.id, label: s.name }))];
  return (
    <section className="cfolders" aria-label="Folders">
      <h2 className="h2">Folders</h2>
      <ul className="plain">
        {pending.map((f) => (
          <li key={f.path} className="cfolder">
            <span className="cfolder__text">
              {f.state === 'pending' ? `Sessions from ${f.path.replace(/^\/Users\/[^/]+/, '~')} are private to you. File them in a team space?` : `Sessions from ${f.path.replace(/^\/Users\/[^/]+/, '~')} go to ${f.space_name ?? 'a team space'}.`}
            </span>
            <Select
              label={`Space for ${f.path}`}
              value={f.space_id ?? ''}
              options={options}
              onChange={(v) => void map(f.path, v || null, options.find((o) => o.value === v)?.label)}
              style={{ width: 218 }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConnectorsTools() {
  const state = useTools();
  const [showAll, setShowAll] = useState(false);
  if (!state.available) {
    return (
      <>
        <h1 className="h1 h1--sm">{COPY.title}</h1>
        <p className="lede" style={{ maxWidth: 560 }}>
          {COPY.noBridge}
        </p>
      </>
    );
  }
  const tools = state.tools ?? [];
  const shown = tools.filter((t) => t.detected.installed || t.status !== 'not-connected');
  const others = tools.filter((t) => !shown.includes(t));
  return (
    <>
      <h1 className="h1 h1--sm">{COPY.title}</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {COPY.lede}
      </p>
      {!state.tools && !state.error && <Loading />}
      {state.error && <ErrorNote error={state.error} />}
      <ul className="plain ctools">
        {shown.map((t) => (
          <SettingsRow key={t.id} tool={t} state={state} />
        ))}
      </ul>
      {others.length > 0 && (
        <>
          <button type="button" className="linkbtn" style={{ marginTop: 14 }} onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'Hide tools not found on this Mac' : `${others.length} more ${others.length === 1 ? 'tool' : 'tools'} not found on this Mac`}
          </button>
          {showAll && (
            <ul className="plain ctools" style={{ marginTop: 10 }}>
              {others.map((t) => (
                <SettingsRow key={t.id} tool={t} state={state} />
              ))}
            </ul>
          )}
        </>
      )}
      <Folders />
    </>
  );
}
