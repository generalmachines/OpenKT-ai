import { NavLink, useLocation } from 'react-router-dom';
import { daysAgo, sessionListMeta } from '../api/format';
import { useQuery } from '../api/hooks';
import type { SessionListItem, Space } from '../api/types';
import { Icon, SOURCE_ICON, type IconName } from './Icon';
import { SetupProgress } from './SetupProgress';
import { UpdatePill } from './UpdatePill';

function groupLabel(n: number): string {
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 7) return 'This week';
  return 'Earlier';
}

function group(sessions: SessionListItem[]): [string, SessionListItem[]][] {
  const out = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const label = groupLabel(daysAgo(s.createdAt));
    out.set(label, [...(out.get(label) ?? []), s]);
  }
  return [...out.entries()];
}

function NavRow({ to, icon, label, active }: { to: string; icon: IconName; label: string; active: boolean }) {
  return (
    <NavLink to={to} className={`navrow${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      <span className="navrow__icon">
        <Icon name={icon} size={16} />
      </span>
      {label}
    </NavLink>
  );
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { pathname } = useLocation();
  const sessions = useQuery((c) => c.listSessions({ mine: true }), []);
  const spaces = useQuery((c) => c.listSpaces(), []);
  const spaceById = new Map<string, Space>((spaces.data ?? []).map((s) => [s.id, s]));

  return (
    <nav aria-label="Sessions" className="sidebar">
      <div className="sidebar__drag" aria-hidden="true" />
      <div className="sidebar__brand">
        <span className="sidebar__name">OpenKT</span>
        <span className="sidebar__status mono">
          <span className="sidebar__dot" />
          local
        </span>
      </div>
      <button type="button" className="searchbtn" onClick={onSearch}>
        <Icon name="search" size={15} />
        <span className="searchbtn__label">Search all context</span>
        <span className="mono searchbtn__key">⌘K</span>
      </button>
      <div style={{ height: 6, flexShrink: 0 }} />
      <NavRow to="/new" icon="plus" label="New note" active={pathname === '/new'} />
      <div className="sidebar__sessions">
        {group(sessions.data ?? []).map(([label, rows]) => (
          <div key={label} className="sidebar__group" role="group" aria-label={label}>
            <div className="sidebar__label mono">{label}</div>
            {rows.map((s) => {
              const active = pathname.startsWith(`/sessions/${s.id}`);
              return (
                <NavLink key={s.id} to={`/sessions/${s.id}`} className={`srow${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                  <span className="srow__icon">
                    <Icon name={SOURCE_ICON[s.source]} size={15} />
                  </span>
                  <span className="srow__text">
                    <span className="srow__title">{s.title}</span>
                    <span className="srow__sub mono">{sessionListMeta(s, spaceById.get(s.spaceId))}</span>
                  </span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </div>
      <NavRow to="/spaces" icon="folder" label="Spaces" active={pathname.startsWith('/spaces') || pathname.startsWith('/pages')} />
      <NavRow to="/skills" icon="spark" label="Skills" active={pathname.startsWith('/skills')} />
      <NavRow to="/settings" icon="gear" label="Settings" active={pathname.startsWith('/settings')} />
      {/* first run: the on-device AI download, until it is done */}
      <SetupProgress />
      {/* in-app updates: "Update ready — Restart", "what's new" (src/main/update) */}
      <UpdatePill />
    </nav>
  );
}
