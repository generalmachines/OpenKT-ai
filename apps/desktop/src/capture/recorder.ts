/**
 * Microphone → 16 kHz mono PCM16 chunks, about every 250 ms, plus a level
 * for the meter. AudioWorklet when it loads, ScriptProcessor otherwise.
 * Runs in the voice overlay's renderer; nothing here touches the network.
 */
import { Downsampler, TARGET_RATE, floatToPcm16, meter, rms } from './audio';

export type RecorderFailure = 'permission' | 'no-microphone' | 'failed';

export class RecorderError extends Error {
  constructor(
    readonly kind: RecorderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

export interface RecorderOptions {
  onChunk(pcm16: ArrayBuffer): void;
  /** 0..1, already on a dB-ish scale. Called ~20×/s. */
  onLevel(level: number): void;
  chunkMs?: number;
}

export interface Recorder {
  /** Flushes the tail and releases the microphone. */
  stop(): Promise<void>;
  /** Releases the microphone and drops whatever was buffered. */
  cancel(): void;
}

export type StartRecorder = (opts: RecorderOptions) => Promise<Recorder>;

function failure(e: unknown): RecorderError {
  const name = e instanceof Error ? e.name : '';
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'NotAllowedError' || name === 'SecurityError') return new RecorderError('permission', message);
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new RecorderError('no-microphone', message);
  return new RecorderError('failed', message);
}

export const startRecorder: StartRecorder = async ({ onChunk, onLevel, chunkMs = 250 }) => {
  if (!navigator.mediaDevices?.getUserMedia) throw new RecorderError('failed', 'This window cannot reach a microphone.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (e) {
    throw failure(e);
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const down = new Downsampler(ctx.sampleRate, TARGET_RATE);
  const flushAt = Math.round((TARGET_RATE * chunkMs) / 1000);
  let pending: Int16Array[] = [];
  let pendingLen = 0;
  let live = true;

  const flush = () => {
    if (!pendingLen) return;
    const out = new Int16Array(pendingLen);
    let o = 0;
    for (const p of pending) {
      out.set(p, o);
      o += p.length;
    }
    pending = [];
    pendingLen = 0;
    onChunk(out.buffer);
  };

  const onBlock = (block: Float32Array) => {
    if (!live) return;
    onLevel(meter(rms(block)));
    const pcm = floatToPcm16(down.process(block));
    if (pcm.length) {
      pending.push(pcm);
      pendingLen += pcm.length;
    }
    if (pendingLen >= flushAt) flush();
  };

  // The graph must end at the destination or Chromium stops pulling it; the gain keeps it silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let tap: AudioNode;
  try {
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).href);
    const node = new AudioWorkletNode(ctx, 'openkt-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);
    tap = node;
  } catch {
    // Deprecated but everywhere; only reached if the worklet file fails to load.
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0).slice(0));
    tap = node;
  }
  source.connect(tap);
  tap.connect(mute);
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

  const release = () => {
    live = false;
    for (const t of stream.getTracks()) t.stop();
    source.disconnect();
    tap.disconnect();
    void ctx.close().catch(() => undefined);
  };

  return {
    async stop() {
      if (!live) return;
      flush();
      release();
    },
    cancel() {
      pending = [];
      pendingLen = 0;
      release();
    },
  };
};
