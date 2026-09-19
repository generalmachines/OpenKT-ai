/**
 * Error codes and exit codes follow Spec 06 §2 (docs/specs/06-agent-interface.md), so `kt connect` and
 * `openkt-connect` fail the same way: `{"error": {code, message, hint?}}` on stdout, and the exit code says what kind.
 */
export type ConnectErrorCode =
  | 'usage'
  | 'unknown_tool'
  | 'not_installed'
  | 'config_unreadable'
  | 'conflict'
  | 'unauthorized'
  | 'network'
  | 'server'
  | 'invalid'
  | 'internal';

const EXIT: Record<ConnectErrorCode, number> = {
  usage: 2,
  unknown_tool: 4,
  not_installed: 4,
  config_unreadable: 6,
  conflict: 5,
  unauthorized: 3,
  network: 7,
  server: 7,
  invalid: 6,
  internal: 1,
};

export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly hint: string | undefined;
  readonly file: string | undefined;

  constructor(code: ConnectErrorCode, message: string, opts: { hint?: string; file?: string } = {}) {
    super(message);
    this.name = 'ConnectError';
    this.code = code;
    this.hint = opts.hint;
    this.file = opts.file;
  }

  get exitCode(): number {
    return EXIT[this.code];
  }

  toJSON(): { error: { code: ConnectErrorCode; message: string; hint?: string; file?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.file ? { file: this.file } : {}),
      },
    };
  }
}

/** A user's config file that does not parse. It is never overwritten; the integration reports needs-attention. */
export class ConfigParseError extends ConnectError {
  constructor(file: string, detail: string) {
    super('config_unreadable', `${file} could not be read: ${detail}. OpenKT left it untouched.`, {
      file,
      hint: 'fix or remove the file, then connect again',
    });
    this.name = 'ConfigParseError';
  }
}

export function exitCodeFor(code: ConnectErrorCode): number {
  return EXIT[code];
}
