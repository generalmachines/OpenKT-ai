import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useQuery } from '../api/hooks';
import { Shell } from '../components/Shell';
import { CaptureOverlay, CapturePreview } from '../screens/capture/CaptureRoutes';
import { Connect } from '../screens/Connect';
import { NewNote } from '../screens/NewNote';
import { Onboarding } from '../screens/Onboarding';
import { PageView } from '../screens/PageView';
import { SessionView } from '../screens/SessionView';
import { Settings } from '../screens/settings/Settings';
import { Skills } from '../screens/Skills';
import { SpaceView } from '../screens/SpaceView';
import { SpacesList } from '../screens/SpacesList';
import { useConnection } from '../state/connection';

/** "/" opens the most recent session, like a mail client opens the inbox. */
function Home() {
  const sessions = useQuery((c) => c.listSessions({ mine: true }), []);
  if (sessions.loading) return <main className="main" aria-busy="true" />;
  const first = sessions.data?.[0];
  return <Navigate to={first ? `/sessions/${first.id}` : '/new'} replace />;
}

/** No token (first run, signed out, or the server refused it) → the Connect screen. */
function RequireConnection() {
  const { signedOut } = useConnection();
  return signedOut ? <Navigate to="/connect" replace /> : <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/connect" element={<Connect />} />
      <Route path="/onboarding/:step?" element={<Onboarding />} />
      <Route path="/capture/:kind" element={<CapturePreview />} />
      <Route path="/overlay/:kind" element={<CaptureOverlay />} />
      <Route element={<RequireConnection />}>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="/sessions/:id/:tab?" element={<SessionView />} />
          <Route path="/new" element={<NewNote />} />
          <Route path="/spaces" element={<SpacesList />} />
          <Route path="/spaces/:id/:tab?" element={<SpaceView />} />
          <Route path="/pages/:id" element={<PageView />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/settings/:section?" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
