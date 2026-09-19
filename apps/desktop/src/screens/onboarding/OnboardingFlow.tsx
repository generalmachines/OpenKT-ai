import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { onboarding } from '../../api';
import { useQuery } from '../../api/hooks';
import { permissions } from '../../api/setup-bridge';
import { Icon } from '../../components/Icon';
import { formatBytes, totals, useModelsSetup, type ModelsSetupState } from '../../onboarding/models';
import { beginProgress, clearProgress, isStep, markSkipped, setStep, unmarkSkipped, type OnboardingProgress, type OnboardingStep } from '../../onboarding/state';
import { permissionsOutstanding, permissionsUnsupported, type PermissionsStatusDto } from '../../shared/permissions';
import { ModelsStep } from './ModelsStep';
import { PermissionsStep } from './PermissionsStep';
import { TryItStep } from './TryItStep';

type StepState = 'done' | 'now' | 'todo' | 'later';

function Step({ n, title, detail, state }: { n: number; title: string; detail: string; state: StepState }) {
  return (
    <li className={`step step--${state}`} aria-current={state === 'now' ? 'step' : undefined}>
      {state === 'done' ? (
        <span className="step__mark step__mark--done">
          <Icon name="check" size={14} stroke={2} />
        </span>
      ) : (
        <span className="step__mark mono">{n}</span>
      )}
      <span className="step__text">
        <span className="step__title">{title}</span>
        <span className="step__detail">{detail}</span>
      </span>
    </li>
  );
}

function modelsDetail(setup: ModelsSetupState, past: boolean): string {
  const size = setup.rows?.length ? `${formatBytes(totals(setup.rows).total)}` : 'A one-time download';
  if (!past || setup.phase === 'checking') return `Open-source models, ${size}. They run on this Mac — your choice.`;
  switch (setup.phase) {
    case 'ready':
      return 'Ready on this Mac.';
    case 'downloading':
      return `Downloading — ${setup.percent}%. Keep going.`;
    case 'idle':
      return 'Not downloaded. Settings → Models has it.';
    case 'paused':
      return `Paused at ${setup.percent}%. Resume in Settings → Models.`;
    case 'unavailable':
      return 'Set up by OpenKT for Mac.';
    default:
      return 'Needs a look — Settings → Models.';
  }
}

/**
 * Onboarding.dc.html: the rail with numbered steps on the left, the step on the right.
 * 1 Sign in (the Welcome screen) · 2 Allow access · 3 Connect your tools (a slot the
 * integrations work fills) · 4 Set up on-device AI · 5 Try it. The step is kept on this Mac,
 * so a relaunch (Screen Recording needs one) comes back to it. "Do this later" is always
 * visible and remembered as later, never as done.
 */
export function OnboardingFlow({ connectTools }: { connectTools: (onDone: () => void) => ReactNode }) {
  const { step } = useParams();
  const navigate = useNavigate();
  const me = useQuery((c) => c.getMe(), []);
  const [progress, setProgress] = useState<OnboardingProgress>(() => beginProgress());
  const n = step === undefined ? progress.step : Number(step);
  const valid = isStep(n);
  const setup = useModelsSetup();
  const [perms, setPerms] = useState<PermissionsStatusDto | null>(null);

  useEffect(() => {
    if (valid) setProgress(setStep(n));
  }, [n, valid]);

  // The rail only needs a snapshot; the Permissions step itself watches live.
  useEffect(() => void permissions.status().then(setPerms), [n]);

  // Not a Mac: nothing to allow, so step 2 hands straight over to step 3 (the rail says so).
  const nothingToAllow = useCallback(() => {
    setProgress(unmarkSkipped(2));
    navigate('/onboarding/3', { replace: true });
  }, [navigate]);

  if (!valid) return <Navigate to={`/onboarding/${progress.step}`} replace />;
  const now = n as OnboardingStep;

  const go = (next: number) => navigate(`/onboarding/${next}`);
  const finish = () => {
    onboarding.markDone();
    clearProgress();
    navigate('/', { replace: true });
  };
  const next = (from: OnboardingStep) => {
    setProgress(unmarkSkipped(from));
    if (from === 5) finish();
    else go(from + 1);
  };
  const later = (from: OnboardingStep) => {
    setProgress(markSkipped(from));
    if (from === 5) finish();
    else go(from + 1);
  };

  const state = (i: OnboardingStep): StepState => (i === now ? 'now' : progress.skipped.includes(i) ? 'later' : i < now ? 'done' : 'todo');
  const permsDetail = (): string => {
    if (state(2) === 'later') return 'Later — Settings → Permissions keeps a reminder.';
    if (perms && permissionsUnsupported(perms)) return 'Nothing to allow on this computer.';
    if (state(2) !== 'done') return 'Microphone, screen and the shortcut — each one is your call.';
    return perms && permissionsOutstanding(perms).length ? 'Done. What’s left waits in Settings → Permissions.' : 'Done.';
  };

  return (
    <div className="onb">
      <aside className="onb__rail">
        <div className="sidebar__drag" aria-hidden="true" />
        <span className="onb__name">OpenKT</span>
        <h1 className="onb__h1">Five steps. No terminal.</h1>
        <ol className="plain onb__steps">
          <Step n={1} title="Sign in" detail={me.data ? `Signed in as ${me.data.name}.` : 'Signed in.'} state="done" />
          <Step n={2} title="Allow access" detail={permsDetail()} state={state(2)} />
          <Step
            n={3}
            title="Connect your tools"
            detail={state(3) === 'later' ? 'Later — Settings → Connectors.' : state(3) === 'done' ? 'Connected. New conversations are saved as sessions.' : 'Pick the AI tools whose conversations you want kept.'}
            state={state(3)}
          />
          <Step n={4} title="Set up on-device AI" detail={state(4) === 'later' ? 'Later — Settings → Models.' : modelsDetail(setup, state(4) === 'done')} state={state(4)} />
          <Step n={5} title="Try it" detail="Say something, capture your screen, write a note." state={state(5)} />
        </ol>
        <div className="grow" />
        {now < 5 && (
          <button type="button" className="onb__later" onClick={() => later(now)}>
            Do this later
            <span className="mono small-meta">settings keeps a reminder</span>
          </button>
        )}
      </aside>
      {now === 2 && <PermissionsStep onContinue={() => next(2)} onNothingToAllow={nothingToAllow} />}
      {now === 3 && connectTools(() => next(3))}
      {now === 4 && <ModelsStep setup={setup} onContinue={() => next(4)} onLater={() => later(4)} />}
      {now === 5 && <TryItStep setup={setup} onFinish={(tried) => (tried > 0 ? next(5) : later(5))} />}
    </div>
  );
}
