// Built-in accounts — Google ID token verification. Tokens are signed here with
// a locally generated RSA key and the JWKS fetcher is injected, so nothing
// touches the network.

import { generateKeyPairSync, type KeyObject } from "node:crypto";

import jwt from "jsonwebtoken";

import {
  GoogleIdTokenVerifier,
  GoogleTokenRejectedError,
} from "../../apps/server/src/modules/accounts/services/google-id-token-verifier.service";
import type { JwksFetcher } from "../../apps/server/src/modules/auth/services/jwks-key-cache";

const CLIENT_ID = "1234-desktop.apps.googleusercontent.com";
const OTHER_CLIENT_ID = "1234-web.apps.googleusercontent.com";
const KID = "test-key-1";

function makeKey(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" } };
}

const google = makeKey();
const impostor = makeKey();

function sign(claims: Record<string, unknown>, key: KeyObject = google.privateKey, kid = KID): string {
  return jwt.sign(
    {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "google-sub-001",
      email: "Ana@Example.com",
      email_verified: true,
      name: "Ana Lima",
      exp: Math.floor(Date.now() / 1000) + 600,
      ...claims,
    },
    key,
    { algorithm: "RS256", keyid: kid },
  );
}

function makeVerifier(clientIds: string | undefined, fetcher?: JwksFetcher) {
  const calls = { count: 0 };
  const defaultFetcher: JwksFetcher = async () => {
    calls.count++;
    return { keys: [google.jwk], maxAgeMs: 3_600_000 };
  };
  const config = { get: (key: string) => (key === "OPENKT_GOOGLE_CLIENT_IDS" ? clientIds : undefined) };
  return { verifier: new GoogleIdTokenVerifier(config as never, fetcher ?? defaultFetcher), calls };
}

describe("GoogleIdTokenVerifier", () => {
  it("accepts a valid token and returns the identity with a lower-cased email", async () => {
    const { verifier } = makeVerifier(`${OTHER_CLIENT_ID}, ${CLIENT_ID}`);
    await expect(verifier.verify(sign({}))).resolves.toEqual({
      sub: "google-sub-001",
      email: "ana@example.com",
      name: "Ana Lima",
      picture: null,
    });
  });

  it("accepts both issuer spellings Google uses", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    await expect(verifier.verify(sign({ iss: "accounts.google.com" }))).resolves.toMatchObject({ sub: "google-sub-001" });
  });

  it("fetches Google's keys once and then verifies from cache", async () => {
    const { verifier, calls } = makeVerifier(CLIENT_ID);
    await verifier.verify(sign({}));
    await verifier.verify(sign({ sub: "google-sub-002" }));
    expect(calls.count).toBe(1);
  });

  it("rejects a token minted for another app (wrong aud)", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    await expect(verifier.verify(sign({ aud: "someone-elses-app.apps.googleusercontent.com" }))).rejects.toBeInstanceOf(
      GoogleTokenRejectedError,
    );
  });

  it("rejects an expired token", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    await expect(verifier.verify(sign({ exp: Math.floor(Date.now() / 1000) - 60 }))).rejects.toBeInstanceOf(
      GoogleTokenRejectedError,
    );
  });

  it("rejects an unverified email — including the string 'true'", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    for (const emailVerified of [false, "true", undefined]) {
      await expect(verifier.verify(sign({ email_verified: emailVerified }))).rejects.toBeInstanceOf(
        GoogleTokenRejectedError,
      );
    }
  });

  it("rejects a wrong issuer", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    await expect(verifier.verify(sign({ iss: "https://accounts.evil.example" }))).rejects.toBeInstanceOf(
      GoogleTokenRejectedError,
    );
  });

  it("rejects a token signed by a key Google does not publish, even under a known kid", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    await expect(verifier.verify(sign({}, impostor.privateKey))).rejects.toBeInstanceOf(GoogleTokenRejectedError);
    await expect(verifier.verify(sign({}, impostor.privateKey, "unknown-kid"))).rejects.toBeInstanceOf(
      GoogleTokenRejectedError,
    );
  });

  it("rejects an unsigned (alg=none) or HS256 token", async () => {
    const { verifier } = makeVerifier(CLIENT_ID);
    const payload = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "x", email: "a@b.co", email_verified: true };
    const none = jwt.sign(payload, "", { algorithm: "none", keyid: KID, expiresIn: 600 });
    const hs = jwt.sign(payload, "shared-secret", { algorithm: "HS256", keyid: KID, expiresIn: 600 });
    await expect(verifier.verify(none)).rejects.toBeInstanceOf(GoogleTokenRejectedError);
    await expect(verifier.verify(hs)).rejects.toBeInstanceOf(GoogleTokenRejectedError);
    await expect(verifier.verify("garbage")).rejects.toBeInstanceOf(GoogleTokenRejectedError);
  });

  it("is disabled when OPENKT_GOOGLE_CLIENT_IDS is unset", async () => {
    const { verifier, calls } = makeVerifier(undefined);
    expect(verifier.enabled()).toBe(false);
    await expect(verifier.verify(sign({}))).rejects.toBeInstanceOf(GoogleTokenRejectedError);
    expect(calls.count).toBe(0);
  });
});
