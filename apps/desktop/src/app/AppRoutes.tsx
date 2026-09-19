import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { onboarding } from '../api';
import { useQuery } from '../api/hooks';
import { permissions } from '../api/setup-bridge';
import { Shell } from '../components/Shell';
import { CaptureOverlay, CapturePreview } from '../screens/capture/CaptureRoutes';
import { NewNote } from '../screens/NewNote';
import { Onboarding } from '../screens/Onboarding';
import { PageView } from '../screens/PageView';
import { SessionView } from '../screens/SessionView';
import { Settings } from '../screens/settings/Settings';
import { SkillEdit } from '../screens/skill/SkillEditor';
import { SkillView } from '../screens/skill/SkillView';
import { Skills } from '../screens/Skills';
import { SpaceView } from '../screens/SpaceView';
import { SpacesList } from '../screens/SpacesList';
import { Welcome } from '../screens/Welcome';
import { resumeStep } from '../onboarding/state';
import { useConnection } from '../state/connection';

/** "/" opens the most recent session, like a mail client opens the inbox. */
function Home() {
  const sessions = useQuery((c) => c.listSessions({ mine: true }), []);
  // ── first run (begin) ── an unfinished first run on this Mac (a relaunch, a sign-in rather than a sign-up) picks up where it stopped.
  const resume = resumeStep(onboarding.done(), permissions.available());
  if (resume !== null) return <Navigate to={`/onboarding/${resume}`} replace />;
  // ── first run (end) ──
  if (sessions.loading) return <main className="main" aria-busy="true" />;
  const first = sessions.data?.[0];
  return <Navigate to={first ? `/sessions/${first.id}` : '/new'} replace />;
}

/** Nobody signed in (first run, signed out, or the session ended) → the Welcome screen. */
function RequireConnection() {
  const { signedOut } = useConnection();
  return signedOut ? <Navigate to="/welcome" replace /> : <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/connect" element={<Navigate to="/welcome" replace />} />
      <Route element={<RequireConnection />}>
        <Route path="/onboarding/:step?" element={<Onboarding />} />
      </Route>
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
          <Route path="/skills/:id" element={<SkillView />} />
          <Route path="/skills/:id/edit" element={<SkillEdit />} />
          <Route path="/skills/:id/versions/:version" element={<SkillView />} />
          <Route path="/settings/:section?" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
