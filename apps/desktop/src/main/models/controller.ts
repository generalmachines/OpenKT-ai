/**
 * One download for the whole app: first launch, the onboarding screen, Settings → Models and
 * "Retry" all go through here, so pause means pause everywhere. Required models (search +
 * understanding) come first; speech and the image reader follow in the same run.
 * No `electron` import (see manifest.ts).
 */
import type { ModelRole } from './manifest';
import type { ModelsProgress } from './store';

export const REQUIRED_ROLES: readonly ModelRole[] = ['embed', 'llm'];
export const FOLLOW_ROLES: readonly ModelRole[] = ['whisper', 'mmproj'];

export const LOW_DISK = 'low_disk';

export interface ControllerDeps {
  ensure(onProgress: (p: ModelsProgress) => void, roles: readonly ModelRole[], signal: AbortSignal): Promise<unknown>;
  emit(p: ModelsProgress): void;
  /** Resolves false when the disk cannot hold what is left. Checked before every start. */
  enoughDisk(): Promise<boolean>;
  log?(line: string): void;
}

export type StartResult = { ok: true } | { ok: false; error: string };

export class DownloadController {
  private abort: AbortController | null = null;
  private required: Promise<StartResult> | null = null;
  /** The previous run winding down after a pause; the next run waits for it (the store is single-flight). */
  private winding: Promise<void> = Promise.resolve();
  private _paused = false;

  constructor(private readonly deps: ControllerDeps) {}

  get paused(): boolean {
    return this._paused;
  }

  get running(): boolean {
    return this.abort !== null;
  }

  /**
   * Resolves once the required models are on disk (or with why not). Joins a run already in
   * flight. `auto` is the first-launch start: it never overrides a pause the person chose.
   */
  start(opts: { auto?: boolean } = {}): Promise<StartResult> {
    if (opts.auto && this._paused) return Promise.resolve({ ok: false, error: 'paused' });
    if (this.required) return this.required;
    this._paused = false;
    const abort = new AbortController();
    this.abort = abort;

    let settle: (r: StartResult) => void = () => undefined;
    this.required = new Promise<StartResult>((r) => (settle = r));
    const done = () => {
      if (this.abort === abort) {
        this.abort = null;
        this.required = null;
      }
    };

    const previous = this.winding;
    this.winding = (async () => {
      try {
        await previous;
        abort.signal.throwIfAborted();
        if (!(await this.deps.enoughDisk())) return settle({ ok: false, error: LOW_DISK });
        await this.deps.ensure(this.deps.emit, REQUIRED_ROLES, abort.signal);
        settle({ ok: true });
        await this.deps.ensure(this.deps.emit, FOLLOW_ROLES, abort.signal);
      } catch (e) {
        const error = abort.signal.aborted ? 'paused' : (e as Error).message;
        if (!abort.signal.aborted) this.deps.log?.(`[models] download failed: ${error}`);
        settle({ ok: false, error }); // a no-op when the required half already settled
      } finally {
        done();
      }
    })();
    return this.required;
  }

  /** Stops the transfer; what was received stays on disk and `resume()` continues from it. */
  pause(): void {
    this._paused = true;
    const abort = this.abort;
    this.abort = null;
    this.required = null;
    abort?.abort(new DOMException('paused', 'AbortError'));
  }

  resume(): Promise<StartResult> {
    this._paused = false;
    return this.start();
  }
}
