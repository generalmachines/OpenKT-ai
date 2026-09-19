import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findSecrets } from "../../apps/server/src/common/secrets/find-secrets";
import { ContainsSecretError, refuseSecrets } from "../../apps/server/src/common/secrets/refuse-secrets";

// The server carries a copy of packages/pipeline/src/secrets.ts (it is not an
// npm workspace, so it cannot import it). This keeps the copy honest: below its
// header marker it must be the reviewed source, byte for byte — same rule
// table, same exceptions, same order.
const SOURCE = join(__dirname, "../../../packages/pipeline/src/secrets.ts");
const COPY = join(__dirname, "../../apps/server/src/common/secrets/find-secrets.ts");
const MARKER = "// ── copied verbatim below this line ──\n";

describe("server findSecrets is the reviewed pipeline filter", () => {
  it("matches packages/pipeline/src/secrets.ts exactly below the header", () => {
    const copy = readFileSync(COPY, "utf8");
    const at = copy.indexOf(MARKER);
    expect(at).toBeGreaterThan(0);
    expect(copy.slice(at + MARKER.length)).toBe(readFileSync(SOURCE, "utf8"));
  });

  it("the header names its source", () => {
    const header = readFileSync(COPY, "utf8").split(MARKER)[0];
    expect(header).toContain("packages/pipeline/src/secrets.ts");
  });

  it("finds the kinds the pipeline finds, and passes ordinary sentences", () => {
    const types = (text: string) => findSecrets(text).map((m) => m.type);
    expect(types("key is AKIAIOSFODNN7EXAMPLE in staging")).toEqual(["aws_access_key"]);
    expect(types("postgres://admin:s3cret@db.example.com/prod")).toEqual(["connection_string"]);
    expect(types("-----BEGIN RSA PRIVATE KEY-----")).toEqual(["private_key"]);
    expect(types("the password is hunter22222")).toEqual(["password_assignment"]);
    expect(types("The API key is rotated monthly.")).toEqual([]);
    expect(types("Token refresh happens every 15 minutes.")).toEqual([]);
  });
});

describe("refuseSecrets", () => {
  it("throws 422 contains_secret naming the kind, never the value", () => {
    let caught: unknown;
    try {
      refuseSecrets("fact", "ok", null, "deploy with AKIAIOSFODNN7EXAMPLE and postgres://u:hunter2x@h/db");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContainsSecretError);
    const err = caught as ContainsSecretError;
    expect(err.getStatus()).toBe(422);
    const body = err.getResponse() as { code: string; message: string; kinds: string[] };
    expect(body.code).toBe("contains_secret");
    expect(body.message).toMatch(/^This fact looks like it contains an AWS access key and a connection string with a password\./);
    expect(body.kinds).toEqual(["aws_access_key", "connection_string"]);
    expect(JSON.stringify(body)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(body)).not.toContain("hunter2x");
  });

  it("passes text without secrets", () => {
    expect(() => refuseSecrets("turn", "We rotate the API key monthly.", undefined, "")).not.toThrow();
  });
});
