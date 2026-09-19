// One script for the macOS tools the screenshot pipeline spawns. argv[2] picks the role.
//   screencapture <…flags> <out.png>   FAKE_SHOT=esc → writes nothing (the person pressed Esc)
//   ocr <image>                        FAKE_OCR=<text> | FAKE_OCR_FAIL=1 → {"error"} + exit 3
import { writeFileSync } from 'node:fs';

const [role, ...rest] = process.argv.slice(2);
if (role === 'screencapture') {
  if (process.env.FAKE_SHOT !== 'esc') writeFileSync(rest.at(-1), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
} else if (role === 'ocr') {
  if (process.env.FAKE_OCR_FAIL === '1') { console.log(JSON.stringify({ error: `cannot read an image at ${rest[0]}` })); process.exit(3); }
  const lines = (process.env.FAKE_OCR ?? '').split('\n').filter(Boolean);
  console.log(JSON.stringify({ text: lines.join('\n'), lines: lines.map((text, i) => ({ text, x: 0.1, y: i / 10, w: 0.5, h: 0.05, confidence: 0.98 })) }));
}
