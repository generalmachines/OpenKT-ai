import type { CSSProperties, ReactNode } from 'react';
import { describeError } from '../api/errors';
import { KIND_COLOR } from '../api/format';
import type { ContextKind } from '../api/types';

export function KindChip({ kind }: { kind: ContextKind }) {
  return (
    <span className="chip mono">
      <span className="chip__dot" style={{ background: KIND_COLOR[kind] }} />
      {kind}
    </span>
  );
}

export function Avatar({ initials, size = 34, fontSize = 12, tone, style }: { initials: string; size?: number; fontSize?: number; tone?: string; style?: CSSProperties }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize, background: tone, ...style }}>
      {initials}
    </span>
  );
}

/** The small bordered key cap used for `fn` in the session footer. */
export function Key({ children }: { children: ReactNode }) {
  return <span className="key mono">{children}</span>;
}

export function Loading() {
  return <p className="state mono">loading…</p>;
}

/** A failed read, in words a person can act on, with Retry when the caller can re-run it. Never a raw transport message. */
export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="state mono errornote" role="alert">
      <span>{describeError(error)}</span>
      {onRetry && (
        <button type="button" className="btn btn--pill-sm errornote__retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
