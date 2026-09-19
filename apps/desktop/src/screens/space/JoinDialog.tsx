import { useState, type FormEvent } from 'react';
import { ApiError, describeError } from '../../api/errors';
import { useClient } from '../../api/hooks';
import { joinCodeFrom } from '../../api/spaces';
import type { Space } from '../../api/types';
import { Overlay } from '../../components/Overlay';

/** Join a team's space with the invite link someone sent (or just the code in it). */
export function JoinDialog({ onClose, onJoined }: { onClose: () => void; onJoined: (space: Space) => void }) {
  const client = useClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!joinCodeFrom(text)) return setError('Paste the whole invite link, or the code from it.');
    setBusy(true);
    setError(null);
    try {
      onJoined(await client.joinSpace(text));
    } catch (err) {
      setError(err instanceof ApiError && err.kind === 'not-found' ? 'That invite link isn’t valid any more. Ask for a new one.' : describeError(err));
      setBusy(false);
    }
  };

  return (
    <Overlay title="Join a team" onClose={onClose} width={460}>
      <form className="form" onSubmit={submit} noValidate>
        <label htmlFor="join-link" className="field__label">
          Invite link or code
        </label>
        <input
          id="join-link"
          className="input"
          placeholder="https://openkt.ai/join/…"
          value={text}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <p className="form__hint">The space shows up in your list, and what you save there is shared with everyone in it.</p>
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions modal__actions--flush">
          <button type="button" className="btn btn--pill" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--pill btn--dark btn--run" disabled={busy || !text.trim()}>
            {busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
