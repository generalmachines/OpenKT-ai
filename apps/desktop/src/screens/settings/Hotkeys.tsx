import { useEffect, useState, type ReactNode } from 'react';
import { Key } from '../../components/bits';
import type { HotkeyInfo } from '../../shared/ipc';

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

/** No artboard: laid out like Models.dc.html. Rebinding is static for now. */
export function Hotkeys() {
  const [info, setInfo] = useState<HotkeyInfo[] | null>(null);
  useEffect(() => {
    void window.openkt?.app.hotkeys().then(setInfo);
  }, []);
  const fallback = (id: HotkeyInfo['id']) => info?.find((h) => h.id === id)?.fallbackAccelerator;

  return (
    <>
      <h1 className="h1 h1--sm">Hotkeys</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        Capture is a function key away, from any app. Nothing is recorded until you press, and what you say is transcribed on this Mac.
      </p>
      <ul className="plain">
        <Row job="Talk" title="Hold to talk" meta="release to save · filed by the Voice connector default" keys={<><span className="keys__verb">hold</span><Key>fn</Key></>} />
        <Row job="Keep listening" title="Double-tap to latch" meta="tap fn again to stop · for longer thoughts" keys={<><Key>fn</Key><Key>fn</Key></>} />
        <Row job="Screenshot" title="Capture what is on screen" meta="drag a region · text is read on this Mac" keys={<><Key>⌃</Key><Key>⌥</Key><Key>S</Key></>} />
        <Row job="Search" title="Search all context" meta="inside OpenKT" keys={<><Key>⌘</Key><Key>K</Key></>} />
      </ul>
      <div style={{ height: 18, flexShrink: 0 }} />
      <div className="card card--row">
        <span className="card__text">
          <span className="card__title">The fn key needs the capture engine</span>
          <span className="card__desc">
            {info
              ? `Until it ships, this build listens for ${fallback('voice') ?? 'no key'} to start and stop a voice note, and ${fallback('screenshot') ?? 'no key'} for a screenshot.`
              : 'Until it ships, the desktop build registers stand-in shortcuts and the menu-bar item starts a voice note or a screenshot.'}
          </span>
        </span>
      </div>
    </>
  );
}
