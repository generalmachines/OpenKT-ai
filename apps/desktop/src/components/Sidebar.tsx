import { useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { daysAgo, sessionListMeta } from '../api/format';
import { ApiError } from '../api/errors';
import { useClient, useQuery } from '../api/hooks';
import type { SessionListItem, Space } from '../api/types';
import { useConnection } from '../state/connection';
import { ErrorNote } from './bits';
import { Icon, SOURCE_ICON, type IconName } from './Icon';
import { NewSpaceDialog } from '../screens/space/NewSpaceDialog';
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

/** Where the data on screen comes from: the server's host, or sample data. Never a fixed word. */
function statusLabel(kind: 'mock' | 'http', baseUrl: string, offline: boolean): string {
  if (kind === 'mock') return 'sample data';
  if (offline) return 'offline';
  try {
    return new URL(baseUrl).host || 'server';
  } catch {
    return 'server';
  }
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { pathname } = useLocation();
  const client = useClient();
  const { settings } = useConnection();
  const navigate = useNavigate();
  const [newSpace, setNewSpace] = useState(false);
  const sessions = useQuery((c) => c.listSessions({ mine: true }), []);
  const spaces = useQuery((c) => c.listSpaces(), []);
  const spaceById = new Map<string, Space>((spaces.data ?? []).map((s) => [s.id, s]));
  const offline = sessions.error instanceof ApiError && sessions.error.kind === 'network';
  const retry = () => {
    sessions.reload();
    spaces.reload();
  };

  return (
    <nav aria-label="Sessions" className="sidebar">
      <div className="sidebar__drag" aria-hidden="true" />
      <div className="sidebar__brand">
        <span className="sidebar__name">OpenKT</span>
        <span className="sidebar__status mono" title={client.kind === 'http' ? settings.baseUrl : 'Sample data — not signed in to a server'}>
          <span className={`sidebar__dot${offline || client.kind === 'mock' ? ' sidebar__dot--off' : ''}`} />
          {statusLabel(client.kind, settings.baseUrl, offline)}
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
        {sessions.error && !sessions.data?.length && (
          <div className="sidebar__note">
            <ErrorNote error={sessions.error} onRetry={retry} />
          </div>
        )}
        {!sessions.error && !sessions.loading && sessions.data?.length === 0 && <p className="sidebar__note">No sessions yet. Write a note and it lands here — and in ⌘K.</p>}
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
      <div className="navrow-wrap">
        <NavRow to="/spaces" icon="folder" label="Spaces" active={pathname.startsWith('/spaces') || pathname.startsWith('/pages')} />
        <button type="button" className="navrow__add" aria-label="New space" title="New space" onClick={() => setNewSpace(true)}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <NavRow to="/skills" icon="spark" label="Skills" active={pathname.startsWith('/skills')} />
      <NavRow to="/settings" icon="gear" label="Settings" active={pathname.startsWith('/settings')} />
      {/* first run: the on-device AI download, until it is done */}
      <SetupProgress />
      {/* in-app updates: "Update ready — Restart", "what's new" (src/main/update) */}
      <UpdatePill />
      {newSpace &&
        createPortal(
          <NewSpaceDialog
            onClose={() => setNewSpace(false)}
            onCreated={(space) => {
              setNewSpace(false);
              navigate(`/spaces/${space.id}`);
            }}
          />,
          document.body,
        )}
    </nav>
  );
}
