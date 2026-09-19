/**
 * Microphone audio → what whisper wants: 16 kHz, mono, signed 16-bit PCM.
 * Pure functions and one small stateful class, so they can be unit-tested
 * without an AudioContext.
 */
export const TARGET_RATE = 16_000;

/**
 * Streaming downsampler. Each output sample is the mean of the input samples
 * it spans (a box low-pass, enough to keep speech clean at 48 → 16 kHz).
 * Positions are absolute sample counts, so chunk boundaries never click or
 * drift however the audio arrives. Rates at or below the target pass through / interpolate.
 */
export class Downsampler {
  private buf = new Float32Array(0);
  /** Absolute input index of buf[0], and the absolute index of the next output sample. */
  private base = 0;
  private n = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate = TARGET_RATE,
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError('sample rates must be positive');
  }

  /** Where output sample `n` starts in the input. Integer products stay exact, so chunking cannot move a window edge. */
  private at(n: number): number {
    return (n * this.inputRate) / this.outputRate;
  }

  process(chunk: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return chunk.slice();
    const buf = new Float32Array(this.buf.length + chunk.length);
    buf.set(this.buf);
    buf.set(chunk, this.buf.length);
    const end = this.base + buf.length;

    const out: number[] = [];
    if (this.inputRate > this.outputRate) {
      for (;;) {
        const from = Math.floor(this.at(this.n));
        const to = Math.max(from + 1, Math.floor(this.at(this.n + 1)));
        if (to > end) break;
        let sum = 0;
        for (let i = from; i < to; i += 1) sum += buf[i - this.base]!;
        out.push(sum / (to - from));
        this.n += 1;
      }
    } else {
      // Upsampling (an 8 kHz headset): linear interpolation.
      for (;;) {
        const pos = this.at(this.n);
        const i = Math.floor(pos);
        if (i + 1 >= end) break;
        const t = pos - i;
        out.push(buf[i - this.base]! * (1 - t) + buf[i + 1 - this.base]! * t);
        this.n += 1;
      }
    }
    const keepFrom = Math.min(end, Math.floor(this.at(this.n)));
    this.buf = buf.slice(keepFrom - this.base);
    this.base = keepFrom;
    return Float32Array.from(out);
  }
}

/** One-shot convenience over `Downsampler`. */
export function resample(input: Float32Array, inputRate: number, outputRate = TARGET_RATE): Float32Array {
  return new Downsampler(inputRate, outputRate).process(input);
}

/** [-1, 1] floats → little-endian PCM16, clamped (a hot mic must not wrap around). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

/** Root-mean-square of a block, 0..1. */
export function rms(block: Float32Array): number {
  if (!block.length) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i]! * block[i]!;
  return Math.sqrt(sum / block.length);
}

/** RMS → a 0..1 meter value on a rough dB scale (-60 dB → 0, -6 dB → 1), so quiet speech still moves the bars. */
export function meter(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.max(0, Math.min(1, (db + 60) / 54));
}
