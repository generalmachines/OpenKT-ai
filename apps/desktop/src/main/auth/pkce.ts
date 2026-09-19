/**
 * PKCE (RFC 7636) helpers for the desktop Google sign-in. Pure Node crypto,
 * no Electron, so they are unit-tested against the RFC's own vector.
 */
import { createHash, randomBytes } from 'node:crypto';

const base64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 32 random bytes → 43 characters of [A-Za-z0-9-_] (the RFC allows 43–128 unreserved characters). */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256: BASE64URL(SHA256(ASCII(verifier))). */
export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Opaque value echoed back by Google; the listener refuses any callback that does not carry it. */
export function createState(): string {
  return base64url(randomBytes(24));
}
