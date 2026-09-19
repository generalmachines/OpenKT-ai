import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperJson } from '../../src/main/capture/transcript';
import { VoiceService, type VoiceNoteSession } from '../../src/main/capture/voice';
import { durationMs, encodeWav, pcmFromWav, rmsLevel, wavHeader } from '../../src/main/capture/wav';
import { Whisper } from '../../src/main/capture/whisper';

const FAKE = join(__dirname, 'fixtures/fake-whisper-cli.mjs');

/** A 220 Hz tone: loud enough not to be "silence". */
function tone(ms: number): Buffer {
  const n = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  return b;
}

describe('WAV writer', () => {
  it('writes a 44-byte PCM16 mono 16 kHz header whose sizes match the data', () => {
    const h = wavHeader(32000);
    expect(h.length).toBe(44);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(36 + 32000);
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(h.readUInt16LE(20)).toBe(1); // PCM
    expect(h.readUInt16LE(22)).toBe(1); // mono
    expect(h.readUInt32LE(24)).toBe(16000);
    expect(h.readUInt32LE(28)).toBe(32000); // byte rate
    expect(h.readUInt16LE(32)).toBe(2); // block align
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.toString('ascii', 36, 40)).toBe('data');
    expect(h.readUInt32LE(40)).toBe(32000);
  });

  it('round-trips, drops a dangling odd byte, and measures duration and level', () => {
    const pcm = tone(500);
    const wav = encodeWav(Buffer.concat([pcm, Buffer.from([7])]));
    expect(wav.length).toBe(44 + pcm.length);
    const back = pcmFromWav(wav);
    expect(back).toMatchObject({ sampleRate: 16000, channels: 1 });
    expect(back.pcm.equals(pcm)).toBe(true);
    expect(durationMs(pcm.length)).toBe(500);
    expect(rmsLevel(pcm)).toBeGreaterThan(0.1);
    expect(rmsLevel(Buffer.alloc(3200))).toBe(0);
    expect(() => pcmFromWav(Buffer.from('not a wav file at all, sorry'))).toThrow('RIFF');
  });
});

describe('whisper JSON', () => {
  const json = (texts: string[], language = 'en') =>
    JSON.stringify({ result: { language }, transcription: texts.map((text, i) => ({ offsets: { from: i * 1000, to: (i + 1) * 1000 }, text })) });

  it('maps offsets to t0_ms / t1_ms, trims, joins, and reads the detected language', () => {
    const p = parseWhisperJson(json([' We decided to quote Northgate per store.', '  Ana sends   the quote.'], 'en'));
    expect(p.segments).toEqual([
      { t0_ms: 0, t1_ms: 1000, text: 'We decided to quote Northgate per store.' },
      { t0_ms: 1000, t1_ms: 2000, text: 'Ana sends the quote.' },
    ]);
    expect(p.text).toBe('We decided to quote Northgate per store. Ana sends the quote.');
    expect(p.language).toBe('en');
    expect(parseWhisperJson(json([' ราคาต่อสาขา'], 'th'))).toMatchObject({ language: 'th', text: 'ราคาต่อสาขา' });
  });

  it('drops non-speech markers, and rejects output that is not whisper JSON', () => {
    expect(parseWhisperJson(json([' [BLANK_AUDIO]', ' (silence)', ' [Music]', ' ♪♪'])).text).toBe('');
    expect(parseWhisperJson(json([' [BLANK_AUDIO]', ' Hello [sic] there.'])).text).toBe('Hello [sic] there.');
    expect(() => parseWhisperJson('whisper_init failed')).toThrow('invalid JSON');
    expect(() => parseWhisperJson('{"result":{}}')).toThrow('transcription');
  });
});

describe('cleanup is code only', () => {
  it('removes English filler sounds with the commas they brought, and keeps every real word', () => {
    expect(cleanTranscript('Um, we decided to, uh, quote Northgate per store. Uh, Ana sends the revised quote, um, before Friday.', 'en')).toBe(
      'We decided to quote Northgate per store. Ana sends the revised quote before Friday.',
    );
    expect(cleanTranscript('The umbrella is erm... here, hmm.', 'en')).toBe('The umbrella is here.');
    // words that merely contain a filler, and hyphenated ones, are left alone
    expect(cleanTranscript('Her summer album: uh-huh, the drum era.', 'en')).toBe('Her summer album: uh-huh, the drum era.');
    // "like", "you know", "so" carry meaning often enough to stay
    expect(cleanTranscript('So, you know, it is like forty stores.', 'en')).toBe('So, you know, it is like forty stores.');
  });

  it('collapses repeated words in any script, but not numbers, and only English loses fillers', () => {
    expect(cleanTranscript('I, I, I think the the quote is fine.', 'en')).toBe('I think the quote is fine.');
    expect(cleanTranscript('Call 5 5 5 0 1 0 0.', 'en')).toBe('Call 5 5 5 0 1 0 0.');
    expect(cleanTranscript('ไป ไป ตลาด', 'th')).toBe('ไป ตลาด');
    expect(cleanTranscript('मैं मैं कल आऊँगा', 'hi')).toBe('मैं कल आऊँगा');
    expect(cleanTranscript('Er ist um neun da.', 'de')).toBe('Er ist um neun da.');
  });
});

describe('Whisper runner', () => {
  afterEach(() => { delete process.env['FAKE_WHISPER']; delete process.env['FAKE_LOG']; });

  it('passes the flags of the pinned tag, and falls back to the CPU (-ng) after a GPU crash — and stays there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'okt-whisper-'));
    const wav = join(dir, 'a.wav');
    require('node:fs').writeFileSync(wav, encodeWav(tone(2000)));
    process.env['FAKE_LOG'] = join(dir, 'calls.log');
    process.env['FAKE_WHISPER'] = 'gpu-crash';
    const logs: string[] = [];
    const whisper = new Whisper({ binary: process.execPath, prefixArgs: [FAKE], model: '/models/ggml-base.bin', threads: 4, log: (l) => logs.push(l) });
    expect(whisper.args('/t/a.wav', '/t/a', 'auto', false).slice(1)).toEqual(['-m', '/models/ggml-base.bin', '-f', '/t/a.wav', '-l', 'auto', '-t', '4', '-oj', '-of', '/t/a', '-np']);

    const first = await whisper.transcribe(wav, 'auto', 2000);
    expect(first.usedGpu).toBe(false);
    expect(first.text).toContain('Northgate per store');
    expect(whisper.cpuOnly).toBe(true);
    expect(logs.join('\n')).toContain('retrying on the CPU');
    await whisper.transcribe(wav, 'auto', 2000);
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(calls.map((c) => c.includes('-ng'))).toEqual([false, true, true]);
    expect(existsSync(join(dir, 'a.json'))).toBe(false); // whisper's JSON file is cleaned up

    process.env['FAKE_WHISPER'] = 'fail';
    await expect(whisper.transcribe(wav)).rejects.toThrow(/exited code=2/);
  });
});

describe('VoiceService', () => {
  afterEach(() => { delete process.env['FAKE_WHISPER']; });
  const note: VoiceNoteSession = { title: 'Northgate quote', summary: 's', facts: [{ kind: 'decision', statement: 'Quote per store.', quote: 'quote Northgate per store' }], status: 'ok' };

  function make(over: { askMicrophone?: () => Promise<boolean>; modelReady?: boolean } = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'okt-voice-'));
    const seen: string[] = [];
    const svc = new VoiceService({
      whisper: new Whisper({ binary: process.execPath, prefixArgs: [FAKE], model: 'm.bin', threads: 2 }),
      tmpDir,
      modelReady: async () => over.modelReady ?? true,
      askMicrophone: over.askMicrophone,
      toNote: async (text) => { seen.push(text); return note; },
    });
    return { svc, tmpDir, seen };
  }
  const feed = async (svc: VoiceService, pcm: Buffer) => {
    const id = (await svc.begin()) as string;
    for (let off = 0; off < pcm.length; off += 8000) {
      const piece = pcm.subarray(off, off + 8000);
      svc.chunk(id, piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength)); // ArrayBuffer, as over IPC
    }
    return id;
  };

  it('begin → chunk → end: transcript with segments and duration, WAV deleted; toSession runs on the cleaned text once', async () => {
    process.env['FAKE_WHISPER'] = 'fillers';
    const { svc, tmpDir, seen } = make();
    const id = await feed(svc, tone(7000));
    const r = await svc.end(id, { language: 'auto' });
    expect(r).toMatchObject({ language: 'en', duration_ms: 7000, text: 'We decided to quote Northgate per store. Ana sends the revised quote before Friday.' });
    expect('raw_text' in r && r.raw_text).toContain('Um, we decided');
    expect('segments' in r && r.segments).toHaveLength(2);
    expect(readdirSync(tmpDir)).toEqual([]);
    expect(await svc.toSession(id)).toEqual(note);
    expect(seen).toEqual(['We decided to quote Northgate per store. Ana sends the revised quote before Friday.']);
    expect(await svc.toSession(id)).toMatchObject({ error: 'unknown_id' });
    expect(svc.activeCount).toBe(0);
  });

  it('keepAudio keeps the WAV and says where; Uint8Array chunks work too', async () => {
    const { svc, tmpDir } = make();
    const id = (await svc.begin()) as string;
    svc.chunk(id, new Uint8Array(tone(2000)));
    const r = await svc.end(id, { keepAudio: true });
    expect(r).toMatchObject({ audio_path: join(tmpDir, `${id}.wav`), duration_ms: 2000 });
    expect(pcmFromWav(readFileSync(join(tmpDir, `${id}.wav`))).pcm.length).toBe(64000);
  });

  it('a clip under 1.5 s, silence, or a transcript with no words creates nothing', async () => {
    const { svc, tmpDir } = make();
    expect(await svc.end(await feed(svc, tone(1000)))).toEqual({ empty: true, duration_ms: 1000, reason: 'too_short' });
    expect(await svc.end(await feed(svc, Buffer.alloc(16000 * 2 * 3)))).toEqual({ empty: true, duration_ms: 3000, reason: 'silence' });
    process.env['FAKE_WHISPER'] = 'blank';
    expect(await svc.end(await feed(svc, tone(3000)))).toEqual({ empty: true, duration_ms: 3000, reason: 'no_speech' });
    expect(readdirSync(tmpDir)).toEqual([]);
    expect(svc.activeCount).toBe(0);
  });

  it('maps a refused microphone to a typed permission_denied, and a missing model to not_ready', async () => {
    const denied = make({ askMicrophone: async () => false });
    expect(await denied.svc.begin()).toMatchObject({ error: 'permission_denied', message: expect.stringContaining('Microphone') });
    expect(denied.svc.activeCount).toBe(0);
    const thrown = make({ askMicrophone: async () => { throw new Error('tcc'); } });
    expect(await thrown.svc.begin()).toMatchObject({ error: 'permission_denied' });

    const cold = make({ modelReady: false });
    expect(await cold.svc.end(await feed(cold.svc, tone(2000)))).toMatchObject({ error: 'not_ready' });
    expect(await cold.svc.end('nope')).toMatchObject({ error: 'unknown_id' });
  });

  it('a whisper failure is a typed error, not a crash, and leaves no audio behind', async () => {
    process.env['FAKE_WHISPER'] = 'fail';
    const { svc, tmpDir } = make();
    expect(await svc.end(await feed(svc, tone(2000)))).toMatchObject({ error: 'failed', message: expect.stringContaining('whisper-cli') });
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});
