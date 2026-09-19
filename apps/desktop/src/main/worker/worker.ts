/**
 * The on-device worker loop: while this Mac is signed in and has the local model, it asks the
 * server for work every 30 s (backing off to 5 min when there is none), runs a claimed job with
 * the local model, and posts the result. Nothing here imports `electron`.
 */
import { refreshBrief, processSession, type BrainDeps } from './brain';
import type { AgentsModule, LlmClient, PipelineModule } from './modules';
import { ServerError, type ApplyReport, type BriefJobInput, type Claim, type JobsServer, type SessionJobInput } from './protocol';

export type WorkerState = 'off' | 'signed-out' | 'no-model' | 'idle' | 'working' | 'error';

export interface WorkerLast {
  kind: 'process_session' | 'refresh_brief';
  space: string;
  at: string;
  ms: number;
  facts: number;
  sections: number;
}

export interface WorkerStatus {
  enabled: boolean;
  state: WorkerState;
  /** "Reading the session · Hackathon team" while working. */
  current: { space: string; step: string } | null;
  last: WorkerLast | null;
  lastError: string | null;
  nextCheckAt: string | null;
  jobsDone: number;
}

export interface WorkerReadiness {
  signedIn: boolean;
  modelReady: boolean;
}

export interface LocalWorkerOptions {
  server: JobsServer;
  /** Loaded once, on the first job. */
  modules(): Promise<{ agents: AgentsModule; pipeline: PipelineModule }>;
  /** A client for the local chat model; starts the model server when needed. */
  llm(agents: AgentsModule): Promise<LlmClient>;
  readiness(): Promise<WorkerReadiness>;
  /** Shown to teammates in the job record: "Ana's Mac · Qwen3.5-4B". */
  workerName(): string;
  model: string;
  enabled?: boolean;
  pollMs?: number;
  maxPollMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

const POLL_MS = 30_000;
const MAX_POLL_MS = 5 * 60_000;

export class LocalWorker {
  private enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private idleStreak = 0;
  private readonly listeners = new Set<(s: WorkerStatus) => void>();
  private abort: AbortController | null = null;
  private st: WorkerStatus;

  constructor(private readonly opts: LocalWorkerOptions) {
    this.enabled = opts.enabled ?? true;
    this.st = { enabled: this.enabled, state: this.enabled ? 'idle' : 'off', current: null, last: null, lastError: null, nextCheckAt: null, jobsDone: 0 };
  }

  status(): WorkerStatus {
    return { ...this.st, enabled: this.enabled };
  }

  onChange(listener: (s: WorkerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<WorkerStatus>): void {
    this.st = { ...this.st, ...patch, enabled: this.enabled };
    for (const l of this.listeners) l(this.status());
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.schedule(1_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.stop();
      this.set({ state: 'off', current: null, nextCheckAt: null });
    } else {
      this.set({ state: 'idle' });
      this.idleStreak = 0;
      this.stop();
      this.start();
    }
  }

  /** Check for work now (sign-in, a model download finishing, or "Update now"). */
  poke(): void {
    if (!this.enabled) return;
    this.idleStreak = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(500);
  }

  private schedule(ms: number): void {
    if (!this.enabled) return;
    const at = (this.opts.now ?? Date.now)() + ms;
    this.set({ nextCheckAt: new Date(at).toISOString() });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().then((found) => {
        if (!this.enabled) return;
        const base = this.opts.pollMs ?? POLL_MS;
        // Work found: look again right away (drain the queue). None: 30 s, 1, 2, 4, then 5 min.
        this.idleStreak = found ? 0 : this.idleStreak + 1;
        const wait = found ? 1_000 : Math.min(this.opts.maxPollMs ?? MAX_POLL_MS, base * 2 ** Math.max(0, this.idleStreak - 1));
        this.schedule(wait);
      });
    }, ms);
    this.timer.unref?.();
  }

  /** One round: claim, run, post. Returns true when a job was processed (or given back). */
  async tick(): Promise<boolean> {
    if (this.running) {
      await this.running;
      return true;
    }
    let found = false;
    this.running = (async () => {
      found = await this.round();
    })().finally(() => {
      this.running = null;
    });
    await this.running;
    return found;
  }

  private async round(): Promise<boolean> {
    if (!this.enabled) return false;
    const ready = await this.opts.readiness().catch(() => ({ signedIn: false, modelReady: false }));
    if (!ready.signedIn) {
      this.set({ state: 'signed-out', current: null });
      return false;
    }
    if (!ready.modelReady) {
      this.set({ state: 'no-model', current: null });
      return false;
    }

    let claim: Claim;
    try {
      claim = await this.opts.server.claim(['process_session', 'refresh_brief'], this.opts.workerName());
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) this.set({ state: 'signed-out', current: null });
      else this.set({ state: 'error', lastError: `Can’t reach the server: ${(e as Error).message}` });
      return false;
    }
    if (!claim.job) {
      this.set({ state: 'idle', current: null });
      return false;
    }

    const job = claim.job;
    const space = claim.input.space.name;
    const started = (this.opts.now ?? Date.now)();
    this.abort = new AbortController();
    this.set({ state: 'working', current: { space, step: 'Starting' }, lastError: null });
    try {
      const { agents, pipeline } = await this.opts.modules();
      const llm = await this.opts.llm(agents);
      const deps: BrainDeps = {
        agents,
        pipeline,
        llm,
        model: this.opts.model,
        signal: this.abort.signal,
        lookup: (facts) => this.opts.server.lookup(job.id, facts),
        onStep: (step) => this.set({ current: { space, step } }),
      };
      let applied: ApplyReport;
      if (job.kind === 'process_session') {
        const result = await processSession(claim.input as SessionJobInput, deps);
        ({ applied } = await this.opts.server.complete(job.id, result));
      } else {
        const result = await refreshBrief(claim.input as BriefJobInput, deps);
        ({ applied } = await this.opts.server.complete(job.id, result));
      }
      const ms = (this.opts.now ?? Date.now)() - started;
      this.opts.log?.(`[worker] ${job.kind} ${job.id} in ${space}: ${Math.round(ms / 1000)} s ${JSON.stringify(applied)}`);
      this.set({
        state: 'idle',
        current: null,
        jobsDone: this.st.jobsDone + 1,
        last: {
          kind: job.kind,
          space,
          at: new Date().toISOString(),
          ms,
          facts: applied.facts?.saved ?? 0,
          sections: applied.sections?.written ?? (applied.written ? 1 : 0),
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.opts.log?.(`[worker] ${job.kind} ${job.id} failed: ${message}`);
      // The server re-queues it with back-off (or fails it after the sixth attempt).
      await this.opts.server.fail(job.id, message, !(e instanceof ServerError && e.status === 409)).catch(() => undefined);
      this.set({ state: 'error', current: null, lastError: message });
    } finally {
      this.abort = null;
    }
    return true;
  }
}
