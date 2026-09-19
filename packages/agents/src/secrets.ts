// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
// Secret patterns (Spec 02 §9). A fact whose statement or quote matches is never stored — this also
// runs on facts a person saves explicitly. Patterns are deliberately narrow: "the API key is rotated
// monthly" and "token refresh" must pass.

/** A value that looks like a credential rather than a word: 6+ characters including a digit. */
const VALUE = String.raw`["'\x60]?(?=[^\s"'\x60]*\d)[^\s"'\x60]{6,}`;

export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  {
    name: "password",
    pattern: new RegExp(String.raw`\b(pass(?:word|wd|phrase)|secret|api[ _-]?key|access[ _-]?key|auth[ _-]?token|bearer[ _-]?token)\b[^.\n]{0,24}?(\bis\b|\bwas\b|=|:)\s*${VALUE}`, "i"),
  },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "provider-key", pattern: /\b(sk-[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { name: "connection-string", pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s/]+/i },
];

const CARD = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/** The name of the first secret pattern found in the text, or null. */
export function findSecret(text: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) if (pattern.test(text)) return name;
  for (const match of text.match(CARD) ?? []) {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return "card-number";
  }
  return null;
}

export const statesSecret = (fact: { statement: string; quote?: string | null }): boolean =>
  findSecret(fact.statement) !== null || (fact.quote ? findSecret(fact.quote) !== null : false);
