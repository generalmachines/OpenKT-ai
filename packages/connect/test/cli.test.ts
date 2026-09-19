import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PKG = join(__dirname, '..');
const BIN = join(PKG, 'bin', 'openkt-connect.mjs');
let home: string;

beforeAll(() => {
  // The bin runs from dist/, like the published package.
  execFileSync(process.execPath, [join(PKG, 'scripts', 'embed-assets.mjs')], { stdio: 'ignore' });
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(PKG, 'tsconfig.build.json')], { stdio: 'inherit' });
}, 120_000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'okt-cli-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function cli(args: string[], input = '') {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENKT_')) env[k] = v;
  const r = spawnSync('node', [BIN, ...args, '--json'], { env: { ...env, HOME: home, OPENKT_NO_KEYCHAIN: '1', XDG_CONFIG_HOME: join(home, '.config') }, input, encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout || 'null') as Record<string, unknown> & { error?: { code: string; hint?: string } } };
}

describe('openkt-connect (JSON-first CLI)', () => {
  it('list and status are JSON with every tool', () => {
    mkdirSync(join(home, '.claude'));
    const list = cli(['list']);
    expect(list.code).toBe(0);
    const tools = list.json['tools'] as { id: string; detected: { installed: boolean } }[];
    expect(tools[0]).toMatchObject({ id: 'claude-code', detected: { installed: true } });
    const status = cli(['status']);
    expect(status.json['credentials']).toEqual({ server: 'https://api.openkt.ai', signed_in: false, source: 'none' });
  });

  it('connect, dry-run and undo', () => {
    mkdirSync(join(home, '.codex'));
    const dry = cli(['connect', 'codex', '--dry-run']);
    expect((dry.json['plan'] as unknown[]).length).toBe(3);
    const on = cli(['connect', 'codex']);
    expect(on.code).toBe(0);
    expect((on.json['tool'] as { status: string }).status).toBe('connected');
    const off = cli(['connect', 'codex', '--undo']);
    expect((off.json['tool'] as { status: string }).status).toBe('not-connected');
  });

  it('errors are {error:{code,message,hint}} with Spec 06 exit codes', () => {
    expect(cli(['connect']).code).toBe(2);
    const unknown = cli(['connect', 'notepad']);
    expect(unknown.code).toBe(4);
    expect(unknown.json.error?.code).toBe('unknown_tool');
    expect(cli(['connect', 'cursor']).json.error?.code).toBe('not_installed');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), '{ broken');
    const bad = cli(['connect', 'claude-code']);
    expect(bad.code).toBe(6);
    expect(bad.json.error?.code).toBe('config_unreadable');
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ broken');
  });

  it('auth set stores a token for the hooks; auth logout removes it', () => {
    expect(cli(['auth', 'set', '--token-stdin', '--server', 'https://kt.example.com'], 'okt_pat_abc123\n').json).toEqual({ server: 'https://kt.example.com', signed_in: true, source: 'file' });
    expect(JSON.parse(readFileSync(join(home, '.openkt', 'credentials.json'), 'utf8'))).toEqual({ server: 'https://kt.example.com', token: 'okt_pat_abc123' });
    expect(cli(['auth', 'set', '--token-stdin'], 'not-a-token').code).toBe(6);
    cli(['auth', 'logout']);
    expect(cli(['auth', 'status']).json['signed_in']).toBe(false);
  });

  it('hook runs the Node core and prints nothing when signed out', () => {
    const r = spawnSync('node', [BIN, 'hook', 'claude-code', 'prompt'], { env: { PATH: process.env['PATH'] ?? '', HOME: home, OPENKT_NO_KEYCHAIN: '1' }, input: JSON.stringify({ session_id: 'x', prompt: 'hello there, anything?' }), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('folders map writes the mapping the hooks read', () => {
    const r = cli(['folders', 'map', join(home, 'code', 'acme'), 'space-1', '--name', 'Acme']);
    expect(r.json['folders']).toEqual([{ path: join(home, 'code', 'acme'), space_id: 'space-1', space_name: 'Acme', state: 'mapped' }]);
  });
});
