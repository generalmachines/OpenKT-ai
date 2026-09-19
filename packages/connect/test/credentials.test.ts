import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearCredentials, readCredentials, writeCredentials, type Keychain } from '../src/credentials.js';
import { homeEnv } from '../src/env.js';
import type { ConnectEnv } from '../src/types.js';

let home: string;
let env: ConnectEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'okt-cred-'));
  env = homeEnv(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeKeychain(): Keychain & { value: string | null } {
  const k = { value: null as string | null, get: async () => k.value, set: async (t: string) => void (k.value = t), delete: async () => void (k.value = null) };
  return k;
}

describe('credentials store', () => {
  it('defaults to the hosted server and reports signed out', async () => {
    expect(await readCredentials(env, null)).toEqual({ server: 'https://api.openkt.ai', token: null, source: 'none' });
  });

  it('without a keychain writes ~/.openkt/credentials.json with mode 600', async () => {
    expect(await writeCredentials(env, { server: 'https://kt.example.com/', token: 'okt_pat_abc' }, null)).toBe('file');
    const file = join(home, '.openkt/credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ server: 'https://kt.example.com', token: 'okt_pat_abc' });
    expect(await readCredentials(env, null)).toEqual({ server: 'https://kt.example.com', token: 'okt_pat_abc', source: 'file' });
    await clearCredentials(env, null);
    expect((await readCredentials(env, null)).token).toBeNull();
  });

  it('with a keychain keeps the token there and only the server in config.json', async () => {
    const kc = fakeKeychain();
    mkdirSync(join(home, '.openkt'), { recursive: true });
    writeFileSync(join(home, '.openkt/credentials.json'), JSON.stringify({ server: 'https://old', token: 'okt_pat_old' }));
    expect(await writeCredentials(env, { server: 'https://api.openkt.ai', token: 'okt_pat_new' }, kc)).toBe('keychain');
    expect(kc.value).toBe('okt_pat_new');
    expect(JSON.parse(readFileSync(join(home, '.openkt/config.json'), 'utf8'))).toEqual({ server: 'https://api.openkt.ai' });
    expect(readFileSync(join(home, '.openkt/credentials.json'), 'utf8')).not.toContain('okt_pat_old');
    expect(await readCredentials(env, kc)).toEqual({ server: 'https://api.openkt.ai', token: 'okt_pat_new', source: 'keychain' });
  });

  it('environment variables win', async () => {
    const e = homeEnv(home, { vars: { OPENKT_TOKEN: 'okt_pat_env', OPENKT_SERVER: 'http://localhost:4000/' } });
    expect(await readCredentials(e, fakeKeychain())).toEqual({ server: 'http://localhost:4000', token: 'okt_pat_env', source: 'env' });
  });
});
