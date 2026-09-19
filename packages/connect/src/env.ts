import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ConnectEnv } from './types.js';

/** The real machine. Tests build their own ConnectEnv with a temporary home instead. */
export function systemEnv(overrides: Partial<ConnectEnv> = {}): ConnectEnv {
  const home = overrides.home ?? process.env['HOME'] ?? homedir();
  return {
    home,
    openktHome: overrides.openktHome ?? process.env['OPENKT_HOME'] ?? join(home, '.openkt'),
    platform: overrides.platform ?? process.platform,
    path: overrides.path ?? (process.env['PATH'] ?? '').split(delimiter).filter(Boolean),
    now: overrides.now ?? (() => new Date()),
    vars: overrides.vars ?? {
      XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
      OPENKT_SERVER: process.env['OPENKT_SERVER'],
      OPENKT_TOKEN: process.env['OPENKT_TOKEN'],
      CODEX_HOME: process.env['CODEX_HOME'],
    },
  };
}

/** A test (or sandboxed) environment rooted at `home`. */
export function homeEnv(home: string, extra: Partial<ConnectEnv> = {}): ConnectEnv {
  return systemEnv({ home, openktHome: join(home, '.openkt'), path: [], vars: {}, ...extra });
}

export function xdgConfig(env: ConnectEnv): string {
  return env.vars['XDG_CONFIG_HOME'] || join(env.home, '.config');
}

/** Where a desktop app keeps its per-user config: ~/Library/Application Support on macOS, ~/.config elsewhere. */
export function appSupport(env: ConnectEnv): string {
  return env.platform === 'darwin' ? join(env.home, 'Library', 'Application Support') : xdgConfig(env);
}
