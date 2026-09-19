import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { okResponse, type ApiSuccessResponse } from "../../../common/http/ok-response";

// GET /v1/meta (Spec 04, Operations) — public, no token. Says which build is
// answering: `version` from server/package.json, `commit` and `built_at` from
// build-info.json, which the deploy workflow writes into the source archive
// (`git archive --add-virtual-file`) so the commit travels inside the image
// and cannot drift from the code that is running. A build without that file
// (local dev, a self-hosted `docker build`) falls back to OPENKT_COMMIT /
// OPENKT_BUILT_AT, else null.

export interface ServerMeta {
  version: string;
  commit: string | null;
  built_at: string | null;
  embedding_model: string | null;
  rerank: boolean;
  features: string[];
}

export const META_FEATURES = ["sessions", "grants", "hybrid_recall"] as const;

const SERVER_PACKAGE = "@openkt/api";

/** The directory holding the server's package.json, found by walking up from `start` (works from src/ and dist/). */
export function findServerRoot(start: string = __dirname): string | null {
  let dir = start;
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown }).name === SERVER_PACKAGE) return dir;
      } catch {
        // not JSON: keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function readServerMeta(env: NodeJS.ProcessEnv = process.env, root: string | null = findServerRoot()): ServerMeta {
  const pkg = root ? readJson(join(root, "package.json")) : {};
  const build = root ? readJson(join(root, "build-info.json")) : {};
  return {
    version: text(pkg["version"]) ?? "0.0.0",
    commit: text(build["commit"]) ?? text(env.OPENKT_COMMIT),
    built_at: text(build["built_at"]) ?? text(env.OPENKT_BUILT_AT),
    embedding_model: text(env.OPENKT_EMBED_MODEL) ?? text(env.OPENKT_OPENAI_EMBED_MODEL),
    rerank: Boolean(text(env.OPENKT_RERANK_URL)),
    features: [...META_FEATURES],
  };
}

@Controller("meta")
@ApiTags("Health")
export class MetaController {
  // Build facts do not change while the process runs; read them once.
  private readonly meta = readServerMeta();

  @Get()
  @ApiOperation({ summary: "Which build is answering: version, commit, built_at, embedding model, features (public)" })
  get(): ApiSuccessResponse<ServerMeta> {
    return okResponse(this.meta);
  }
}
