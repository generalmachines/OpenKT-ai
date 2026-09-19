// Mimics llama-server just enough for the supervisor: --port, /health, and scripted failure modes.
//   FAKE_MODE=ok | crash-after-ready | never-healthy | exit-immediately
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const host = process.argv[process.argv.indexOf('--host') + 1];
const mode = process.env.FAKE_MODE ?? 'ok';
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${process.pid} ${host} ${port}\n`);
if (mode === 'exit-immediately') { console.error('fake: cannot load model'); process.exit(3); }

createServer((req, res) => {
  if (req.url === '/health') {
    if (mode === 'never-healthy') { res.writeHead(503).end('{"status":"loading"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    if (mode === 'crash-after-ready') setTimeout(() => process.exit(9), 50);
    return;
  }
  res.writeHead(404).end();
}).listen(port, host);
