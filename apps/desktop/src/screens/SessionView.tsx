import { useState } from 'react';
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router-dom';
import { describeError } from '../api/errors';
import { accessSummary, duration, offset, relativeDayTime, sourceLabel } from '../api/format';
import { useClient, useQuery } from '../api/hooks';
import { useHotkeys, voiceKeys } from '../api/hotkeys';
import { writableSpaces } from '../api/spaces';
import type { ContextItem, Session } from '../api/types';
import { AccessPanel } from '../components/AccessPanel';
import { ErrorNote, Key, KindChip, Loading } from '../components/bits';
import { Icon, SOURCE_ICON } from '../components/Icon';
import { useConnectedToolCount } from './settings/ConnectorsData';
import { Overlay } from '../components/Overlay';
import { Select } from '../components/Select';
import { spaceOptionLabel } from '../components/useSaveSpace';

const TABS = ['summary', 'context', 'transcript', 'access'] as const;
type Tab = (typeof TABS)[number];


function ContextRow({ item, detail }: { item: ContextItem; detail?: boolean }) {
  return (
    <li className={`ctx${detail ? ' ctx--detail' : ''}`}>
      <KindChip kind={item.kind} />
      <span className="ctx__text">
        <span>{item.statement}</span>
        {detail && item.quote && <span className="ctx__quote">“{item.quote}”</span>}
        {detail && item.tags.length > 0 && <span className="ctx__tags mono">{item.tags.join(' · ')}</span>}
      </span>
      <span className="ctx__who mono">{item.author}</span>
    </li>
  );
}

/** File a session under another space: its context moves with it. Only offered when the server can (`capabilities().moveSession`). */
function MoveDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const client = useClient();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const choices = writableSpaces(spaces.data ?? []).filter((s) => s.id !== session.spaceId);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = to || choices[0]?.id || '';

  const move = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.moveSession(session.id, target);
      onClose();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <Overlay title="Move to another space" subtitle={session.title} onClose={onClose} width={460}>
      <div className="form">
        <span className="field__label">Space</span>
        {choices.length ? (
          <Select<string>
            label="Move to"
            value={target}
            options={choices.map((s) => ({ value: s.id, label: spaceOptionLabel(s) }))}
            onChange={setTo}
            align="left"
            style={{ width: '100%', height: 44, borderRadius: 10, fontSize: 14 }}
          />
        ) : (
          <p className="empty">There is no other space you can save into. Make one from Spaces first.</p>
        )}
        <p className="form__hint move__hint">Its context moves with it, and everyone in that space can find it.</p>
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions modal__actions--flush">
          <button type="button" className="btn btn--pill" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--pill btn--dark" onClick={() => void move()} disabled={busy || !target}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function Header({ session, spaceName, access }: { session: Session; spaceName: string; access: string }) {
  const client = useClient();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const caps = useQuery((c) => c.capabilities(), []);
  const me = useQuery((c) => c.getMe(), []);
  const canMove = Boolean(caps.data?.moveSession && me.data && session.authorId === me.data.id);
  const bits = [sourceLabel(session.source)];
  if (session.durationSec) bits.push(duration(session.durationSec));
  bits.push(relativeDayTime(session.createdAt));
  // A teammate's session says whose it is.
  if (session.authorName && me.data && session.authorId !== me.data.id) bits.unshift(`saved by ${session.authorName}`);

  return (
    <header className="shead">
      <div className="shead__row">
        <h1 className="h1">{session.title}</h1>
        <button type="button" className="btn btn--pill" onClick={() => navigate(`/sessions/${session.id}/access`)}>
          <Icon name="users" size={15} />
          Share
        </button>
        <div className="select-root">
          <button type="button" className="btn btn--round" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" size={16} />
          </button>
          {menu && (
            <ul className="menu menu--right" role="menu" onMouseLeave={() => setMenu(false)}>
              <li className="menu__item" role="menuitem" onClick={() => (setMenu(false), navigate(`/spaces/${session.spaceId}`))}>
                Open space
              </li>
              {canMove && (
                <li className="menu__item" role="menuitem" onClick={() => (setMenu(false), setMoving(true))}>
                  Move to another space…
                </li>
              )}
              {session.status === 'open' && (
                <li className="menu__item" role="menuitem" onClick={() => (setMenu(false), void client.closeSession(session.id))}>
                  Close session
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
      {moving && <MoveDialog session={session} onClose={() => setMoving(false)} />}
      <div className="shead__meta mono">
        <span className="with-icon">
          <Icon name={SOURCE_ICON[session.source]} size={13} />
          {bits.join(' · ')}
        </span>
        <Link to={`/spaces/${session.spaceId}`} className="quiet-link">
          {spaceName}
        </Link>
        <span className="with-icon">
          <Icon name="lock" size={13} />
          {access}
        </span>
        {session.status === 'open' && <span>open</span>}
      </div>
    </header>
  );
}

export function SessionView() {
  const { id = '', tab } = useParams();
  const active: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'summary';
  const session = useQuery((c) => c.getSession(id), [id]);
  const context = useQuery((c) => c.listContext(id), [id]);
  const grants = useQuery((c) => c.listGrants({ type: 'session', id }), [id]);
  const spaces = useQuery((c) => c.listSpaces(), []);
  const connectedTools = useConnectedToolCount(); // tools connected on this Mac (packages/connect)
  const voice = voiceKeys(useHotkeys());
  const me = useQuery((c) => c.getMe(), []);

  if (tab && !(TABS as readonly string[]).includes(tab)) return <Navigate to={`/sessions/${id}`} replace />;
  if (session.error) {
    return (
      <main className="main main--session">
        <ErrorNote error={session.error} onRetry={session.reload} />
      </main>
    );
  }
  if (!session.data) {
    return (
      <main className="main main--session" aria-busy="true">
        <Loading />
      </main>
    );
  }

  const s = session.data;
  const items = context.data ?? [];
  const spaceName = spaces.data?.find((x) => x.id === s.spaceId)?.name ?? '';
  const tools = connectedTools ?? 0;
  // Only an owner can list who has access; anyone else reading it was given it.
  const sharedWithMe = Boolean(me.data && s.authorId && s.authorId !== me.data.id);
  const where = s.extractedOn === 'device' ? 'extracted on this Mac' : s.extractedOn === 'none' ? 'saved as written' : 'extracted on your server';

  return (
    <main className="main main--session">
      <Header session={s} spaceName={spaceName} access={sharedWithMe ? 'shared with you' : accessSummary(grants.data ?? [])} />
      <div className="tabs" role="tablist" aria-label="Session">
        {TABS.map((t) => (
          <NavLink
            key={t}
            to={t === 'summary' ? `/sessions/${id}` : `/sessions/${id}/${t}`}
            end
            role="tab"
            aria-selected={t === active}
            className={`tab${t === active ? ' is-active' : ''}`}
          >
            {t === 'context' ? `Context · ${items.length}` : t.charAt(0).toUpperCase() + t.slice(1)}
          </NavLink>
        ))}
      </div>

      {active === 'summary' && (
        <>
          <section className="summary">
            <p>{s.summary || 'No summary yet. It is written when the session closes.'}</p>
          </section>
          <section className="ctxlist">
            <div className="ctxlist__head">
              <h2 className="h-label">Context saved from this session</h2>
              <span className="mono small-meta">{where}</span>
            </div>
            <ul className="plain">
              {items.slice(0, 5).map((c) => (
                <ContextRow key={c.id} item={c} />
              ))}
            </ul>
            {items.length === 0 && <p className="empty">Nothing worth keeping was found in this session.</p>}
          </section>
        </>
      )}

      {active === 'context' && (
        <section className="ctxlist">
          <div className="ctxlist__head">
            <h2 className="h-label">Each item keeps the words it came from</h2>
            <span className="mono small-meta">{where}</span>
          </div>
          <ul className="plain">
            {items.map((c) => (
              <ContextRow key={c.id} item={c} detail />
            ))}
          </ul>
          {items.length === 0 && <p className="empty">Nothing worth keeping was found in this session.</p>}
        </section>
      )}

      {active === 'transcript' && (
        <section className="ctxlist">
          <div className="ctxlist__head">
            <h2 className="h-label">Transcript</h2>
            <span className="mono small-meta">{s.extractedOn === 'device' ? 'transcribed on this Mac · editors and owners only' : 'editors and owners only'}</span>
          </div>
          <ol className="plain">
            {s.turns.map((t) => (
              <li key={t.id} className="turn">
                <span className="turn__at mono">{offset(t.at)}</span>
                <span className="turn__who">{t.speaker}</span>
                <span className="turn__text">{t.text}</span>
              </li>
            ))}
          </ol>
          {s.turns.length === 0 && <p className="empty">This session has no transcript.</p>}
        </section>
      )}

      {active === 'access' && <AccessPanel resource={{ type: 'session', id }} noun="session" />}

      <div className="grow" />
      {active !== 'access' && (
      <footer className="sfoot">
        <span className="sfoot__icon">
          <Icon name="mic" size={16} />
        </span>
        <span className="sfoot__text">
          {voice ? (
            <>
              Press <Key>{voice[0]}</Key> for a voice note
            </>
          ) : (
            'Voice notes: OpenKT for Mac'
          )}
        </span>
        <span className="mono small-meta">
          retrievable from {tools} connected {tools === 1 ? 'tool' : 'tools'}
        </span>
      </footer>
      )}
    </main>
  );
}
