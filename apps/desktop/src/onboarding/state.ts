/**
 * Where the person is in the first run, kept on this Mac so a relaunch (Screen Recording needs
 * one) or a closed window comes back to the same step. Steps that were put off are remembered
 * as such — never as done — so Settings can keep a quiet reminder.
 *
 *   1 Account (the Welcome screen) · 2 Permissions · 3 Connect your tools · 4 Set up on-device AI · 5 Try it
 */
export const ONBOARDING_STEPS = [2, 3, 4, 5] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const FIRST_STEP: OnboardingStep = 2;
export const LAST_STEP: OnboardingStep = 5;

export type TryItCard = 'voice' | 'screenshot' | 'note';

export interface OnboardingProgress {
  /** The step to come back to. */
  step: OnboardingStep;
  /** Steps the person chose "Later" on. */
  skipped: OnboardingStep[];
  /** Try-it cards that really finished. */
  tried: TryItCard[];
  /** ms since epoch. Only captures newer than this count for "Try it". */
  startedAt: number;
}

export const PROGRESS_KEY = 'openkt.onboarding';

export const isStep = (n: unknown): n is OnboardingStep => typeof n === 'number' && (ONBOARDING_STEPS as readonly number[]).includes(n);

function fresh(): OnboardingProgress {
  return { step: FIRST_STEP, skipped: [], tried: [], startedAt: Date.now() };
}

export function readProgress(): OnboardingProgress | null {
  try {
    const raw = globalThis.localStorage?.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<OnboardingProgress>;
    return {
      step: isStep(j.step) ? j.step : FIRST_STEP,
      skipped: Array.isArray(j.skipped) ? j.skipped.filter(isStep) : [],
      tried: Array.isArray(j.tried) ? j.tried.filter((t): t is TryItCard => t === 'voice' || t === 'screenshot' || t === 'note') : [],
      startedAt: typeof j.startedAt === 'number' ? j.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeProgress(p: OnboardingProgress): void {
  try {
    globalThis.localStorage?.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* private window: the first run simply starts over next time */
  }
}

/** The progress to resume, starting one when there is none. */
export function beginProgress(): OnboardingProgress {
  const p = readProgress() ?? fresh();
  if (!readProgress()) writeProgress(p);
  return p;
}

export function setStep(step: OnboardingStep): OnboardingProgress {
  const p = beginProgress();
  const next = { ...p, step };
  writeProgress(next);
  return next;
}

export function markSkipped(step: OnboardingStep): OnboardingProgress {
  const p = beginProgress();
  const next = { ...p, skipped: p.skipped.includes(step) ? p.skipped : [...p.skipped, step] };
  writeProgress(next);
  return next;
}

export function unmarkSkipped(step: OnboardingStep): OnboardingProgress {
  const p = beginProgress();
  const next = { ...p, skipped: p.skipped.filter((s) => s !== step) };
  writeProgress(next);
  return next;
}

export function markTried(card: TryItCard): OnboardingProgress {
  const p = beginProgress();
  const next = { ...p, tried: p.tried.includes(card) ? p.tried : [...p.tried, card] };
  writeProgress(next);
  return next;
}

/** True while a first run is under way on this Mac (started, not finished). The Home route resumes it. */
export function inProgress(done: boolean): boolean {
  return !done && readProgress() !== null;
}

/**
 * Where "/" sends a signed-in person: the step a first run stopped at (a relaunch, a closed
 * window), the first step when the desktop app has never been set up on this Mac (someone who
 * signed in rather than signed up), or null for their sessions.
 */
export function resumeStep(done: boolean, desktop: boolean): OnboardingStep | null {
  if (done) return null;
  const p = readProgress();
  if (p) return p.step;
  return desktop ? FIRST_STEP : null;
}

export function clearProgress(): void {
  try {
    globalThis.localStorage?.removeItem(PROGRESS_KEY);
  } catch {
    /* nothing to clear */
  }
}
