// Secrets filter (Spec 02 §9): OpenKT never stores credentials, even when a
// person asks it to. Detection only — redaction and entropy scoring are out
// of scope. Results never contain the matched text, only type and index.

const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g;
const OPENAI_KEY = /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const OPENKT_PAT = /\bokt_pat_[A-Za-z0-9]{20,}\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const CONNECTION_STRING =
  /\b(?:mongodb\+srv|postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/]+:[^\s:@]+@[^\s<>"'`]+/g;
const PASSWORD_ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|api[_-]?key)[ \t]*(is[ \t]*[=:]?[ \t]*|[=:][ \t]*)[^\s]{6,}/gi;
const CARD_NUMBER = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

/** A value the password rule must never flag. */
const PLACEHOLDER_VALUES = new Set([
  "null",
  "none",
  "true",
  "false",
  "required",
  "missing",
]);

function isPlaceholderValue(value: string): boolean {
  if (PLACEHOLDER_VALUES.has(value.toLowerCase())) return true;
  if (value.startsWith("<") && value.endsWith(">")) return true;
  if (/^\*+$/.test(value)) return true;
  return false;
}

/** Luhn checksum for a string of digits. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function findSecrets(text: string): { type: string; index: number }[] {
  const matches: { type: string; index: number }[] = [];

  const add = (type: string, re: RegExp) => {
    for (const m of text.matchAll(re)) {
      matches.push({ type, index: m.index });
    }
  };

  add("aws_access_key", AWS_ACCESS_KEY);
  add("github_token", GITHUB_TOKEN);
  add("openai_key", OPENAI_KEY);
  add("anthropic_key", ANTHROPIC_KEY);
  add("slack_token", SLACK_TOKEN);
  add("openkt_pat", OPENKT_PAT);
  add("private_key", PRIVATE_KEY);
  add("jwt", JWT);
  add("connection_string", CONNECTION_STRING);

  for (const m of text.matchAll(PASSWORD_ASSIGNMENT)) {
    // The value is the last whitespace-free run of the match.
    const value = m[0].split(/\s+/).pop() as string;
    if (isPlaceholderValue(value)) continue;
    // Bare "is" form (no `=` or `:`): only flag values that look
    // credential-like, so ordinary sentences never match (issue #54).
    const separator = m[1] ?? "";
    const bareIs = separator.startsWith("is") && !/[=:]/.test(separator);
    if (bareIs && !/[0-9!@#$%^&*_+=~-]/.test(value)) continue;
    matches.push({ type: "password_assignment", index: m.index });
  }

  for (const m of text.matchAll(CARD_NUMBER)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      matches.push({ type: "card_number", index: m.index });
    }
  }

  return matches.sort((a, b) => a.index - b.index);
}

export function hasSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}
