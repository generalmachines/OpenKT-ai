// Built-in accounts — password hashing (Node scrypt) and the password policy.

import {
  hashPassword,
  verifyPassword,
} from "../../apps/server/src/modules/accounts/services/password-hasher";
import { passwordProblem } from "../../apps/server/src/modules/accounts/services/password-policy";

describe("password hashing (scrypt)", () => {
  it("round-trips: the stored form carries its parameters and verifies the same password", async () => {
    const stored = await hashPassword("correct horse battery");
    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(["scrypt", String(2 ** 15), "8", "1"]);
    expect(Buffer.from(parts[4]!, "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5]!, "base64")).toHaveLength(64);
    await expect(verifyPassword("correct horse battery", stored)).resolves.toBe(true);
  });

  it("salts: the same password never hashes to the same string twice", async () => {
    const [a, b] = await Promise.all([hashPassword("same password here"), hashPassword("same password here")]);
    expect(a).not.toEqual(b);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery");
    await expect(verifyPassword("correct horse batterz", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("treats a malformed or foreign hash as a mismatch — never throws", async () => {
    const good = await hashPassword("correct horse battery");
    const [, n, r, p, salt, key] = good.split("$");
    const malformed = [
      "",
      "not-a-hash",
      "$2b$10$abcdefghijklmnopqrstuv", // bcrypt
      `argon2$${n}$${r}$${p}$${salt}$${key}`, // wrong scheme
      `scrypt$${n}$${r}$${p}$${salt}`, // missing the key
      `scrypt$abc$${r}$${p}$${salt}$${key}`, // N not a number
      `scrypt$1000$${r}$${p}$${salt}$${key}`, // N not a power of two
      `scrypt$${2 ** 30}$${r}$${p}$${salt}$${key}`, // N absurdly large — must not allocate
      `scrypt$${n}$${r}$${p}$$${key}`, // empty salt
      `scrypt$${n}$${r}$${p}$${salt}$AAAA`, // truncated key
    ];
    for (const stored of malformed) {
      await expect(verifyPassword("correct horse battery", stored)).resolves.toBe(false);
    }
    await expect(verifyPassword("correct horse battery", null)).resolves.toBe(false);
  });
});

describe("password policy", () => {
  const email = "ana@example.com";

  it("accepts a reasonable password", () => {
    expect(passwordProblem("plum-Tractor-91", email)).toBeNull();
  });

  it("rejects fewer than 10 characters", () => {
    expect(passwordProblem("short1234", email)).toMatch(/at least 10/);
  });

  it("rejects the email address itself, whatever the case", () => {
    expect(passwordProblem("Ana@Example.com", email)).toMatch(/email/);
  });

  it("rejects common passwords, whatever the case", () => {
    for (const common of ["1234567890", "qwertyuiop", "Password123", "QWERTY12345"]) {
      expect(passwordProblem(common, email)).toMatch(/too common/);
    }
  });
});
