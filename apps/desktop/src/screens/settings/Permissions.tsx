import { useEffect, useState } from 'react';
import { permissions } from '../../api/setup-bridge';
import { PermissionsHelp, PermissionsList, usePermissions } from '../../components/PermissionsList';
import { permissionsOutstanding, permissionsUnsupported } from '../../shared/permissions';

/**
 * The reminder next to "Permissions" in the settings nav: how many switches are still off.
 * Nothing when all are on. Re-read on every section change and when the window regains focus
 * (coming back from System Settings); only the Permissions section itself polls.
 */
export function PermissionsChip({ section }: { section: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () => void permissions.status().then((s) => live && setCount(permissionsOutstanding(s).length));
    read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
    };
  }, [section]);
  if (count === 0) return null;
  return (
    <span className="setnav__chip mono" aria-label={`${count} still off`}>
      {count} off
    </span>
  );
}

/** Settings → Permissions: the onboarding rows, live. No artboard: laid out like Models.dc.html. */
export function Permissions() {
  const { status, busy, request, openSettings, relaunch } = usePermissions();
  const unsupported = status ? permissionsUnsupported(status) : false;
  const off = status ? permissionsOutstanding(status) : [];
  return (
    <>
      <h1 className="h1 h1--sm">Permissions</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {unsupported
          ? 'This computer doesn’t ask apps for microphone, screen or shortcut access, so there is nothing to allow here.'
          : off.length
            ? 'Some switches are still off. Each one only matters for the thing it says — turn them on when you want that.'
            : 'What OpenKT may use on this Mac. Each row shows what your Mac says right now.'}
      </p>
      {!status && <p className="state mono">checking this Mac…</p>}
      {status && !unsupported && (
        <>
          <PermissionsList status={status} busy={busy} onRequest={(k) => void request(k)} onOpenSettings={(k) => void openSettings(k)} onRelaunch={() => void relaunch()} />
          <div style={{ height: 18, flexShrink: 0 }} />
          <PermissionsHelp />
        </>
      )}
    </>
  );
}
