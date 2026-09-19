// The `local` provider (Spec 05 §2): no auth; `fs.list` and `fs.read` over a
// folder the desktop app exposes. Used by the Obsidian connector. Every path
// is confined to the configured root — `..`, absolute paths and symlinks that
// resolve outside the root all throw InvalidInputError.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { InvalidInputError } from "./errors.js";
import type { ToolProvider } from "./types.js";

export interface LocalProviderConfig {
  /** Absolute path of the folder the desktop app exposes. */
  root: string;
}

export interface LocalEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  /** Modification time (ISO-8601 UTC), from `lstat` — absent when the stat fails. */
  mtime?: string;
  /** Bytes, on files only — never on directories, symlinks or others. */
  size?: number;
}

/**
 * Resolve `relative` inside `root` and prove it stays there: no absolute
 * paths, no `..` escapes, and the on-disk (symlink-resolved) location must
 * still be inside the root.
 */
async function resolveInsideRoot(root: string, relative: string): Promise<string> {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new InvalidInputError("path must be a non-empty string");
  }
  if (path.isAbsolute(relative)) {
    throw new InvalidInputError(`absolute path rejected: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new InvalidInputError(`path escapes the root: ${relative}`);
  }
  let real: string;
  let realRoot: string;
  try {
    real = await fs.realpath(resolved);
    realRoot = await fs.realpath(root);
  } catch {
    throw new InvalidInputError(`path not found within the root: ${relative}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new InvalidInputError(`symlink escapes the root: ${relative}`);
  }
  return real;
}

export function createLocalProvider(config: LocalProviderConfig): ToolProvider {
  const root = path.resolve(config.root);
  return {
    id: "local",
    configSchema: {
      type: "object",
      properties: { root: { type: "string" } },
      required: ["root"],
    },

    async listApps() {
      return [{ app: "obsidian", name: "Local files", authKind: "none" }];
    },

    async beginConnect() {
      // No auth — connecting is immediate.
      return { connectionId: "local" };
    },

    async getConnection() {
      return { status: "active" as const };
    },

    async call<T>(connectionId: string, action: string, params: Record<string, unknown>): Promise<T> {
      if (connectionId !== "local") {
        throw new InvalidInputError(`unknown connection: ${connectionId}`);
      }
      if (action === "fs.list") {
        if (typeof params["dir"] !== "string") {
          throw new InvalidInputError("fs.list requires a string `dir`");
        }
        const dir = await resolveInsideRoot(root, params["dir"]);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        // Stats come from `lstat` on the entry's path — never follow a
        // symlink, so nothing outside the root is ever touched. An entry
        // whose lstat fails (deleted between listing and stat) is still
        // returned, without mtime and size.
        return Promise.all(
          entries.map(async (e): Promise<LocalEntry> => {
            const entry: LocalEntry = {
              name: e.name,
              type: e.isFile() ? "file" : e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "other",
            };
            try {
              const stats = await fs.lstat(path.join(dir, e.name));
              entry.mtime = stats.mtime.toISOString();
              if (entry.type === "file") entry.size = stats.size;
            } catch {
              // keep the entry without mtime/size
            }
            return entry;
          }),
        ) as T;
      }
      if (action === "fs.read") {
        if (typeof params["path"] !== "string") {
          throw new InvalidInputError("fs.read requires a string `path`");
        }
        const file = await resolveInsideRoot(root, params["path"]);
        return (await fs.readFile(file, "utf8")) as T;
      }
      throw new InvalidInputError(`unknown action: ${action}`);
    },

    async disconnect() {
      // Nothing to tear down — no auth, no connection state.
    },
  };
}
