import { NavLink, Navigate, useParams } from 'react-router-dom';
import { Account, Workspace } from './Workspace';
import { Connectors } from './Connectors';
import { Hotkeys } from './Hotkeys';
import { Models } from './Models';
import { Permissions, PermissionsChip } from './Permissions';

const SECTIONS = [
  ['connectors', 'Connectors'],
  ['access', 'Access defaults'],
  ['permissions', 'Permissions'], // first run: same rows as the onboarding step
  ['models', 'Models'],
  ['hotkeys', 'Hotkeys'],
  ['workspace', 'Workspace'],
  ['account', 'Account'],
] as const;

type Section = (typeof SECTIONS)[number][0];

/** Connectors.dc.html / Models.dc.html share this frame: sub-nav + content. */
export function Settings() {
  const { section } = useParams();
  if (!section) return <Navigate to="/settings/connectors" replace />;
  if (!SECTIONS.some(([id]) => id === section)) return <Navigate to="/settings/connectors" replace />;
  const active = section as Section;

  return (
    <>
      <nav className="setnav" aria-label="Settings">
        {SECTIONS.map(([id, label]) => (
          <NavLink key={id} to={`/settings/${id}`} className={`setnav__item${id === active ? ' is-active' : ''}`}>
            {label}
            {id === 'permissions' && <PermissionsChip section={active} />}
          </NavLink>
        ))}
      </nav>
      <main className="main main--settings">
        {active === 'connectors' && <Connectors mode="connectors" />}
        {active === 'access' && <Connectors mode="access" />}
        {active === 'permissions' && <Permissions />}
        {active === 'models' && <Models />}
        {active === 'hotkeys' && <Hotkeys />}
        {active === 'workspace' && <Workspace />}
        {active === 'account' && <Account />}
      </main>
    </>
  );
}
