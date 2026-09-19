import { useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { OnboardingFlow } from './onboarding/OnboardingFlow';

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

/**
 * Onboarding.dc.html. The frame, the rail and the other steps live in ./onboarding/ (OnboardingFlow);
 * step 3 "Connect your tools" is this file's slot — ConnectTools above, unchanged.
 */
export function Onboarding() {
  return <OnboardingFlow connectTools={(onDone) => <ConnectTools onDone={onDone} />} />;
}
