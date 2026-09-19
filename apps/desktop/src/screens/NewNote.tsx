import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClient, useQuery } from '../api/hooks';
import { Key } from '../components/bits';
import { Icon } from '../components/Icon';
import { Select } from '../components/Select';

/** No artboard: a note is a session like any other, so it borrows the session layout. */
export function NewNote() {
  const client = useClient();
  const navigate = useNavigate();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [spaceId, setSpaceId] = useState('sp-personal');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() && !text.trim()) return;
    const firstLine = text.trim().split('\n')[0]?.slice(0, 60) ?? '';
    const session = await client.createSession({ source: 'note', title: title.trim() || firstLine, spaceId, text });
    navigate(`/sessions/${session.id}`);
  };

  const space = spaces.data?.find((s) => s.id === spaceId);

  return (
    <main className="main main--session">
      <form className="note" onSubmit={save}>
        <label htmlFor="note-title" className="sr-only">
          Title
        </label>
        <input id="note-title" className="note__title" placeholder="Untitled note" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <div className="shead__meta mono">
          <span className="with-icon">
            <Icon name="note" size={13} />
            note · now
          </span>
          <span className="with-icon">
            <Icon name="lock" size={13} />
            {space?.personal ? 'only you' : `filed in ${space?.name ?? ''}`}
          </span>
        </div>
        <div className="rule" />
        <label htmlFor="note-body" className="sr-only">
          Note
        </label>
        <textarea id="note-body" className="note__body" placeholder="Write it down. Context is extracted when you save." value={text} onChange={(e) => setText(e.target.value)} />
        <footer className="sfoot">
          <span className="sfoot__text" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5 }}>Save to</span>
            <Select
              label="Save to space"
              variant="pill"
              align="left"
              up
              value={spaceId}
              onChange={setSpaceId}
              options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
              leading={<Icon name="folder" size={13} />}
            />
            <span className="mono small-meta">
              or hold <Key>fn</Key> and say it
            </span>
          </span>
          <button type="submit" className="btn btn--dark btn--pill-sm" disabled={!title.trim() && !text.trim()}>
            Save
          </button>
        </footer>
      </form>
    </main>
  );
}
