import type { ReactNode } from 'react';
import { useHotkeys } from '../../api/hotkeys';
import { Key } from '../../components/bits';
import { displayOf } from '../../shared/hotkeys';

function Row({ job, title, meta, keys }: { job: string; title: string; meta: string; keys: ReactNode }) {
  return (
    <li className="mdl">
      <span className="mdl__job">{job}</span>
      <span className="person__text">
        <span className="mdl__name">{title}</span>
        <span className="person__sub mono">{meta}</span>
      </span>
      <span className="keys">{keys}</span>
      <button type="button" className="btn btn--box-sm" disabled title="Rebinding arrives with the capture engine">
        Change
      </button>
    </li>
  );
}

/** Keys as caps: "⌃⌥Space" → ⌃ ⌥ Space. */
function Caps({ label }: { label: string }) {
  const parts = label.match(/[⌃⌥⌘⇧]|[^⌃⌥⌘⇧]+/g) ?? [label];
  return (
    <>
      {parts.map((p, i) => (
        <Key key={i}>{p}</Key>
      ))}
    </>
  );
}

const DEFAULTS: Record<'voice' | 'screenshot', string[]> = { voice: ['Control+Alt+Space', 'Control+Alt+N'], screenshot: ['Control+Alt+S'] };

/**
 * No artboard: laid out like Models.dc.html. Shows the keys this build really listens for — and,
 * when one cannot work (another app holds it, macOS keeps it), says so on its row. `fn` arrives with
 * the capture engine; until then it is not offered as if it worked.
 */
export function Hotkeys() {
  const info = useHotkeys();
  const row = (id: 'voice' | 'screenshot') => info?.find((h) => h.id === id);
  const keysOf = (id: 'voice' | 'screenshot') => {
    const r = row(id);
    const list = r ? (r.accelerators?.length ? r.accelerators : []) : DEFAULTS[id];
    return list.length ? (
      list.map((a, i) => (
        <span key={a} className="keys">
          {i > 0 && <span className="keys__verb">or</span>}
          <Caps label={displayOf(a)} />
        </span>
      ))
    ) : (
      <span className="keys__verb">unavailable</span>
    );
  };
  const meta = (id: 'voice' | 'screenshot', ok: string) => {
    if (!info) return window.openkt ? ok : `${ok} · in OpenKT for Mac`;
    const r = row(id);
    return r?.problem ?? (r?.registered ? ok : 'not registered');
  };

  return (
    <>
      <h1 className="h1 h1--sm">Hotkeys</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        Capture is a key away, from any app. Nothing is recorded until you press, and what you say is transcribed on this Mac.
      </p>
      <ul className="plain">
        <Row job="Talk" title="Start and stop a voice note" meta={meta('voice', 'press again to stop and save')} keys={keysOf('voice')} />
        <Row job="Screenshot" title="Capture what is on screen" meta={meta('screenshot', 'drag a region · text is read on this Mac')} keys={keysOf('screenshot')} />
        <Row job="Search" title="Search all context" meta="inside OpenKT" keys={<Caps label="⌘K" />} />
      </ul>
      <div style={{ height: 18, flexShrink: 0 }} />
      <div className="card card--row">
        <span className="card__text">
          <span className="card__title">Hold fn to talk arrives with the capture engine</span>
          <span className="card__desc">
            The fn key needs a native key tap this build does not have yet. Until then, use the keys above or the menu-bar item. If a key does nothing, the
            row above says why; a capture that cannot start (microphone or screen recording off) says so when you press it.
          </span>
        </span>
      </div>
    </>
  );
}
