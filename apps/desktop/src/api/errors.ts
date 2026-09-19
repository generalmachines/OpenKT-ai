/**
 * Typed errors for anything that crosses the network. Screens branch on
 * `kind`, never on status codes or server strings.
 */
export type ApiErrorKind = 'unauthorized' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'rate-limited' | 'server' | 'network';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status = 0,
    /** The server's stable error code (`error.code` in its envelope), when it sent one. */
    readonly code = '',
    readonly path = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 429) return 'rate-limited';
  return 'server';
}

export const isUnauthorized = (e: unknown): boolean => e instanceof ApiError && e.kind === 'unauthorized';

/** One calm sentence per failure, for the Connect screen and error notes. */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  switch (e.kind) {
    case 'unauthorized':
      return 'The server did not accept that token. Create a new one in the dashboard and paste it here.';
    case 'forbidden':
      return 'That token is valid, but it may not do this.';
    case 'not-found':
      return 'The server answered, but not like an OpenKT server. Check the address.';
    case 'network':
      return 'Could not reach the server. Check the address and that you are on the same network.';
    case 'rate-limited':
      return 'The server is rate limiting this account. Wait a moment and try again.';
    default:
      return e.message;
  }
}
