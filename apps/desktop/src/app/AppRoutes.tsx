import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '../api/hooks';
import { Shell } from '../components/Shell';
import { CaptureOverlay, CapturePreview } from '../screens/capture/CaptureRoutes';
import { NewNote } from '../screens/NewNote';
import { Onboarding } from '../screens/Onboarding';
import { PageView } from '../screens/PageView';
import { SessionView } from '../screens/SessionView';
import { Settings } from '../screens/settings/Settings';
import { Skills } from '../screens/Skills';
import { SpaceView } from '../screens/SpaceView';
import { SpacesList } from '../screens/SpacesList';

/** "/" opens the most recent session, like a mail client opens the inbox. */
function Home() {
  const sessions = useQuery((c) => c.listSessions({ mine: true }), []);
  if (sessions.loading) return <main className="main" aria-busy="true" />;
  const first = sessions.data?.[0];
  return <Navigate to={first ? `/sessions/${first.id}` : '/new'} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/onboarding/:step?" element={<Onboarding />} />
      <Route path="/capture/:kind" element={<CapturePreview />} />
      <Route path="/overlay/:kind" element={<CaptureOverlay />} />
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
    </Routes>
  );
}
