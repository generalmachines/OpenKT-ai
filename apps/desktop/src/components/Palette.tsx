import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KIND_COLOR } from '../api/format';
import { useClient } from '../api/hooks';
import type { RecallHit } from '../api/types';
import { Icon, SOURCE_ICON } from './Icon';

export interface PaletteScope {
  spaceId: string;
  label: string;
}

const GROUPS: [RecallHit['type'], string][] = [
  ['session', 'Sessions'],
  ['page', 'Pages'],
  ['context', 'Context'],
];

/** ⌘K — search over sessions, pages and context through `client.recall`. */
export function Palette({ scope, onClose }: { scope: PaletteScope | null; onClose: () => void }) {
  const client = useClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RecallHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    let live = true;
    client.recall(query, { spaceId: scope?.spaceId, limit: 9 }).then(
      (r) => {
        if (!live) return;
        setHits(GROUPS.flatMap(([type]) => r.filter((h) => h.type === type)));
        setCursor(0);
      },
      () => live && setHits([]),
    );
    return () => {
      live = false;
    };
  }, [client, query, scope?.spaceId]);

  const open = (h: RecallHit) => {
    onClose();
    navigate(h.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(hits.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[cursor];
      if (h) open(h);
    }
  };

  let index = -1;
  return (
    <div className="palette__scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search all context" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette__input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-label={scope ? `Ask ${scope.label} anything` : 'Search all context'}
            placeholder={scope ? `Ask ${scope.label} anything` : 'Search all context'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="mono palette__esc">esc</span>
        </div>
        <div id="palette-results" role="listbox" aria-label="Results" className="palette__results">
          {hits.length === 0 && <p className="palette__empty">Nothing relevant{query ? ` for “${query}”` : ''}.</p>}
          {GROUPS.map(([type, label]) => {
            const rows = hits.filter((h) => h.type === type);
            if (rows.length === 0) return null;
            return (
              <div key={type} role="group" aria-label={label}>
                <div className="sidebar__label mono">{label}</div>
                {rows.map((h) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={`${h.type}-${h.id}`}
                      role="option"
                      aria-selected={i === cursor}
                      className={`srow palette__row${i === cursor ? ' is-active' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => open(h)}
                    >
                      <span className="srow__icon">
                        {h.type === 'context' && h.kind ? (
                          <span className="palette__dot">
                            <span className="chip__dot" style={{ background: KIND_COLOR[h.kind] }} />
                          </span>
                        ) : (
                          <Icon name={h.type === 'page' ? 'note' : h.source ? SOURCE_ICON[h.source] : 'note'} size={15} />
                        )}
                      </span>
                      <span className="srow__text">
                        <span className="srow__title">{h.title}</span>
                        <span className="srow__sub mono">{h.type === 'context' && h.kind ? `${h.kind} · ${h.meta}` : h.meta}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="palette__foot mono">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span style={{ flexGrow: 1 }} />
          <span>{scope ? scope.label : 'everything you can read'}</span>
        </div>
      </div>
    </div>
  );
}
