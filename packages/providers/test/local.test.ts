import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalProvider } from "../src/local.js";
import { InvalidInputError } from "../src/errors.js";

let root: string | undefined;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
  root = undefined;
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openkt-local-"));
  dirs.push(dir);
  return dir;
}

async function setup(): Promise<ReturnType<typeof createLocalProvider>> {
  root = await makeRoot();
  await writeFile(path.join(root!, "note.md"), "# hello\n");
  await mkdir(path.join(root!, "sub"));
  await writeFile(path.join(root!, "sub", "inner.md"), "inner");
  return createLocalProvider({ root: root! });
}

describe("createLocalProvider", () => {
  it("fs.list returns the entries of a directory", async () => {
    const provider = await setup();
    const entries = await provider.call<Array<{ name: string; type: string }>>("local", "fs.list", { dir: "." });
    expect(entries.map((e) => e.name).sort()).toEqual(["note.md", "sub"]);
    const sub = await provider.call<Array<{ name: string; type: string }>>("local", "fs.list", { dir: "sub" });
    expect(sub).toEqual([{ name: "inner.md", type: "file" }]);
  });

  it("fs.read returns the file content", async () => {
    const provider = await setup();
    const text = await provider.call<string>("local", "fs.read", { path: "note.md" });
    expect(text).toBe("# hello\n");
    const inner = await provider.call<string>("local", "fs.read", { path: "sub/inner.md" });
    expect(inner).toBe("inner");
  });

  it("a `..` escape is rejected", async () => {
    const provider = await setup();
    await expect(provider.call("local", "fs.read", { path: "../secret.txt" })).rejects.toThrow(InvalidInputError);
    await expect(provider.call("local", "fs.list", { dir: "../" })).rejects.toThrow(InvalidInputError);
    // a `..` that walks out through a subdirectory too
    await expect(provider.call("local", "fs.read", { path: "sub/../../secret.txt" })).rejects.toThrow(InvalidInputError);
  });

  it("an absolute path is rejected", async () => {
    const provider = await setup();
    await expect(provider.call("local", "fs.read", { path: "/etc/passwd" })).rejects.toThrow(InvalidInputError);
    await expect(provider.call("local", "fs.list", { dir: path.join(root!, "sub") })).rejects.toThrow(InvalidInputError);
  });

  it("a symlink pointing out of the root is rejected", async () => {
    const outside = await makeRoot();
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    const provider = await setup();
    await symlink(path.join(outside, "secret.txt"), path.join(root!, "escape.lnk"));
    await expect(provider.call("local", "fs.read", { path: "escape.lnk" })).rejects.toThrow(InvalidInputError);
    // a symlinked directory used for listing too
    await symlink(outside, path.join(root!, "outside-dir"));
    await expect(provider.call("local", "fs.list", { dir: "outside-dir" })).rejects.toThrow(InvalidInputError);
  });

  it("a symlink pointing inside the root still resolves", async () => {
    const provider = await setup();
    await symlink(path.join(root!, "note.md"), path.join(root!, "alias.md"));
    const text = await provider.call<string>("local", "fs.read", { path: "alias.md" });
    expect(text).toBe("# hello\n");
  });

  it("a missing path, a missing param, an unknown action and a wrong connection all throw InvalidInputError", async () => {
    const provider = await setup();
    await expect(provider.call("local", "fs.read", { path: "nope.md" })).rejects.toThrow(InvalidInputError);
    await expect(provider.call("local", "fs.read", {})).rejects.toThrow(InvalidInputError);
    await expect(provider.call("local", "fs.list", {})).rejects.toThrow(InvalidInputError);
    await expect(provider.call("local", "fs.write", { path: "x" })).rejects.toThrow(InvalidInputError);
    await expect(provider.call("other", "fs.read", { path: "note.md" })).rejects.toThrow(InvalidInputError);
  });

  it("beginConnect needs no auth and getConnection is immediately active", async () => {
    const provider = await setup();
    const { connectionId } = await provider.beginConnect({ userId: "u1", app: "obsidian", redirectUrl: "http://localhost/cb" });
    expect(connectionId).toBe("local");
    expect(await provider.getConnection(connectionId)).toEqual({ status: "active" });
    expect(await provider.getConnection("whatever")).toEqual({ status: "active" });
    await expect(provider.disconnect(connectionId)).resolves.toBeUndefined();
  });
});
