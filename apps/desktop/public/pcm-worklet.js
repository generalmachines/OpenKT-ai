/* Taps the microphone graph and posts mono Float32 blocks (~43 ms at 48 kHz) to the page.
   A real file, not a blob: the production CSP is script-src 'self'. */
class OpenKTPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.block.length - this.fill);
      this.block.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.block.length) {
        this.port.postMessage(this.block.slice(0));
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('openkt-pcm-tap', OpenKTPcmTap);
