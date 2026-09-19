import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Password hashing with Node's built-in scrypt — no native add-on to build,
// no dependency to audit. Stored form:
//
//   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
//
// The parameters travel with the hash, so raising them later only affects new
// hashes; old ones keep verifying with the numbers they were made with.
const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Upper bounds accepted when VERIFYING a stored hash, so a corrupted or
// hostile row cannot make the server allocate gigabytes.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs 128 * N * r bytes; Node's default ceiling (32 MiB) is
    // exactly that for N=2^15, r=8 and refuses it, so give it headroom.
    const maxmem = 128 * (options.N ?? N) * (options.r ?? R) * 2;
    scrypt(password.normalize("NFKC"), salt, keyLength, { ...options, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Never throws: a malformed or foreign hash is simply "does not match".
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  if (n > MAX_N || r > MAX_R || p > MAX_P || (n & (n - 1)) !== 0) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || expected.length < 32) return false;
  try {
    const actual = await derive(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Verified against when the email is unknown, so "no such account" and "wrong
// password" cost the same time. Computed once, lazily.
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyHash;
}
