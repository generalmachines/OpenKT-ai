/**
 * Screenshot or image → OCR → describe_image → extract (Spec 03 §4, interim runtime §1a).
 * macOS tools do the pixels: `screencapture -i` picks the region, `openkt-ocr` (Apple Vision)
 * reads the text, `sips` resizes. No `electron` import — CI drives this outside Electron.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { CaptureFailure } from './voice';

export interface OcrLine { text: string; x: number; y: number; w: number; h: number; confidence: number }
export interface OcrResult { text: string; lines: OcrLine[] }
export interface ScreenFact { kind: string; statement: string; quote: string }

export interface DescribeOutput { description: string; visible_text: string; entities: string[]; status: 'ok' | 'noop' }

export interface ScreenshotResult {
  cancelled?: true;
  nothing_to_save?: true;
  /** Same as nothing_to_save, under the name the renderer checks. */
  nothing?: true;
  image_path: string;
  visible_text: string;
  description: string;
  entities: string[];
  facts: ScreenFact[];
  title: string;
  /** "unavailable": the vision projector is not downloaded yet — OCR + extract only. */
  vision: 'ok' | 'unavailable' | 'failed';
  ocr_chars: number;
  dropped_facts: { statement: string; reason: string }[];
  latency_ms: { ocr: number; resize: number; describe: number; extract: number };
  notes: string[];
}

export interface ScreenshotDeps {
  tmpDir: string;
  /** `openkt-ocr` (native/ocr/main.swift). In tests `process.execPath` + a script in `ocrPrefixArgs`. */
  ocrBinary: string;
  ocrPrefixArgs?: string[];
  /** Defaults: /usr/sbin/screencapture and /usr/bin/sips. Tests point them at node scripts. */
  screencapture?: { binary: string; prefixArgs?: string[] };
  sips?: { binary: string; prefixArgs?: string[] } | null;
  /** `systemPreferences.getMediaAccessStatus('screen')` in the app. */
  screenAccess?: () => 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
  /** Runs before/after the interactive picker (the app hides its own overlays). */
  beforeInteractive?: () => void | Promise<void>;
  afterInteractive?: () => void | Promise<void>;
  /** null when vision is unavailable (no mmproj yet). */
  describe(input: { base64: string; mime_type: string; ocr_text: string; caption?: string }): Promise<DescribeOutput | null>;
  extract(turns: { role: string; text: string }[], source: 'screenshot' | 'image'): Promise<{ facts: ScreenFact[]; status: 'ok' | 'noop' }>;
}

export const MAX_EDGE = 1280;
export const MIN_OCR_CHARS = 20;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.gif', '.bmp', '.webp']);
const SCREEN_DENIED = 'OpenKT cannot record the screen. Allow it in System Settings → Privacy & Security → Screen Recording, then relaunch OpenKT.';

function exec(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.once('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ── The two drop rules (Spec 03 §4) ─────────────────────────────────────────

const GENERIC = /^(?:this is |this image (?:shows|is) |the image (?:shows|is) |it (?:shows|is) )?(?:an? |the )?(?:blank |empty |plain |generic |typical )?(?:screenshot|screen ?shot|image|picture|photo|view)(?: of (?:an? |the )?(?:blank |empty |plain |generic |computer |mac(?:os)? |windows )?(?:computer |laptop )?(?:screen|desktop|window|display|wallpaper|background|monitor))?\W*$/i;

/** "a screenshot of a desktop": says what kind of picture it is and nothing about what is in it. */
export function isGenericDescription(description: string): boolean {
  const d = description.trim();
  if (!d) return true;
  if (GENERIC.test(d)) return true;
  return d.split(/\s+/).length < 5;
}

/** Rule 1: nothing worth keeping. */
export function nothingToSave(description: string, ocrText: string): boolean {
  return ocrText.replace(/\s+/g, '').length < MIN_OCR_CHARS && isGenericDescription(description);
}

const NUMBER = /\d(?:[\d.,]*\d)?/g;
const normaliseNumber = (n: string) => n.replace(/,/g, '').replace(/\.0+$/, '');

/** Every run of digits in `s`, without thousands separators: "$1,200.50" → "1200.50". */
export function numbersIn(s: string): string[] {
  return (s.match(NUMBER) ?? []).map(normaliseNumber);
}

/**
 * Rule 2: a number in a fact must be in the OCR text, or the fact is dropped — the vision model
 * reads digits badly and must not be the only witness for one.
 */
export function numberGate<F extends { statement: string; quote: string }>(facts: F[], ocrText: string): { kept: F[]; dropped: { fact: F; missing: string[] }[] } {
  const seen = new Set(numbersIn(ocrText));
  const kept: F[] = [];
  const dropped: { fact: F; missing: string[] }[] = [];
  for (const fact of facts) {
    const missing = [...new Set([...numbersIn(fact.statement), ...numbersIn(fact.quote)])].filter((n) => !seen.has(n));
    if (missing.length) dropped.push({ fact, missing });
    else kept.push(fact);
  }
  return { kept, dropped };
}

/** Turns exactly as Spec 03 §4: caption (if any), description, then the text in the image. */
export function noteTurns(description: string, visibleText: string, caption?: string): { role: string; text: string }[] {
  return [caption?.trim() ?? '', description.trim(), visibleText.trim() ? `Text in image: ${visibleText.trim()}` : '']
    .filter(Boolean)
    .map((text) => ({ role: 'note', text }));
}

export function titleFrom(description: string, ocrText: string): string {
  const source = description.trim() || ocrText.trim().split('\n')[0] || '';
  const clause = source.split(/(?<=[^\d])[.:;—–]\s|\n/)[0] ?? '';
  return clause.replace(/[.\s]+$/, '').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
}

export function parseOcrOutput(stdout: string): OcrResult {
  const body = JSON.parse(stdout) as { text?: unknown; lines?: unknown; error?: unknown };
  if (typeof body.error === 'string') throw new Error(body.error);
  const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l): l is OcrLine => !!l && typeof (l as OcrLine).text === 'string');
  return { text: typeof body.text === 'string' ? body.text : lines.map((l) => l.text).join('\n'), lines };
}

// ── The pipeline ─────────────────────────────────────────────────────────────

export class ScreenshotService {
  constructor(private readonly deps: ScreenshotDeps) {}

  async ocr(imagePath: string): Promise<OcrResult> {
    const r = await exec(this.deps.ocrBinary, [...(this.deps.ocrPrefixArgs ?? []), imagePath], 60_000);
    if (r.code !== 0) {
      let message = r.stderr.trim() || `exit code ${r.code}`;
      try { message = (JSON.parse(r.stdout) as { error?: string }).error ?? message; } catch { /* not JSON */ }
      throw new Error(`openkt-ocr failed: ${message}`);
    }
    return parseOcrOutput(r.stdout);
  }

  /** Esc in the picker leaves no file: that is a cancel, not an error. */
  private async pickRegion(): Promise<string | null> {
    const tool = this.deps.screencapture ?? { binary: '/usr/sbin/screencapture' };
    await mkdir(this.deps.tmpDir, { recursive: true });
    const out = join(this.deps.tmpDir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`);
    await this.deps.beforeInteractive?.();
    try {
      await exec(tool.binary, [...(tool.prefixArgs ?? []), '-i', '-x', '-t', 'png', out], 0);
    } finally {
      await this.deps.afterInteractive?.();
    }
    const size = await stat(out).then((s) => s.size, () => 0);
    if (size === 0) {
      await rm(out, { force: true });
      return null;
    }
    return out;
  }

  /** PNG with the long edge ≤ 1280 px for the model; the original is left alone. */
  private async modelImage(imagePath: string): Promise<{ base64: string; mime_type: string; cleanup: string | null }> {
    const tool = this.deps.sips === undefined ? { binary: '/usr/bin/sips' } : this.deps.sips;
    if (tool && existsSync(tool.binary)) {
      const out = join(this.deps.tmpDir, `model-${randomUUID().slice(0, 8)}.png`);
      await mkdir(this.deps.tmpDir, { recursive: true });
      const r = await exec(tool.binary, [...(tool.prefixArgs ?? []), '-s', 'format', 'png', '-Z', String(MAX_EDGE), imagePath, '--out', out], 60_000);
      if (r.code === 0 && existsSync(out)) return { base64: (await readFile(out)).toString('base64'), mime_type: 'image/png', cleanup: out };
    }
    const ext = extname(imagePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
    return { base64: (await readFile(imagePath)).toString('base64'), mime_type: mime, cleanup: null };
  }

  async capture(opts: { mode: 'interactive' | 'file'; path?: string; caption?: string }): Promise<ScreenshotResult | { cancelled: true } | CaptureFailure> {
    let imagePath: string;
    if (opts?.mode === 'file') {
      if (typeof opts.path !== 'string' || !IMAGE_EXT.has(extname(opts.path).toLowerCase())) return { error: 'failed', message: 'screenshot.capture needs the path of an image file' };
      if (!(await stat(opts.path).then((s) => s.isFile(), () => false))) return { error: 'failed', message: `no such image: ${opts.path}` };
      imagePath = opts.path;
    } else {
      const access = this.deps.screenAccess?.() ?? 'unknown';
      if (access === 'denied' || access === 'restricted') return { error: 'permission_denied', message: SCREEN_DENIED };
      const picked = await this.pickRegion();
      if (!picked) return { cancelled: true };
      imagePath = picked;
    }

    const notes: string[] = [];
    const latency = { ocr: 0, resize: 0, describe: 0, extract: 0 };
    let t = performance.now();
    const ocr = await this.ocr(imagePath).catch((e: Error) => { notes.push(e.message); return { text: '', lines: [] } as OcrResult; });
    latency.ocr = Math.round(performance.now() - t);

    t = performance.now();
    const image = await this.modelImage(imagePath);
    latency.resize = Math.round(performance.now() - t);

    t = performance.now();
    let vision: ScreenshotResult['vision'] = 'ok';
    let described: DescribeOutput | null = null;
    try {
      described = await this.deps.describe({ base64: image.base64, mime_type: image.mime_type, ocr_text: ocr.text, caption: opts.caption });
      if (!described) vision = 'unavailable';
      else if (described.status === 'noop') vision = 'failed';
    } catch (e) {
      vision = 'failed';
      notes.push(`describe_image: ${(e as Error).message}`);
    } finally {
      if (image.cleanup) await rm(image.cleanup, { force: true });
    }
    latency.describe = Math.round(performance.now() - t);

    const description = described?.description.trim() ?? '';
    // The model is told to copy from the OCR text; without a model the OCR text stands in.
    const visibleText = (described?.visible_text.trim() || ocr.text.trim()).slice(0, 4000);
    const base = { image_path: imagePath, visible_text: visibleText, description, entities: described?.entities ?? [], vision, ocr_chars: ocr.text.length, notes };

    if (nothingToSave(description, ocr.text)) {
      if (opts.mode !== 'file') await rm(imagePath, { force: true });
      return { ...base, nothing_to_save: true, nothing: true, description: '', visible_text: '', facts: [], title: '', dropped_facts: [], latency_ms: latency };
    }

    t = performance.now();
    const extracted = await this.deps.extract(noteTurns(description, visibleText, opts.caption), opts.mode === 'file' ? 'image' : 'screenshot').catch((e: Error) => {
      notes.push(`extract: ${e.message}`);
      return { facts: [] as ScreenFact[], status: 'noop' as const };
    });
    latency.extract = Math.round(performance.now() - t);
    const gate = numberGate(extracted.facts, ocr.text);

    return {
      ...base,
      facts: gate.kept,
      title: titleFrom(description, ocr.text),
      dropped_facts: gate.dropped.map((d) => ({ statement: d.fact.statement, reason: `number not in the OCR text: ${d.missing.join(', ')}` })),
      latency_ms: latency,
    };
  }
}
