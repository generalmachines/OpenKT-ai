import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { describeError } from '../api/errors';
import { relativeDay } from '../api/format';
import { useClient, useQuery } from '../api/hooks';
import { ErrorNote, Loading } from '../components/bits';
import { Icon } from '../components/Icon';

/** "New space": a name, then straight to the space's Access panel — a space exists to be shared. */
function NewSpace({ onDone }: { onDone: () => void }) {
  const client = useClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const space = await client.createSpace(name);
      onDone();
      navigate(`/spaces/${space.id}/access`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <form className="access__invite" style={{ maxWidth: 600 }} onSubmit={submit} aria-busy={busy || undefined}>
      <label htmlFor="new-space" className="sr-only">
        Space name
      </label>
      <input id="new-space" className="input" placeholder="Name it: a customer, a project, a team" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
      <button type="submit" className="btn btn--dark btn--pill-sm" disabled={!name.trim() || busy}>
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" className="btn btn--pill-sm" onClick={onDone} disabled={busy}>
        Cancel
      </button>
      {error && (
        <p className="state mono" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** No artboard of its own: built from the Skills header and the Space page rows. */
export function SpacesList() {
  const spaces = useQuery((c) => c.listSpaces(), []);
  const [creating, setCreating] = useState(false);
  return (
    <main className="main main--list">
      <div className="titlebar">
        <h1 className="h1 h1--sm">Spaces</h1>
        <button type="button" className="btn btn--dark btn--cta" onClick={() => setCreating(true)} disabled={creating}>
          <Icon name="plus" size={15} />
          New space
        </button>
      </div>
      <p className="lede" style={{ maxWidth: 600 }}>
        Where context is filed: a project, a customer, a team, ideas. Pages inside a space keep themselves current, and access is set once for everything in it.
      </p>
      {creating && <NewSpace onDone={() => setCreating(false)} />}
      {spaces.loading && !spaces.data && <Loading />}
      {spaces.error && <ErrorNote error={spaces.error} onRetry={spaces.reload} />}
      <ul className="plain rows" style={{ maxWidth: 860 }}>
        {(spaces.data ?? []).map((s) => (
          <li key={s.id}>
            <Link to={`/spaces/${s.id}`} className="prow">
              <span className="prow__title">{s.name}</span>
              <span className="prow__desc">{s.description}</span>
              <span className="prow__meta mono">
                {[`${s.pageCount} pages`, `${s.sessionCount} sessions`, s.personal ? 'only you' : s.memberCount ? `${s.memberCount} people` : '', `changed ${relativeDay(s.updatedAt)}`].filter(Boolean).join(' · ')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
