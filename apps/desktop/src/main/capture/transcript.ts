/**
 * whisper-cli's `-oj` JSON → segments, and the CODE-ONLY cleanup of Spec 03 §3:
 * fillers from a fixed list (English only) and collapsed repeats. A model never
 * rewrites what the person said — the quote gate needs the words verbatim.
 */
export interface Segment { t0_ms: number; t1_ms: number; text: string }
export interface ParsedTranscript { text: string; segments: Segment[]; language: string }

/** whisper marks non-speech as a whole bracketed segment: [BLANK_AUDIO], (silence), [Music], ♪ … */
const NON_SPEECH = /^\s*(?:[[(][^\])]*[\])]|[♪♫\s.…-]+)\s*$/;

export function parseWhisperJson(raw: string): ParsedTranscript {
  let body: { result?: { language?: unknown }; transcription?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch (e) {
    throw new Error(`whisper wrote invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(body.transcription)) throw new Error('whisper JSON has no "transcription" array');
  const segments: Segment[] = [];
  for (const item of body.transcription as { offsets?: { from?: unknown; to?: unknown }; text?: unknown }[]) {
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!text || NON_SPEECH.test(text)) continue;
    const t0 = Number(item.offsets?.from);
    const t1 = Number(item.offsets?.to);
    segments.push({ t0_ms: Number.isFinite(t0) ? t0 : 0, t1_ms: Number.isFinite(t1) ? t1 : 0, text });
  }
  const language = typeof body.result?.language === 'string' && body.result.language ? body.result.language : 'auto';
  return { text: segments.map((s) => s.text).join(' '), segments, language };
}

/** Sounds, not words: removing them cannot change what was said. Deliberately excludes "like", "you know", "so". */
export const ENGLISH_FILLERS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'eh', 'hmm', 'hm', 'mhm', 'mm', 'mmm'] as const;

const WORDS = ENGLISH_FILLERS.join('|');
/** A filler that opens a sentence: the next word takes over the capital letter. */
const LEADING_FILLER = new RegExp(`(^|[.!?…]\\s+)(?:(?:${WORDS})[,;…]*\\s+)+(\\p{L})`, 'giu');
/** Mid-sentence: the filler goes, with the commas that only existed because of it. */
const FILLER = new RegExp(`(?:[,;]\\s*)?(?<![\\p{L}\\p{N}'’-])(?:${WORDS})(?![\\p{L}\\p{N}'’-])(?:[,;]|…|\\.{3})?`, 'giu');
/** "the the" → "the", "I, I, I think" → "I think". Letters, marks and digits of any script (Devanagari vowel signs are marks); single words only, never phrases or bare numbers. */
const REPEAT = /(?<![\p{L}\p{M}\p{N}'’])((?=[\p{N}'’]*\p{L})[\p{L}\p{M}\p{N}'’]+)(?:[\s,]+\1(?![\p{L}\p{M}\p{N}'’]))+/giu;

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/([.!?…])\s*[,;]\s*/g, '$1 ')
    .replace(/^[\s,;]+/, '')
    .trim();
}

export function cleanTranscript(text: string, language: string): string {
  let out = text;
  if (language === 'en' || language === 'english') {
    out = out.replace(LEADING_FILLER, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
    out = out.replace(FILLER, ' ');
  }
  return tidy(out.replace(REPEAT, '$1'));
}
