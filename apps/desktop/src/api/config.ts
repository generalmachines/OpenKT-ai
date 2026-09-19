/** The hosted service. People who never open "Using your own server?" sign in here. */
export const HOSTED_SERVER_URL = 'https://api.openkt.ai';

/**
 * The one place the default server lives. A build can point somewhere else with
 * `VITE_OPENKT_SERVER_URL` (a staging build, a company's own distribution).
 */
export const DEFAULT_SERVER_URL: string = (import.meta.env?.VITE_OPENKT_SERVER_URL ?? '').trim().replace(/\/+$/, '') || HOSTED_SERVER_URL;

/** Access tokens issued by the server (sign-in, or `POST /v1/me/tokens`) start with this. */
export const TOKEN_PREFIX = 'okt_pat_';

/** The shortest password the server accepts; the form says so before the server has to. */
export const MIN_PASSWORD_LENGTH = 10;
