import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { screenshot as screenshotIpc, voice as voiceIpc } from '../../api/bridge';
import { MeetingPrompt, RecordingPill, ScreenshotSheet, VoiceSheet } from './parts';
import { ScreenshotCapture } from './ScreenshotCapture';
import { VoiceCapture } from './VoiceCapture';

/** The grey desktop with a placeholder window, from design/gen.py `desk`. */
function Desk({ children }: { children: ReactNode }) {
  return (
    <div className="desk">
      <div className="desk__window" aria-hidden="true">
        <span style={{ width: '46%', height: 14, background: '#d9d7d1' }} />
        <span style={{ width: '82%' }} />
        <span style={{ width: '74%' }} />
        <span style={{ width: '79%' }} />
        <span style={{ width: '38%' }} />
      </div>
      {children}
    </div>
  );
}

/**
 * In-app previews: the three capture artboards, static, with their backdrop.
 * What the artboard shows is what the route shows.
 */
export function CapturePreview() {
  const { kind } = useParams();
  const [space, setSpace] = useState(kind === 'screenshot' ? 'sp-northgate' : 'sp-ideas');
  const [meeting, setMeeting] = useState<'asking' | 'recording' | 'declined'>('asking');

  if (kind === 'voice') {
    return (
      <Desk>
        <VoiceSheet
          text="What if every new store got an onboarding kit — a printed shelf map, the first week's planogram, and"
          tentative="a QR code to the floor plan"
          elapsedSec={14}
          state="listening"
          spaceId={space}
          onSpace={setSpace}
        />
      </Desk>
    );
  }
  if (kind === 'meeting') {
    return (
      <Desk>
        {meeting === 'asking' && (
          <div className="desk__topright">
            <MeetingPrompt app="Google Meet" onRecord={() => setMeeting('recording')} onDecline={() => setMeeting('declined')} />
          </div>
        )}
        {meeting !== 'declined' && <RecordingPill title="Pricing call with Northgate" elapsedSec={12 * 60 + 41} />}
      </Desk>
    );
  }
  if (kind === 'screenshot') {
    return (
      <Desk>
        <div className="desk__marquee" aria-hidden="true" />
        <ScreenshotSheet description="Competitor pricing page — three tiers, per-store billing on the top tier" spaceId={space} onSpace={setSpace} onSave={() => window.history.back()} />
      </Desk>
    );
  }
  return <Navigate to="/" replace />;
}

/**
 * The same components, bare, inside the frameless always-on-top Electron
 * windows. Driven by capture events from the main process.
 */
export function CaptureOverlay() {
  const { kind } = useParams();
  const bridge = window.openkt;
  const [voice, setVoice] = useState({ text: '', tentative: '', elapsedSec: 0, state: 'listening' as 'listening' | 'saved' });
  const [shot, setShot] = useState<string | null>(null);
  const [rec, setRec] = useState({ title: 'Meeting', elapsedSec: 0 });
  const [space, setSpace] = useState(kind === 'screenshot' ? 'sp-northgate' : 'sp-ideas');

  useEffect(() => {
    document.documentElement.classList.add('is-overlay');
    return () => document.documentElement.classList.remove('is-overlay');
  }, []);

  useEffect(() => {
    if (!bridge) return;
    return bridge.capture.onEvent((e) => {
      if (e.type === 'voice.partial') setVoice({ text: e.text, tentative: e.tentative, elapsedSec: e.elapsedSec, state: 'listening' });
      else if (e.type === 'voice.final') {
        setVoice({ text: e.text, tentative: '', elapsedSec: e.durationSec, state: 'saved' });
        setTimeout(() => void bridge.overlay.close('voice'), 1400);
      } else if (e.type === 'screenshot.captured') setShot(e.description);
      else if (e.type === 'meeting.recording') setRec({ title: e.title, elapsedSec: e.elapsedSec });
    });
  }, [bridge]);

  // With the native capture IPC present the overlays are real; without it (browser, older main) the simulated stub below stays.
  if (kind === 'voice' && voiceIpc.available() && bridge) {
    return (
      <div className="overlay">
        <VoiceCapture
          onClose={() => void bridge.overlay.close('voice')}
          // Main's second hotkey press stops its (stub) engine, which announces `voice.final`: that is the toggle.
          onToggle={(listener) => bridge.capture.onEvent((e) => e.type === 'voice.final' && listener())}
        />
      </div>
    );
  }
  if (kind === 'screenshot' && screenshotIpc.available() && bridge) {
    return (
      <div className="overlay">
        <ScreenshotCapture request={{ mode: 'interactive' }} onClose={() => void bridge.overlay.close('screenshot')} />
      </div>
    );
  }

  let body: ReactNode = null;
  if (kind === 'voice') body = <VoiceSheet {...voice} live hint="press the shortcut again to save" spaceId={space} onSpace={setSpace} />;
  else if (kind === 'screenshot')
    body = <ScreenshotSheet description={shot ?? ''} reading={shot === null} spaceId={space} onSpace={setSpace} onSave={() => void bridge?.overlay.close('screenshot')} />;
  else if (kind === 'meeting')
    body = <MeetingPrompt app="Google Meet" onRecord={() => void bridge?.capture.respondToMeeting(true)} onDecline={() => void bridge?.capture.respondToMeeting(false)} />;
  else if (kind === 'recording') body = <RecordingPill title={rec.title} elapsedSec={rec.elapsedSec} onStop={() => void bridge?.capture.stopMeeting()} />;
  else return <Navigate to="/" replace />;

  // The stub has no key-up to listen for: double-click the sheet (or press the shortcut again) to stop.
  return (
    <div className="overlay" onDoubleClick={kind === 'voice' ? () => void bridge?.capture.stopVoice() : undefined}>
      {body}
    </div>
  );
}
