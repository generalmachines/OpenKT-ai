import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowPermission, isAppUrl } from '../../src/main/capture/permissions';
import { ScreenshotService, isGenericDescription, noteTurns, nothingToSave, numberGate, numbersIn, parseOcrOutput, titleFrom, type DescribeOutput, type ScreenshotDeps } from '../../src/main/capture/screenshot';

const TOOL = join(__dirname, 'fixtures/fake-tool.mjs');
const PNG = join(__dirname, '../fixtures/pricing-page.png');
const OCR_TEXT = 'Growth\n$49 / store / month\nPer-store billing\nMore than 40 stores\nAnnual billing saves 15%.';

describe('drop rule 1 — nothing worth keeping', () => {
  it('a generic description with under 20 characters of text saves nothing', () => {
    for (const d of ['A screenshot of a desktop', 'a screenshot of a desktop.', 'Screenshot of a computer screen', 'An image of a blank window', 'A screenshot', '', 'Desktop wallpaper']) expect(isGenericDescription(d), d).toBe(true);
    expect(isGenericDescription('Shelfwise pricing page with three plans; Growth is $49 per store per month.')).toBe(false);
    expect(nothingToSave('A screenshot of a desktop', 'Finder  File')).toBe(true);
    // either half alone is enough to keep it
    expect(nothingToSave('A screenshot of a desktop', OCR_TEXT)).toBe(false);
    expect(nothingToSave('A whiteboard sketch of the rollout: staging first, then two pilot stores.', '')).toBe(false);
  });
});

describe('drop rule 2 — a number must be in the OCR text', () => {
  it('drops facts whose numbers the OCR did not see, in the statement or the quote', () => {
    const facts = [
      { statement: 'Growth costs $49 per store per month.', quote: '$49 / store / month' },
      { statement: 'Growth costs $59 per store per month.', quote: 'Growth plan' },
      { statement: 'Enterprise is for chains.', quote: 'More than 400 stores' },
      { statement: 'Annual billing saves 15%.', quote: 'Annual billing saves 15%.' },
      { statement: 'The Growth plan is highlighted.', quote: 'Growth plan is highlighted' },
    ];
    const { kept, dropped } = numberGate(facts, OCR_TEXT);
    expect(kept.map((f) => f.statement)).toEqual(['Growth costs $49 per store per month.', 'Annual billing saves 15%.', 'The Growth plan is highlighted.']);
    expect(dropped.map((d) => d.missing)).toEqual([['59'], ['400']]);
  });

  it('compares numbers, not strings: separators and trailing zeros do not matter, partial digits do', () => {
    expect(numbersIn('$1,200.50 for 3 stores in 2026-09, v2.0')).toEqual(['1200.50', '3', '2026', '09', '2']);
    expect(numberGate([{ statement: 'It costs $1200.', quote: 'x'.repeat(8) }], 'Total: $1,200.00').kept).toHaveLength(1);
    expect(numberGate([{ statement: 'It costs $4.', quote: 'x'.repeat(8) }], '$49').kept).toHaveLength(0);
    expect(numberGate([{ statement: 'It costs $49.', quote: 'x'.repeat(8) }], '').kept).toHaveLength(0);
  });
});

describe('note turns and title', () => {
  it('builds the turns of Spec 03 §4 in order, skipping what is absent', () => {
    expect(noteTurns('A pricing page.', 'Per-store billing', 'competitor')).toEqual([
      { role: 'note', text: 'competitor' },
      { role: 'note', text: 'A pricing page.' },
      { role: 'note', text: 'Text in image: Per-store billing' },
    ]);
    expect(noteTurns('', 'Per-store billing')).toEqual([{ role: 'note', text: 'Text in image: Per-store billing' }]);
    expect(titleFrom('Shelfwise pricing page showing three plans: Starter, Growth and Enterprise. Growth is highlighted.', '')).toBe('Shelfwise pricing page showing three plans');
    expect(titleFrom('', 'Pricing that follows your stores\nThree plans.')).toBe('Pricing that follows your stores');
  });
});

describe('ScreenshotService', () => {
  afterEach(() => { for (const k of ['FAKE_SHOT', 'FAKE_OCR', 'FAKE_OCR_FAIL']) delete process.env[k]; });

  function make(over: Partial<ScreenshotDeps> & { described?: DescribeOutput | null } = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'okt-shot-'));
    const calls = { describe: [] as { ocr_text: string; mime_type: string; base64: string }[], extract: [] as { role: string; text: string }[][], hidden: 0, shown: 0 };
    const described = over.described === undefined ? { description: 'Shelfwise pricing page with three plans; Growth is billed per store.', visible_text: 'Growth\n$49 / store / month\nPer-store billing', entities: ['Shelfwise', '$49'], status: 'ok' as const } : over.described;
    const svc = new ScreenshotService({
      tmpDir,
      ocrBinary: process.execPath,
      ocrPrefixArgs: [TOOL, 'ocr'],
      screencapture: { binary: process.execPath, prefixArgs: [TOOL, 'screencapture'] },
      sips: null,
      beforeInteractive: () => void (calls.hidden += 1),
      afterInteractive: () => void (calls.shown += 1),
      describe: async (input) => { calls.describe.push(input); return described; },
      extract: async (turns) => {
        calls.extract.push(turns);
        return { status: 'ok', facts: [{ kind: 'fact', statement: 'Growth costs $49 per store per month.', quote: '$49 / store / month' }, { kind: 'fact', statement: 'Growth costs $99 per year.', quote: 'Per-store billing' }] };
      },
      ...over,
    });
    return { svc, tmpDir, calls };
  }

  it('Esc in the picker → {cancelled:true}: no file, no OCR, no model call; overlays hidden and shown again', async () => {
    process.env['FAKE_SHOT'] = 'esc';
    const { svc, tmpDir, calls } = make();
    expect(await svc.capture({ mode: 'interactive' })).toEqual({ cancelled: true });
    expect(calls).toMatchObject({ describe: [], extract: [], hidden: 1, shown: 1 });
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('interactive capture: spawns `screencapture -i -x -t png <tmp>.png`, reads it, applies the number rule', async () => {
    process.env['FAKE_OCR'] = OCR_TEXT;
    const { svc, tmpDir, calls } = make();
    const r = await svc.capture({ mode: 'interactive' });
    if (!('facts' in r)) throw new Error(JSON.stringify(r));
    expect(r.image_path.startsWith(tmpDir) && r.image_path.endsWith('.png') && existsSync(r.image_path)).toBe(true);
    expect(r).toMatchObject({ vision: 'ok', title: 'Shelfwise pricing page with three plans', visible_text: 'Growth\n$49 / store / month\nPer-store billing', entities: ['Shelfwise', '$49'] });
    expect(r.facts.map((f) => f.statement)).toEqual(['Growth costs $49 per store per month.']);
    expect(r.dropped_facts).toEqual([{ statement: 'Growth costs $99 per year.', reason: 'number not in the OCR text: 99' }]);
    // the vision model is GIVEN the OCR text, and extract sees description then "Text in image: …"
    expect(calls.describe[0]).toMatchObject({ ocr_text: OCR_TEXT, mime_type: 'image/png' });
    expect(calls.extract[0]!.map((t) => t.text.slice(0, 14))).toEqual(['Shelfwise pric', 'Text in image:']);
  });

  it('file mode keeps the original where it is; without the vision projector OCR + extract still run', async () => {
    process.env['FAKE_OCR'] = OCR_TEXT;
    const dir = mkdtempSync(join(tmpdir(), 'okt-img-'));
    const image = join(dir, 'pricing.png');
    copyFileSync(PNG, image);
    const { svc, calls } = make({ described: null });
    const r = await svc.capture({ mode: 'file', path: image });
    expect(r).toMatchObject({ image_path: image, vision: 'unavailable', description: '', visible_text: OCR_TEXT, title: 'Growth' });
    expect(calls.extract[0]).toEqual([{ role: 'note', text: `Text in image: ${OCR_TEXT}` }]);
    expect(existsSync(image)).toBe(true);
    expect(await svc.capture({ mode: 'file', path: join(dir, 'missing.png') })).toMatchObject({ error: 'failed' });
    expect(await svc.capture({ mode: 'file', path: '/etc/passwd' })).toMatchObject({ error: 'failed', message: expect.stringContaining('image file') });
  });

  it('generic description + almost no text → nothing_to_save, no extract call, the temporary screenshot removed', async () => {
    process.env['FAKE_OCR'] = 'Finder';
    const { svc, tmpDir, calls } = make({ described: { description: 'A screenshot of a desktop', visible_text: '', entities: [], status: 'ok' } });
    expect(await svc.capture({ mode: 'interactive' })).toMatchObject({ nothing_to_save: true, nothing: true, facts: [], description: '', visible_text: '' });
    expect(calls.extract).toEqual([]);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('a denied Screen Recording permission is a typed permission_denied before anything is spawned', async () => {
    const { svc, calls } = make({ screenAccess: () => 'denied' });
    expect(await svc.capture({ mode: 'interactive' })).toMatchObject({ error: 'permission_denied', message: expect.stringContaining('Screen Recording') });
    expect(calls.hidden).toBe(0);
  });

  it('openkt-ocr failing (exit ≠ 0 with a JSON error) is noted, and numbers then have no witness', async () => {
    process.env['FAKE_OCR_FAIL'] = '1';
    const { svc } = make();
    await expect(svc.ocr(PNG)).rejects.toThrow('cannot read an image');
    const r = await svc.capture({ mode: 'file', path: PNG });
    if (!('facts' in r)) throw new Error(JSON.stringify(r));
    expect(r.notes.join(' ')).toContain('openkt-ocr failed');
    expect(r.facts).toEqual([]);
    expect(() => parseOcrOutput('{"error":"boom"}')).toThrow('boom');
  });
});

describe('browser-permission policy', () => {
  const app = 'file:///Applications/OpenKT.app/Contents/Resources/app.asar/dist/index.html';
  it('lets the app’s own pages open the microphone, and nothing else', () => {
    expect(allowPermission('media', { requestingUrl: app, mediaTypes: ['audio'] })).toBe(true);
    expect(allowPermission('media', { requestingUrl: 'file:///', mediaTypes: ['audio'] })).toBe(true); // the check handler passes an origin
    expect(allowPermission('media', { requestingUrl: app, mediaTypes: ['video'] })).toBe(false);
    expect(allowPermission('media', { requestingUrl: app, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(allowPermission('media', { requestingUrl: app, mediaTypes: [] })).toBe(false);
    expect(allowPermission('media', { requestingUrl: app, mediaTypes: ['unknown'] })).toBe(false);
    for (const p of ['geolocation', 'notifications', 'display-capture', 'clipboard-read', 'openExternal', 'fullscreen']) expect(allowPermission(p, { requestingUrl: app, mediaTypes: ['audio'] }), p).toBe(false);
  });
  it('refuses every other origin; in dev only the dev server counts as the app', () => {
    expect(allowPermission('media', { requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] })).toBe(false);
    expect(allowPermission('media', { requestingUrl: '', mediaTypes: ['audio'] })).toBe(false);
    expect(isAppUrl('http://localhost:5173/#/overlay/voice', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
    expect(isAppUrl('file:///x/index.html', 'http://localhost:5173')).toBe(false);
    expect(allowPermission('media', { requestingUrl: 'http://localhost:5173/', mediaTypes: ['audio'], devUrl: 'http://localhost:5173' })).toBe(true);
  });
});
