import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import type { ConnectChangeDto, ConnectGuideDto, ConnectToolDto } from '../../shared/connect';
import '../../styles/connect.css';
import { capabilityChips, foundLabel, STATUS_LABEL } from './ConnectorsData';

const ICON: Record<ConnectToolDto['kind'], IconName> = { 'coding-agent': 'code', 'desktop-app': 'chat', browser: 'chat', agent: 'agent' };

export function StatusPill({ status }: { status: ConnectToolDto['status'] }) {
  return (
    <span className={`ctool__pill ctool__pill--${status}`}>
      <span className="ctool__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** "What will change": the exact files a tick touches. Loaded when opened. */
export function ChangesDisclosure({ load }: { load: () => Promise<ConnectChangeDto[]> }) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<ConnectChangeDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    load().then(
      (c) => live && setChanges(c),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <details className="ctool__changes" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>What will change</summary>
      {error && <p className="ctool__reason">{error}</p>}
      {changes && changes.length === 0 && <p className="small-meta">Nothing: it is already set up.</p>}
      {changes && changes.length > 0 && (
        <ul className="plain">
          {changes.map((c) => (
            <li key={c.file}>
              <span className="mono">
                {c.action} {c.file.replace(/^\/Users\/[^/]+/, '~')}
              </span>
              <span className="small-meta"> · {c.summary}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="small-meta">Every file is backed up beside itself first. No token is written to any of them; untick to put them back.</p>
    </details>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** For tools set up in their own UI: open the page, copy the URL, three steps, then "I've done it". */
export function GuideCard({ load, onDone, done }: { load: () => Promise<ConnectGuideDto | null>; onDone: () => void; done: boolean }) {
  const [guide, setGuide] = useState<ConnectGuideDto | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    load().then(
      (g) => live && setGuide(g),
      () => undefined,
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!guide) return <p className="small-meta ctool__guide">Loading the steps…</p>;
  return (
    <div className="ctool__guide">
      {guide.blocked && <p className="ctool__reason">{guide.blocked}</p>}
      <ol>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="ctool__actions">
        {guide.openUrl && (
          <a className="btn btn--box-sm" href={guide.openUrl} target="_blank" rel="noreferrer" onClick={() => guide.copy && void copy(guide.copy).then(setCopied)}>
            Open {new URL(guide.openUrl).hostname}
          </a>
        )}
        {guide.copy && (
          <button type="button" className="btn btn--box-sm" onClick={() => void copy(guide.copy!).then(setCopied)}>
            {copied ? 'Copied' : 'Copy the address'}
          </button>
        )}
        {!done && (
          <button type="button" className="btn btn--box-sm" onClick={onDone}>
            I’ve done it
          </button>
        )}
      </div>
    </div>
  );
}

/** One tool: tick, name, where it was found, what it can do, and its status. */
export function ToolRow({
  tool,
  checked,
  onToggle,
  busy,
  home,
  nativeMemory,
  onNativeMemory,
  children,
}: {
  tool: ConnectToolDto;
  checked: boolean;
  onToggle: () => void;
  busy?: boolean;
  home?: string;
  nativeMemory?: boolean;
  onNativeMemory?: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  const chips = capabilityChips(tool);
  return (
    <li className="ctool">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={tool.name}
        aria-description={foundLabel(tool, home)}
        aria-busy={busy || undefined}
        className="tool ctool__main"
        disabled={busy}
        onClick={onToggle}
      >
        <span className="tool__icon">
          <Icon name={ICON[tool.kind]} size={18} />
        </span>
        <span className="person__text">
          <span className="person__name">{tool.name}</span>
          <span className="person__sub mono">{foundLabel(tool, home)}</span>
        </span>
        <StatusPill status={tool.status} />
        {checked ? (
          <span className="box box--on">
            <Icon name="check" size={13} stroke={2.2} />
          </span>
        ) : (
          <span className="box" />
        )}
      </button>
      <div className="ctool__body">
        <span className="ctool__chips">
          {chips.map((c) => (
            <span key={c} className="ctool__chip">
              {c}
            </span>
          ))}
        </span>
        {tool.capabilities.nativeMemorySync && onNativeMemory && (
          <label className="ctool__native">
            <input type="checkbox" checked={nativeMemory !== false} onChange={(e) => onNativeMemory(e.target.checked)} />
            <span>{tool.nativeMemoryNote ?? 'Also sync this tool’s own memory.'}</span>
          </label>
        )}
        {tool.reasons.length > 0 && (
          <ul className="plain">
            {tool.reasons.map((r) => (
              <li key={r} className={tool.status === 'needs-attention' ? 'ctool__reason' : 'small-meta'}>
                {r}
              </li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </li>
  );
}
