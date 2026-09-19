import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBED_DIM, LlamaLocalAi, QUERY_PREFIX } from '../../src/main/local-ai/local-ai';
import { GIB, chooseModels, loadManifest } from '../../src/main/models/manifest';

// A fake `llama-server`: aborts on the first request unless started with `--device none`
// (what Metal does on a virtualised GPU), and echoes what it was asked to embed.
const FAKE = `#!/usr/bin/env node
const http = require('node:http');
const argv = process.argv;
const port = Number(argv[argv.indexOf('--port') + 1]);
const cpu = argv.includes('--device') && argv[argv.indexOf('--device') + 1] === 'none';
http.createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200).end('{"status":"ok"}');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!cpu && process.env.FAKE_GPU_BROKEN === '1') process.kill(process.pid, 'SIGABRT');
    const input = JSON.parse(body).input;
    const data = input.map((text, index) => ({ index, embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? text.length : 1)) }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, echo: input }));
  });
}).listen(port, '127.0.0.1');
`;

let ai: LlamaLocalAi | null = null;
afterEach(async () => { await ai?.stop(); ai = null; delete process.env['FAKE_GPU_BROKEN']; });

function make(): LlamaLocalAi {
  const dir = mkdtempSync(join(tmpdir(), 'okt-ai-'));
  writeFileSync(join(dir, 'llama-server'), FAKE);
  chmodSync(join(dir, 'llama-server'), 0o755);
  ai = new LlamaLocalAi({ llamaDir: dir, modelsDir: join(dir, 'models'), plan: chooseModels(loadManifest(), 16 * GIB) });
  return ai;
}

describe('LlamaLocalAi', () => {
  it('embed: unit-norm 1024-dim vectors, in order, on a loopback server', async () => {
    const a = make();
    const v = await a.embed(['a', 'bbbb'], 'document');
    expect(v.length).toBe(2);
    for (const x of v) {
      expect(x.length).toBe(EMBED_DIM);
      expect(Math.hypot(...x)).toBeCloseTo(1, 6);
    }
    expect(v[0]![0]).toBeLessThan(v[1]![0]!);
    expect((await a.status()).servers.embed).toMatchObject({ state: 'ready' });
    expect((await a.status()).cpuFallback).toBe(false);
  });

  it('queries carry the instruction prefix, documents do not', async () => {
    const a = make();
    const [q] = await a.embed(['x'], 'query');
    const [d] = await a.embed(['x'], 'document');
    // The fake encodes the input length in dimension 0.
    expect(q![0]! / q![1]!).toBeCloseTo(QUERY_PREFIX.length + 1, 5);
    expect(d![0]! / d![1]!).toBeCloseTo(1, 5);
  });

  it('a GPU crash restarts the servers on the CPU and the request succeeds', async () => {
    process.env['FAKE_GPU_BROKEN'] = '1';
    const a = make();
    const v = await a.embed(['hello'], 'document');
    expect(v[0]?.length).toBe(EMBED_DIM);
    const status = await a.status();
    expect(status.cpuFallback).toBe(true);
    expect(status.servers.embed.state).toBe('ready');
  });
});
