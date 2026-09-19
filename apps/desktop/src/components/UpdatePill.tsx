import { NavLink } from 'react-router-dom';
import { useUpdateStatus } from '../api/updates';

/**
 * The quiet line in the sidebar footer (src/main/update). Nothing shows unless there is something to do:
 * "Update ready — Restart", a one-time "Updated to X — what's new", or why an update cannot install.
 */
export function UpdatePill() {
  const { status: s, run } = useUpdateStatus();
  if (!s) return null;

  if (s.phase === 'ready' && s.location.ok) {
    return (
      <button type="button" className="updpill" onClick={() => void run('install')}>
        <span className="updpill__dot" aria-hidden="true" />
        Update ready — Restart
      </button>
    );
  }
  if (s.phase === 'installing') {
    return (
      <span className="updpill" role="status">
        Restarting…
      </span>
    );
  }
  const link = (label: string) => (
    <NavLink to="/settings/about" className="updpill">
      <span className="updpill__dot" aria-hidden="true" />
      {label}
    </NavLink>
  );
  if (s.rollback) return link(`${s.rollback.from} did not start — go back?`);
  if (s.whatsNew) return link(`Updated to ${s.whatsNew.version} — what’s new`);
  if (s.available && !s.location.ok && s.location.canMove) return link('Move to Applications to update');
  if (s.phase === 'available' && !s.auto) return link(`Update available — ${s.available?.version}`);
  return null;
}
