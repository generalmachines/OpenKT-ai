import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { relativeDay } from '../api/format';
import { useQuery } from '../api/hooks';
import type { Space } from '../api/types';
import { ErrorNote, Loading } from '../components/bits';
import { Icon } from '../components/Icon';
import { JoinDialog } from './space/JoinDialog';
import { NewSpaceDialog } from './space/NewSpaceDialog';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "12 sessions · 3 people · changed today" — who else is in it, as far as the server says. */
export function spaceMeta(s: Space): string {
  const bits: string[] = [];
  if (s.pageCount > 0) bits.push(plural(s.pageCount, 'page'));
  bits.push(plural(s.sessionCount, 'session'));
  if (s.personal) bits.push('only you');
  else if (s.myRole && s.myRole !== 'owner') bits.push(`shared with you · ${s.myRole}`);
  else bits.push(s.memberCount > 1 ? `${s.memberCount} people` : 'only you so far');
  bits.push(`changed ${relativeDay(s.updatedAt)}`);
  return bits.join(' · ');
}

/** No artboard of its own: built from the Skills header and the Space page rows. */
export function SpacesList() {
  const navigate = useNavigate();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const caps = useQuery((c) => c.capabilities(), []);
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);
  const onlyPersonal = spaces.data !== undefined && spaces.data.every((s) => s.personal);
  const open = (s: Space) => {
    setDialog(null);
    navigate(`/spaces/${s.id}`);
  };

  return (
    <main className="main main--list">
      <div className="titlebar">
        <h1 className="h1 h1--sm">Spaces</h1>
        <div className="titlebar__actions">
          {caps.data?.joinLinks && (
            <button type="button" className="btn btn--pill" onClick={() => setDialog('join')}>
              <Icon name="users" size={15} />
              Join a team
            </button>
          )}
          <button type="button" className="btn btn--dark btn--cta" onClick={() => setDialog('new')}>
            <Icon name="plus" size={15} />
            New space
          </button>
        </div>
      </div>
      <p className="lede" style={{ maxWidth: 600 }}>
        Where context is filed: a project, a customer, a team, ideas. Share a space once and everyone in it can save into it and search it.
      </p>
      {spaces.loading && !spaces.data && <Loading />}
      {spaces.error && <ErrorNote error={spaces.error} onRetry={spaces.reload} />}
      <ul className="plain rows" style={{ maxWidth: 860 }}>
        {(spaces.data ?? []).map((s) => (
          <li key={s.id}>
            <Link to={`/spaces/${s.id}`} className="prow">
              <span className="prow__title">{s.name}</span>
              {s.description && <span className="prow__desc">{s.description}</span>}
              <span className="prow__meta mono">{spaceMeta(s)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {onlyPersonal && (
        <div className="spaces__empty">
          <p>
            Only your personal space so far. Make one for a project or a team, share it by email, and what anyone saves there — notes, voice notes, screenshots — is
            searchable by everyone in it.
          </p>
          <button type="button" className="linkbtn" onClick={() => setDialog('new')}>
            Make a space for your team
          </button>
        </div>
      )}
      {dialog === 'new' && <NewSpaceDialog onClose={() => setDialog(null)} onCreated={open} />}
      {dialog === 'join' && <JoinDialog onClose={() => setDialog(null)} onJoined={open} />}
    </main>
  );
}
