/** The hosted service. People who never open "Using your own server?" sign in here. */
export const HOSTED_SERVER_URL = 'https://api.openkt.ai';

/**
 * The one place the default server lives. A build can point somewhere else with
 * `VITE_OPENKT_SERVER_URL` (a staging build, a company's own distribution).
 */
export const DEFAULT_SERVER_URL: string = (import.meta.env?.VITE_OPENKT_SERVER_URL ?? '').trim().replace(/\/+$/, '') || HOSTED_SERVER_URL;

/**
 * Servers that earlier builds used as their built-in default. A saved address that
 * matches one of these was never chosen by the person — it is a leftover from an old
 * install — so it is replaced with the current default on load. (The first desktop
 * builds defaulted to a test server that did not have accounts; signing up there
 * failed with a misleading "email and password don't match".)
 */
export const RETIRED_DEFAULT_SERVER_URLS: readonly string[] = ['http://pratham-gpu.taile8dc37.ts.net:3300'];

/** Access tokens issued by the server (sign-in, or `POST /v1/me/tokens`) start with this. */
export const TOKEN_PREFIX = 'okt_pat_';

/** The shortest password the server accepts; the form says so before the server has to. */
export const MIN_PASSWORD_LENGTH = 10;
