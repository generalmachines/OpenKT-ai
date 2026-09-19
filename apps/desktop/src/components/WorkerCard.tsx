import { useEffect, useState } from 'react';
import { timeAgo } from '../api/format';
import type { WorkerStatusDto } from '../shared/ipc';

/** "Last updated Hackathon team · 2 min ago" — minutes and hours for today, then days. */
export function sinceLabel(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return timeAgo(iso, now);
}

/** The status line under the switch. Plain words, no status codes. */
export function workerLine(s: WorkerStatusDto, now: Date = new Date()): string {
  if (!s.enabled) return 'Off. Your team’s sessions are processed on other members’ Macs.';
  if (!s.configured || s.state === 'signed-out') return 'Sign in to a server to help your team.';
  if (s.state === 'no-model') return 'Starts once the on-device model is downloaded.';
  if (s.state === 'working' && s.current) return `Updating ${s.current.space} · ${s.current.step.toLowerCase()}`;
  if (s.state === 'error') return 'Couldn’t finish the last one. It will be tried again.';
  if (s.last) return `Last updated ${s.last.space} · ${sinceLabel(s.last.at, now)}`;
  return 'Ready. Nothing to update yet.';
}

/**
 * Settings → Models: this Mac helps keep the team's pages current with the on-device model. When a
 * teammate closes a session in a shared space, a Mac with the model picks it up, pulls out what is
 * worth keeping and folds it into the space's pages. Only text goes to the server.
 */
export function WorkerCard() {
  const bridge = typeof window !== 'undefined' ? window.openkt?.worker : undefined;
  const [status, setStatus] = useState<WorkerStatusDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.status().then((s) => live && setStatus(s)).catch(() => undefined);
    const off = bridge.onChange((s) => live && setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !status) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      setStatus(await bridge.setEnabled(!status.enabled));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card--row worker__card">
      <span className="card__text">
        <span className="card__title" id="worker-switch">
          Help keep your team’s pages up to date on this Mac
        </span>
        <span className="card__desc">Closed sessions in your spaces are turned into pages with the model on this Mac. Only text goes to the server, never audio or images.</span>
        <span className="worker__line mono" role="status">
          {workerLine(status)}
        </span>
      </span>
      <button type="button" role="switch" aria-checked={status.enabled} aria-labelledby="worker-switch" className="switch" onClick={() => void toggle()} disabled={busy}>
        <span className="switch__knob" />
      </button>
    </div>
  );
}
