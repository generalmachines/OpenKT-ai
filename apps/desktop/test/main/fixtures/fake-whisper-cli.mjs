// Mimics whisper-cli just enough: reads -f/-of/-l, writes <of>.json in the pinned tag's `-oj` shape.
//   FAKE_WHISPER=ok | gpu-crash (dies unless -ng) | fail | blank | fillers
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const mode = process.env.FAKE_WHISPER ?? 'ok';
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(argv)}\n`);
if (mode === 'fail') { console.error('whisper_init_from_file: failed to load model'); process.exit(2); }
if (mode === 'gpu-crash' && !argv.includes('-ng')) process.kill(process.pid, 'SIGABRT');

const wav = readFileSync(arg('-f'));
const ms = Math.round(((wav.length - 44) / 2 / 16000) * 1000);
const texts = mode === 'blank' ? [' [BLANK_AUDIO]'] : mode === 'fillers' ? [' Um, we decided to, uh, quote Northgate per store.', ' Ana sends the the revised quote before Friday.'] : [' We decided to quote Northgate per store, not per seat.', ' Ana sends the revised quote before Friday.'];
const step = Math.round(ms / texts.length);
writeFileSync(`${arg('-of')}.json`, JSON.stringify({
  systeminfo: 'fake', model: { type: 'base' }, params: { language: arg('-l') }, result: { language: 'en' },
  transcription: texts.map((text, i) => ({ timestamps: { from: '00:00:00,000', to: '00:00:00,000' }, offsets: { from: i * step, to: (i + 1) * step }, text })),
}));
