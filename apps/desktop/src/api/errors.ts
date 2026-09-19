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

/** One calm sentence per failure, for notes inside the app. (The sign-in form has its own: `describeAuthError`.) */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  switch (e.kind) {
    case 'unauthorized':
      return 'Please sign in again.';
    case 'forbidden':
      return 'You don’t have permission to do that.';
    case 'not-found':
      return 'That couldn’t be found. It may have been removed, or you may not have access.';
    case 'network':
      return 'Can’t reach OpenKT right now. Check your connection.';
    case 'rate-limited':
      return 'Too many requests. Wait a moment and try again.';
    case 'invalid':
      return e.code === 'validation_failed' || !e.message ? 'That didn’t look right. Check it and try again.' : e.message;
    default:
      return e.message;
  }
}
