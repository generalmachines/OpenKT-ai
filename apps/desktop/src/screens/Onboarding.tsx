import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { onboarding } from '../api';
import { useQuery } from '../api/hooks';
import { Icon, type IconName } from '../components/Icon';

type StepState = 'done' | 'now' | 'todo';

function Step({ n, title, detail, state }: { n: number; title: string; detail: string; state: StepState }) {
  return (
    <li className={`step step--${state}`} aria-current={state === 'now' ? 'step' : undefined}>
      {state === 'done' ? (
        <span className="step__mark step__mark--done">
          <Icon name="check" size={14} stroke={2} />
        </span>
      ) : (
        <span className="step__mark mono">{n}</span>
      )}
      <span className="step__text">
        <span className="step__title">{title}</span>
        <span className="step__detail">{detail}</span>
      </span>
    </li>
  );
}

interface Tool {
  id: string;
  icon: IconName;
  name: string;
  found: string;
}

const TOOLS: Tool[] = [
  { id: 'claude-code', icon: 'code', name: 'Claude Code', found: 'found · ~/.claude' },
  { id: 'cursor', icon: 'code', name: 'Cursor', found: 'found · ~/.cursor' },
  { id: 'chatgpt', icon: 'chat', name: 'ChatGPT', found: 'opens a sign-in page' },
  { id: 'claude', icon: 'chat', name: 'Claude', found: 'opens a sign-in page' },
  { id: 'capture', icon: 'video', name: 'Meetings, voice and screenshots', found: 'asks for microphone and screen recording next' },
];

const BUNDLE = [
  { name: 'Qwen3.5-4B', job: 'understanding and images · 4-bit', gb: 3.0 },
  { name: 'Qwen3-Embedding-0.6B', job: 'search · must match your server’s index', gb: 0.3 },
  { name: 'Qwen3-Reranker-0.6B', job: 'reranking', gb: 0.3 },
  
];

function ConnectTools({ onDone }: { onDone: () => void }) {
  const [on, setOn] = useState<Record<string, boolean>>({ 'claude-code': true, cursor: true, chatgpt: true, claude: false, capture: true });
  const count = Object.values(on).filter(Boolean).length;
  return (
    <div className="onb__main">
      <h2 className="onb__h2">Connect your tools</h2>
      <p className="lede onb__lede">Each conversation in a connected tool is saved as a session, private to you until you share it. Nothing to paste, nothing to restart.</p>
      {TOOLS.map((t) => (
        <button key={t.id} type="button" role="checkbox" aria-checked={Boolean(on[t.id])} aria-label={t.name} aria-description={t.found} className="tool" onClick={() => setOn((s) => ({ ...s, [t.id]: !s[t.id] }))}>
          <span className="tool__icon">
            <Icon name={t.icon} size={18} />
          </span>
          <span className="person__text">
            <span className="person__name">{t.name}</span>
            <span className="person__sub mono">{t.found}</span>
          </span>
          {on[t.id] ? (
            <span className="box box--on">
              <Icon name="check" size={13} stroke={2.2} />
            </span>
          ) : (
            <span className="box" />
          )}
        </button>
      ))}
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note">You can add or remove tools later in Settings.</span>
        <button type="button" className="btn btn--accent" disabled={count === 0} onClick={onDone}>
          {count === 0 ? 'Pick a tool' : `Connect ${count} ${count === 1 ? 'tool' : 'tools'}`}
        </button>
      </div>
    </div>
  );
}

function GetModels({ onDone }: { onDone: () => void }) {
  const [pct, setPct] = useState<number | null>(null);
  const total = BUNDLE.reduce((a, m) => a + m.gb, 0);

  useEffect(() => {
    if (pct === null || pct >= 100) return;
    const t = setTimeout(() => setPct((p) => Math.min(100, (p ?? 0) + 4)), 120);
    return () => clearTimeout(t);
  }, [pct]);

  // Models finish in order; each one's share of the bar is its share of the bytes.
  let before = 0;
  return (
    <div className="onb__main">
      <h2 className="onb__h2">Get the local models</h2>
      <p className="lede onb__lede">Transcription, screenshots and first-pass extraction run on this Mac, so raw audio and images never leave it. One download; the speech models are fetched the first time you dictate or record a meeting.</p>
      <ul className="plain">
        {BUNDLE.map((m) => {
          const start = (before / total) * 100;
          before += m.gb;
          const end = (before / total) * 100;
          const local = pct === null ? 0 : Math.max(0, Math.min(1, (pct - start) / (end - start)));
          return (
            <li key={m.name} className="dl">
              <span className="person__text">
                <span className="person__name">{m.name}</span>
                <span className="person__sub mono">{m.job}</span>
              </span>
              <span className="mono small-meta dl__state">
                {local >= 1 ? (
                  <span className="conn__state" style={{ width: 'auto' }}>
                    <Icon name="check" size={13} />
                    ready
                  </span>
                ) : local > 0 ? (
                  `${Math.round(local * 100)}%`
                ) : (
                  `${m.gb.toFixed(1)} GB`
                )}
              </span>
              <span className="dl__bar" aria-hidden="true">
                <span style={{ width: `${local * 100}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note">{pct === null ? 'On an 8 GB Mac a lighter 2B model is used instead.' : pct >= 100 ? 'Ready. Hold fn anywhere to think out loud.' : 'Downloading. You can keep working.'}</span>
        {pct !== null && pct >= 100 ? (
          <button type="button" className="btn btn--accent" onClick={onDone}>
            Open OpenKT
          </button>
        ) : (
          <button type="button" className="btn btn--accent" disabled={pct !== null} onClick={() => setPct(0)}>
            {pct === null ? `Download ${total.toFixed(1)} GB` : `Downloading ${pct}%`}
          </button>
        )}
      </div>
    </div>
  );
}

/** Onboarding.dc.html. Signing in happened on the Welcome screen, so step 1 is always ticked. */
export function Onboarding() {
  const { step } = useParams();
  const navigate = useNavigate();
  const me = useQuery((c) => c.getMe(), []);
  const n = step === undefined ? 2 : Number(step);
  if (![2, 3].includes(n)) return <Navigate to="/onboarding/2" replace />;
  const state = (i: number): StepState => (i < n ? 'done' : i === n ? 'now' : 'todo');
  const finish = () => {
    onboarding.markDone();
    navigate('/');
  };

  return (
    <div className="onb">
      <aside className="onb__rail">
        <div className="sidebar__drag" aria-hidden="true" />
        <span className="onb__name">OpenKT</span>
        <h1 className="onb__h1">Three steps. No terminal.</h1>
        <ol className="plain onb__steps">
          <Step n={1} title="Sign in" detail={me.data ? `Signed in as ${me.data.name}.` : 'Signed in.'} state="done" />
          <Step n={2} title="Connect your tools" detail={n > 2 ? 'Connected. New conversations are saved as sessions.' : 'We found these on your Mac. Pick the ones to connect.'} state={state(2)} />
          <Step n={3} title="Get the local models" detail="About 4 GB. Transcription and extraction run on this Mac." state={state(3)} />
        </ol>
      </aside>
      {n === 2 && <ConnectTools onDone={() => navigate('/onboarding/3')} />}
      {n === 3 && <GetModels onDone={finish} />}
    </div>
  );
}
