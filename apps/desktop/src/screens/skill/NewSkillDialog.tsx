import { useState, type FormEvent } from 'react';
import { describeError } from '../../api/errors';
import { useClient, useQuery } from '../../api/hooks';
import { describeSkillError } from '../../api/skillFiles';
import type { Skill } from '../../api/types';
import { Overlay } from '../../components/Overlay';
import { Select, type SelectOption } from '../../components/Select';

const PERSONAL = '__personal__';

/** New skill: a name and a space, then straight into writing it. */
export function NewSkillDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (skill: Skill) => void }) {
  const client = useClient();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const [title, setTitle] = useState('');
  const [space, setSpace] = useState(PERSONAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: SelectOption<string>[] = [
    { value: PERSONAL, label: 'personal — only you' },
    ...(spaces.data ?? []).filter((s) => !s.personal).map((s) => ({ value: s.id, label: s.name })),
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) return setError('Give it a name — what it helps with, like “Sharpen a marketing message”.');
    setBusy(true);
    setError(null);
    try {
      onCreated(await client.createSkill({ title: title.trim(), spaceId: space === PERSONAL ? undefined : space }));
    } catch (err) {
      setError(describeSkillError(err, describeError));
      setBusy(false);
    }
  };

  return (
    <Overlay title="New skill" onClose={onClose} width={460}>
      <form className="form" onSubmit={submit} noValidate>
        <label htmlFor="skill-name" className="field__label">
          Name
        </label>
        <input
          id="skill-name"
          className="input"
          placeholder="Sharpen a marketing message"
          value={title}
          maxLength={200}
          autoComplete="off"
          data-autofocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'skill-name-error' : undefined}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
        />
        <span className="field__label">Space</span>
        <Select<string> label="Space" value={space} options={options} onChange={setSpace} align="left" style={{ width: '100%', height: 44, borderRadius: 10, fontSize: 14 }} />
        <p className="form__hint">Next you write it: a SKILL.md with the steps, the way you’d brief a new teammate. Everyone the space is shared with can use it.</p>
        {error && (
          <p id="skill-name-error" className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions modal__actions--flush">
          <button type="button" className="btn btn--pill" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--pill btn--dark btn--run" disabled={busy}>
            {busy ? 'Creating…' : 'Create and write'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
