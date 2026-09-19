/**
 * Supervises one `llama-server` child: random free port on 127.0.0.1, /health
 * polling, restart on crash (max 3), idle unload, and a hard kill on stop().
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

export type ServerState = 'stopped' | 'starting' | 'ready' | 'crashed' | 'failed';

export interface SupervisorOptions {
  name: string;
  /** Executable. For tests this is `process.execPath` with a script in `args`. */
  binary: string;
  /** Arguments; `--host 127.0.0.1 --port <n>` are appended. */
  args: string[];
  /** Max automatic restarts after a crash. Default 3. */
  maxRestarts?: number;
  /** Stop the process after this long without `touch()`. 0 = never. */
  idleMs?: number;
  /** How long to wait for /health. Default 120 s (first Metal shader compile is slow). */
  startTimeoutMs?: number;
  healthIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LlamaServer {
  state: ServerState = 'stopped';
  port = 0;
  restarts = 0;
  lastError: string | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private wanted = false;
  private readonly tail: string[] = [];

  constructor(private readonly opts: SupervisorOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  /** Last lines of the child's output, for error reports. */
  get logTail(): string {
    return this.tail.join('\n');
  }

  /** Starts the server if needed and resolves with its base URL once /health is ok. */
  async ensureStarted(): Promise<string> {
    if (this.state === 'ready' && this.child) {
      this.touch();
      return this.baseUrl;
    }
    this.wanted = true;
    if (!this.starting) {
      this.restarts = 0;
      this.starting = this.launch().finally(() => { this.starting = null; });
    }
    // The idle clock only runs once the server is up: a slow model load must not be "idle".
    return this.starting.then((url) => { this.touch(); return url; });
  }

  /** Call on every request: pushes the idle unload out. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const idle = this.opts.idleMs ?? 0;
    if (idle > 0) {
      this.idleTimer = setTimeout(() => { if (this.starting) this.touch(); else void this.stop('idle'); }, idle);
      this.idleTimer.unref();
    }
  }

  async stop(reason = 'stop'): Promise<void> {
    this.wanted = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.state = 'stopped';
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.opts.log?.(`[${this.opts.name}] stopping (${reason}) pid ${child.pid}`);
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }

  /** Synchronous last resort for app quit / process exit. */
  killNow(): void {
    this.wanted = false;
    try { this.child?.kill('SIGKILL'); } catch { /* already gone */ }
    this.child = null;
    this.state = 'stopped';
  }

  private async launch(): Promise<string> {
    for (;;) {
      try {
        await this.spawnOnce();
        return this.baseUrl;
      } catch (e) {
        this.lastError = (e as Error).message;
        if (!this.wanted || this.restarts >= (this.opts.maxRestarts ?? 3)) {
          this.state = 'failed';
          throw new Error(`${this.opts.name} failed to start: ${this.lastError}\n${this.logTail}`);
        }
        this.restarts += 1;
        await sleep(Math.min(8000, 500 * 2 ** (this.restarts - 1)));
      }
    }
  }

  private async spawnOnce(): Promise<void> {
    this.state = 'starting';
    this.port = await freePort();
    const dir = dirname(this.opts.binary);
    const child = spawn(this.opts.binary, [...this.opts.args, '--host', '127.0.0.1', '--port', String(this.port)], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env },
    });
    this.child = child;
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > 40) this.tail.shift();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const st = { exited: null as string | null };
    child.once('error', (e) => { st.exited = `spawn error: ${e.message}`; });
    child.once('exit', (code, sig) => {
      st.exited = `exited code=${code} signal=${sig}`;
      if (this.child !== child) return; // stop() or a newer spawn owns the state
      this.child = null;
      if (this.state === 'ready' && this.wanted) {
        // Crash after a healthy start: restart in the background, within the budget.
        this.state = 'crashed';
        this.lastError = st.exited;
        this.opts.log?.(`[${this.opts.name}] ${st.exited}; restart ${this.restarts + 1}/${this.opts.maxRestarts ?? 3}`);
        if (this.restarts < (this.opts.maxRestarts ?? 3) && !this.starting) {
          this.restarts += 1;
          this.starting = this.launch().finally(() => { this.starting = null; });
          this.starting.catch(() => undefined);
        } else if (!this.starting) this.state = 'failed';
      }
    });

    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (st.exited) throw new Error(st.exited);
      if (!this.wanted) { child.kill('SIGKILL'); throw new Error('stopped while starting'); }
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) { this.state = 'ready'; return; }
      } catch { /* not listening yet */ }
      await sleep(this.opts.healthIntervalMs ?? 250);
    }
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise<void>((r) => child.once('exit', () => r()));
      child.kill('SIGKILL');
      await gone;
    }
    if (this.child === child) this.child = null;
    throw new Error(`no healthy /health within ${this.opts.startTimeoutMs ?? 120_000} ms`);
  }
}
