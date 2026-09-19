/**
 * One download for the whole app: the onboarding choice, Settings → Models, a feature asking
 * for its model ("Download the speech model") and Retry all go through here, so pause means
 * pause everywhere. Nothing starts until the person chooses (ipc.ts records that choice and
 * only then resumes it on later launches).
 *
 * The models to fetch are a queue, one file at a time. A plain start() queues everything
 * missing — search and understanding first, then speech and images — and resolves once search
 * + understanding are on disk. start({ roles }) puts those models at the front (after the file
 * in flight) and resolves when they are on disk. No `electron` import (see manifest.ts).
 */
import type { ModelRole } from './manifest';
import { DOWNLOAD_ORDER, type ModelsProgress } from './store';

export const REQUIRED_ROLES: readonly ModelRole[] = ['embed', 'llm'];
export const FOLLOW_ROLES: readonly ModelRole[] = ['whisper', 'mmproj'];
export const ALL_ROLES: readonly ModelRole[] = DOWNLOAD_ORDER;

export const LOW_DISK = 'low_disk';

export interface ControllerDeps {
  ensure(onProgress: (p: ModelsProgress) => void, roles: readonly ModelRole[], signal: AbortSignal): Promise<unknown>;
  emit(p: ModelsProgress): void;
  /** Resolves false when the disk cannot hold what is left of `roles`. Checked before every run. */
  enoughDisk(roles: readonly ModelRole[]): Promise<boolean>;
  log?(line: string): void;
}

export type StartResult = { ok: true } | { ok: false; error: string };

interface Waiter {
  roles: ReadonlySet<ModelRole>;
  resolve(r: StartResult): void;
}

interface Run {
  abort: AbortController;
  waiters: Waiter[];
  done: Set<ModelRole>;
}

export class DownloadController {
  /** Still to fetch, in order. Survives a pause or a failure, so Resume / Retry continue the same models. */
  private queue: ModelRole[] = [];
  private run: Run | null = null;
  /** The previous run winding down after a pause; the next run waits for it (the store is single-flight). */
  private winding: Promise<void> = Promise.resolve();
  private _paused = false;

  constructor(private readonly deps: ControllerDeps) {}

  get paused(): boolean {
    return this._paused;
  }

  get running(): boolean {
    return this.run !== null;
  }

  /** What is still queued (the file in flight included while it transfers). */
  get queued(): readonly ModelRole[] {
    return [...this.queue];
  }

  /**
   * Queue models and resolve once they are on disk (or with why not: `paused`, `low_disk`, a message).
   * `auto` is the start on a later launch: it never overrides a pause the person chose.
   */
  start(opts: { auto?: boolean; roles?: readonly ModelRole[] } = {}): Promise<StartResult> {
    if (opts.auto && this._paused) return Promise.resolve({ ok: false, error: 'paused' });
    this._paused = false;
    const asked = opts.roles?.length ? ALL_ROLES.filter((r) => opts.roles!.includes(r)) : null;
    if (asked) this.queue = [...asked, ...this.queue.filter((r) => !asked.includes(r))];
    else for (const r of ALL_ROLES) if (!this.queue.includes(r)) this.queue.push(r);
    return this.wait(new Set(asked ?? REQUIRED_ROLES));
  }

  /** Stops the transfer; what was received stays on disk and `resume()` continues from it. */
  pause(): void {
    this._paused = true;
    const run = this.run;
    this.run = null;
    if (!run) return;
    run.abort.abort(new DOMException('paused', 'AbortError'));
    for (const w of run.waiters.splice(0)) w.resolve({ ok: false, error: 'paused' });
  }

  /** Continues the queued models (everything missing when nothing is queued). */
  resume(): Promise<StartResult> {
    this._paused = false;
    if (this.queue.length === 0) return this.start();
    return this.wait(new Set(this.queue));
  }

  private wait(roles: ReadonlySet<ModelRole>): Promise<StartResult> {
    const run = this.run ?? this.begin();
    return new Promise<StartResult>((resolve) => {
      run.waiters.push({ roles, resolve });
      this.settle(run);
    });
  }

  private settle(run: Run): void {
    run.waiters = run.waiters.filter((w) => {
      const met = [...w.roles].every((r) => run.done.has(r));
      if (met) w.resolve({ ok: true });
      return !met;
    });
  }

  private finish(run: Run, r: StartResult): void {
    for (const w of run.waiters.splice(0)) w.resolve(r);
  }

  private begin(): Run {
    const run: Run = { abort: new AbortController(), waiters: [], done: new Set() };
    this.run = run;
    const previous = this.winding;
    this.winding = (async () => {
      try {
        await previous;
        run.abort.signal.throwIfAborted();
        if (!(await this.deps.enoughDisk([...this.queue]))) return this.finish(run, { ok: false, error: LOW_DISK });
        while (this.queue.length > 0) {
          run.abort.signal.throwIfAborted();
          // The head stays queued until it is on disk: a pause or a failure leaves it first in line.
          const role = this.queue[0]!;
          await this.deps.ensure(this.deps.emit, [role], run.abort.signal);
          this.queue = this.queue.filter((r) => r !== role);
          run.done.add(role);
          this.settle(run);
        }
        this.finish(run, { ok: true });
      } catch (e) {
        const error = run.abort.signal.aborted ? 'paused' : (e as Error).message;
        if (!run.abort.signal.aborted) this.deps.log?.(`[models] download failed: ${error}`);
        this.finish(run, { ok: false, error });
      } finally {
        if (this.run === run) this.run = null;
      }
    })();
    return run;
  }
}
