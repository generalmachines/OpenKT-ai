// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Downsampler, floatToPcm16, meter, resample, rms } from '../../src/capture/audio';

const sine = (hz: number, rate: number, seconds: number, amp = 0.8) => Float32Array.from({ length: Math.round(rate * seconds) }, (_v, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Dominant frequency by counting zero crossings. */
const frequency = (a: Float32Array, rate: number) => {
  let crossings = 0;
  for (let i = 1; i < a.length; i += 1) if (a[i - 1]! <= 0 !== a[i]! <= 0) crossings += 1;
  return (crossings / 2 / a.length) * rate;
};

describe('resample → 16 kHz', () => {
  it('48 kHz sine: a third of the length, same pitch, peak within 2%', () => {
    const out = resample(sine(440, 48_000, 1), 48_000);
    expect(out.length).toBe(16_000);
    expect(peak(out)).toBeGreaterThan(0.8 * 0.98);
    expect(peak(out)).toBeLessThanOrEqual(0.8);
    expect(frequency(out, 16_000)).toBeCloseTo(440, -1);
  });

  it('44.1 kHz (non-integer ratio): length within one sample, peak within 3%', () => {
    const out = resample(sine(440, 44_100, 1), 44_100);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
    expect(peak(out)).toBeGreaterThan(0.8 * 0.97);
    expect(frequency(out, 16_000)).toBeCloseTo(440, -1);
  });

  it('streaming in odd-sized chunks equals one shot (no drift or clicks at chunk edges)', () => {
    const input = sine(300, 44_100, 0.5);
    const whole = resample(input, 44_100);
    const ds = new Downsampler(44_100);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 1777) parts.push(...ds.process(input.subarray(i, i + 1777)));
    expect(parts.length).toBe(whole.length);
    expect(Math.max(...parts.map((v, i) => Math.abs(v - whole[i]!)))).toBeLessThan(1e-6);
  });

  it('16 kHz passes through untouched; 8 kHz is interpolated up', () => {
    const same = sine(440, 16_000, 0.1);
    expect(Array.from(resample(same, 16_000))).toEqual(Array.from(same));
    const up = resample(sine(200, 8_000, 1), 8_000);
    expect(Math.abs(up.length - 16_000)).toBeLessThanOrEqual(2);
    expect(frequency(up, 16_000)).toBeCloseTo(200, -1);
  });

  it('attenuates what 16 kHz cannot carry (a 12 kHz tone) instead of aliasing it at full strength', () => {
    expect(peak(resample(sine(12_000, 48_000, 0.25), 48_000))).toBeLessThan(0.8 * 0.4);
  });
});

describe('floatToPcm16', () => {
  it('maps full scale, zero, and clamps overshoot', () => {
    expect(Array.from(floatToPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5, 1.7, -3])))).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768]);
  });

  it('is two little-endian bytes per sample', () => {
    const pcm = floatToPcm16(Float32Array.from([0.5, -1]));
    expect(pcm.byteLength).toBe(4);
    expect(new DataView(pcm.buffer).getInt16(0, true)).toBe(16384);
    expect(new DataView(pcm.buffer).getInt16(2, true)).toBe(-32768);
  });
});

describe('level meter', () => {
  it('rms of a sine is amp/√2; silence is 0', () => {
    expect(rms(sine(440, 16_000, 1, 1))).toBeCloseTo(Math.SQRT1_2, 3);
    expect(rms(new Float32Array(100))).toBe(0);
  });
  it('meter is 0 for silence, 1 for loud, monotonic between', () => {
    expect(meter(0)).toBe(0);
    expect(meter(1)).toBe(1);
    expect(meter(0.01)).toBeGreaterThan(0);
    expect(meter(0.1)).toBeGreaterThan(meter(0.01));
  });
});
