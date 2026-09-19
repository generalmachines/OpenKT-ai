import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readText, removeFile, writeAtomic } from './fsx.js';
import type { ConnectEnv } from './types.js';

/**
 * The credentials store shared by the kt CLI, the hook script and the desktop app (Spec 06 §2):
 * - macOS: keychain item service "openkt", account "default" holds the token; ~/.openkt/config.json holds {server}.
 * - elsewhere, or when the keychain cannot be used: ~/.openkt/credentials.json, mode 600, {server, token}.
 * Resolution: OPENKT_SERVER / OPENKT_TOKEN → keychain → credentials.json → https://api.openkt.ai.
 * The hook script (assets/openkt-hook.sh, okt_creds) resolves in the same order.
 */
export const DEFAULT_SERVER = 'https://api.openkt.ai';
const SERVICE = 'openkt';
const ACCOUNT = 'default';

export type CredentialSource = 'env' | 'keychain' | 'file' | 'none';

export interface Credentials {
  server: string;
  token: string | null;
  source: CredentialSource;
}

/** The macOS keychain through /usr/bin/security. Injectable so tests never touch a real keychain. */
export interface Keychain {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code === 'ENOENT' ? 127 : 1) : 0, stdout: String(stdout ?? '') });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export const macKeychain: Keychain = {
  async get() {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  },
  async set(token) {
    // `security -i` reads the command from stdin, so the token never appears in a process listing.
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) throw new Error('refusing to store a token with unexpected characters');
    const r = await run('/usr/bin/security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${token}\n`);
    if (r.code !== 0) throw new Error('the keychain refused the token');
  },
  async delete() {
    await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
  },
};

export function keychainFor(env: ConnectEnv): Keychain | null {
  return env.platform === 'darwin' && env.vars['OPENKT_NO_KEYCHAIN'] !== '1' ? macKeychain : null;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readText(file) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function readCredentials(env: ConnectEnv, keychain: Keychain | null = keychainFor(env)): Promise<Credentials> {
  const file = readJson(join(env.openktHome, 'credentials.json'));
  const config = readJson(join(env.openktHome, 'config.json'));
  const server = (str(env.vars['OPENKT_SERVER']) ?? str(config['server']) ?? str(file['server']) ?? DEFAULT_SERVER).replace(/\/+$/, '');
  const fromEnv = str(env.vars['OPENKT_TOKEN']);
  if (fromEnv) return { server, token: fromEnv, source: 'env' };
  const fromKeychain = keychain ? await keychain.get().catch(() => null) : null;
  if (fromKeychain) return { server, token: fromKeychain, source: 'keychain' };
  const fromFile = str(file['token']);
  if (fromFile) return { server, token: fromFile, source: 'file' };
  return { server, token: null, source: 'none' };
}

/** Store a sign-in for every tool on this machine. Returns where the token went. */
export async function writeCredentials(env: ConnectEnv, creds: { server: string; token: string }, keychain: Keychain | null = keychainFor(env)): Promise<'keychain' | 'file'> {
  const server = creds.server.replace(/\/+$/, '');
  if (keychain) {
    try {
      await keychain.set(creds.token);
      writeAtomic(join(env.openktHome, 'config.json'), `${JSON.stringify({ ...readJson(join(env.openktHome, 'config.json')), server }, null, 2)}\n`, 0o600);
      // A token left in the file from before would shadow nothing (the keychain wins) but should not linger.
      const file = readJson(join(env.openktHome, 'credentials.json'));
      if ('token' in file) writeAtomic(join(env.openktHome, 'credentials.json'), `${JSON.stringify({ server }, null, 2)}\n`, 0o600);
      return 'keychain';
    } catch {
      // Fall through to the file.
    }
  }
  writeAtomic(join(env.openktHome, 'credentials.json'), `${JSON.stringify({ server, token: creds.token }, null, 2)}\n`, 0o600);
  return 'file';
}

export async function clearCredentials(env: ConnectEnv, keychain: Keychain | null = keychainFor(env)): Promise<void> {
  if (keychain) await keychain.delete().catch(() => undefined);
  const file = readJson(join(env.openktHome, 'credentials.json'));
  if ('token' in file) {
    delete file['token'];
    if (Object.keys(file).length === 0) removeFile(join(env.openktHome, 'credentials.json'));
    else writeAtomic(join(env.openktHome, 'credentials.json'), `${JSON.stringify(file, null, 2)}\n`, 0o600);
  }
}
