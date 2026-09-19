/**
 * Runs the bundled `whisper-cli` (whisper.cpp, MIT) on one WAV file. Same safety net as the
 * llama supervisor: if the GPU (Metal) path dies, retry on the CPU (`-ng`) and stay there.
 * No `electron` import.
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname } from 'node:path';
import { parseWhisperJson, type ParsedTranscript } from './transcript';

export interface WhisperOptions {
  /** `whisper-cli`. In tests this is `process.execPath` with a script in `prefixArgs`. */
  binary: string;
  prefixArgs?: string[];
  model: string;
  threads?: number;
  log?: (line: string) => void;
}

export interface WhisperRun extends ParsedTranscript {
  latencyMs: number;
  usedGpu: boolean;
}

export class WhisperError extends Error {
  constructor(message: string, readonly tail: string) {
    super(message);
    this.name = 'WhisperError';
  }
}

interface Exit { code: number | null; signal: NodeJS.Signals | null; tail: string; timedOut: boolean }

function run(binary: string, args: string[], timeoutMs: number): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: dirname(binary), stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const onData = (b: Buffer) => {
      for (const line of b.toString('utf8').split('\n')) if (line.trim()) { tail.push(line); if (tail.length > 30) tail.shift(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(new WhisperError(`whisper-cli could not start: ${e.message}`, '')); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, tail: tail.join('\n'), timedOut }); });
  });
}

export class Whisper {
  /** Sticky after the first GPU failure. */
  cpuOnly = false;
  constructor(private readonly opts: WhisperOptions) {}

  /** The exact arguments, public for the unit test and the README. `-of` is the output path without ".json". */
  args(wav: string, outBase: string, language: string, cpuOnly: boolean): string[] {
    const threads = this.opts.threads ?? Math.max(2, Math.min(8, cpus().length - 2));
    return [...(this.opts.prefixArgs ?? []), '-m', this.opts.model, '-f', wav, '-l', language, '-t', String(threads), '-oj', '-of', outBase, '-np', ...(cpuOnly ? ['-ng'] : [])];
  }

  async transcribe(wav: string, language = 'auto', clipMs = 0): Promise<WhisperRun> {
    const outBase = wav.replace(/\.wav$/i, '');
    const json = `${outBase}.json`;
    const timeoutMs = Math.max(120_000, clipMs * 6);
    const started = performance.now();
    try {
      for (;;) {
        const cpuOnly = this.cpuOnly;
        await rm(json, { force: true });
        const exit = await run(this.opts.binary, this.args(wav, outBase, language, cpuOnly), timeoutMs);
        const raw = exit.code === 0 ? await readFile(json, 'utf8').catch(() => null) : null;
        if (raw !== null) return { ...parseWhisperJson(raw), latencyMs: Math.round(performance.now() - started), usedGpu: !cpuOnly };
        const why = exit.timedOut ? `timed out after ${timeoutMs} ms` : `exited code=${exit.code} signal=${exit.signal}`;
        if (!cpuOnly) {
          this.cpuOnly = true;
          this.opts.log?.(`[whisper] ${why} on the GPU path; retrying on the CPU (-ng)`);
          continue;
        }
        throw new WhisperError(`whisper-cli ${why}`, exit.tail);
      }
    } finally {
      await rm(json, { force: true });
    }
  }
}
