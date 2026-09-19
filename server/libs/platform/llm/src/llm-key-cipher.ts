import crypto from "node:crypto";

const PREFIX = "v1:gcm";

export class LlmKeyCipher {
  static encrypt(plainText: string, secret = resolveSecret()): string {
    const key = deriveKey(secret);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join(":");
  }

  static decrypt(ciphertext: string, secret = resolveSecret()): string {
    const [version, mode, ivRaw, tagRaw, dataRaw] = ciphertext.split(":");
    if (`${version}:${mode}` !== PREFIX || !ivRaw || !tagRaw || !dataRaw) {
      throw new Error("unsupported LLM key ciphertext format");
    }

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveKey(secret),
      Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  static mask(plainText: string): string {
    const trimmed = plainText.trim();
    if (trimmed.length <= 8) {
      return "****";
    }
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }
}

function resolveSecret(): string {
  const secret =
    process.env.LLM_CONFIG_ENCRYPTION_KEY ??
    process.env.OPENKT_SECRET_KEY ??
    process.env.OPENKT_INTERNAL_SERVICE_TOKEN;
  if (secret && secret.length >= 16) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("LLM_CONFIG_ENCRYPTION_KEY is required in production");
  }

  return "openkt-local-development-llm-key-cipher";
}

function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}
