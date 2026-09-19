import { describe, expect, it } from "vitest";
import { findSecrets, hasSecret } from "../src/secrets.js";

const types = (text: string) => findSecrets(text).map((m) => m.type);

describe("findSecrets", () => {
  it("detects an AWS access key", () => {
    expect(types("key is AKIAIOSFODNN7EXAMPLE in staging")).toEqual(["aws_access_key"]);
  });

  it("detects a GitHub token", () => {
    const t = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    expect(t.slice(4).length).toBe(36);
    expect(types("token " + t)).toEqual(["github_token"]);
  });

  it("detects an OpenAI key", () => {
    expect(types("sk-abcdefghijklmnopqrst")).toEqual(["openai_key"]);
  });

  it("detects an Anthropic key exactly once", () => {
    const t = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const m = findSecrets(t);
    expect(m).toHaveLength(1);
    expect(m[0]?.type).toBe("anthropic_key");
  });

  it("detects a Slack token", () => {
    expect(types("xoxb-123456789012-abcdefghij")).toEqual(["slack_token"]);
  });

  it("detects an OpenKT personal access token", () => {
    expect(types("okt_pat_abcdefghijklmnopqrst")).toEqual(["openkt_pat"]);
  });

  it("detects a private key header", () => {
    expect(types("-----BEGIN RSA PRIVATE KEY-----")).toEqual(["private_key"]);
  });

  it("detects a JWT", () => {
    const t =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N0XgL0n3I9PlFUP0THsR8U";
    expect(types(t)).toEqual(["jwt"]);
  });

  it("detects a connection string with credentials", () => {
    expect(types("postgres://admin:s3cret@db.example.com/prod")).toEqual([
      "connection_string",
    ]);
  });

  it("detects a password assignment", () => {
    expect(types("the password is hunter22222")).toEqual(["password_assignment"]);
    expect(types("API_KEY=abcd1234")).toEqual(["password_assignment"]);
  });

  it("detects a card number passing Luhn", () => {
    expect(types("card 4242 4242 4242 4242")).toEqual(["card_number"]);
  });

  it("sorts matches by index", () => {
    const t = "password = hunter2222 then AKIAIOSFODNN7EXAMPLE";
    expect(findSecrets(t).map((m) => m.index)).toEqual([...findSecrets(t).map((m) => m.index)].sort((a, b) => a - b));
    expect(findSecrets(t).map((m) => m.type)).toEqual(["password_assignment", "aws_access_key"]);
  });

  it("never includes the secret text in the result", () => {
    const t = "AKIAIOSFODNN7EXAMPLE and postgres://admin:s3cret@db.example.com/prod";
    for (const m of findSecrets(t)) {
      expect(Object.keys(m).sort()).toEqual(["index", "type"]);
    }
  });

  it("does not flag placeholder assignments", () => {
    expect(hasSecret("the password is required")).toBe(false);
    expect(hasSecret("password: <your password>")).toBe(false);
    expect(hasSecret("password: ***")).toBe(false);
    expect(hasSecret("secret is null")).toBe(false);
  });

  it("does not flag short or standalone sk-", () => {
    expect(hasSecret("use sk- as the prefix")).toBe(false);
  });

  it("does not flag a connection string without credentials", () => {
    expect(hasSecret("postgres://localhost:5432/db")).toBe(false);
  });

  it("does not flag a 16-digit number failing Luhn", () => {
    expect(hasSecret("4242 4242 4242 4241")).toBe(false);
  });

  it("does not flag a git commit SHA", () => {
    expect(hasSecret("commit 8e37a6912345678901234567890abcdef1234567 fixed it")).toBe(false);
  });

  it("does not flag a UUID", () => {
    expect(hasSecret("id 550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("does not flag prose about keys", () => {
    expect(hasSecret("we rotate the API key every quarter")).toBe(false);
  });
});
