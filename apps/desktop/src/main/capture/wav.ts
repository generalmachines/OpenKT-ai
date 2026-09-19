/** 16 kHz mono PCM16 → a RIFF/WAVE file. No `electron` import: runs under plain Node in CI. */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34); // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function encodeWav(pcm16: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const even = pcm16.length - (pcm16.length % BYTES_PER_SAMPLE);
  return Buffer.concat([wavHeader(even, sampleRate), pcm16.subarray(0, even)]);
}

export function durationMs(pcmBytes: number, sampleRate = SAMPLE_RATE): number {
  return Math.round((pcmBytes / BYTES_PER_SAMPLE / sampleRate) * 1000);
}

/** Root mean square of the samples, 0..1. Silence is ~0; quiet speech is > 0.005. */
export function rmsLevel(pcm16: Buffer): number {
  const n = Math.floor(pcm16.length / BYTES_PER_SAMPLE);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** The `data` chunk of a PCM16 WAV file (CI feeds a `say` + `afconvert` clip through the voice module). */
export function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(off + 10);
      sampleRate = wav.readUInt32LE(off + 12);
      if (wav.readUInt16LE(off + 8) !== 1 || wav.readUInt16LE(off + 22) !== 16) throw new Error('WAV is not PCM16');
    } else if (id === 'data') {
      return { pcm: wav.subarray(off + 8, Math.min(wav.length, off + 8 + size)), sampleRate, channels };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
