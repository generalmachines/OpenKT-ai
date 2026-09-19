// GET /v1/meta (Spec 04 Operations): which build is answering. The deploy
// smoke test compares `commit` with the SHA it just shipped, so the source of
// each field is pinned here.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_FEATURES,
  MetaController,
  findServerRoot,
  readServerMeta,
} from "../../apps/server/src/modules/health/controllers/meta.controller";

describe("GET /v1/meta", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openkt-meta-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@openkt/api", version: "1.2.3" }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads commit and built_at from build-info.json, version from package.json", () => {
    writeFileSync(
      join(root, "build-info.json"),
      JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", built_at: "2026-09-19T10:00:00Z" }),
    );
    const meta = readServerMeta({ OPENKT_COMMIT: "stale-env-value" }, root);
    expect(meta.version).toBe("1.2.3");
    // The file baked into the image wins over a config var that can outlive a deploy.
    expect(meta.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(meta.built_at).toBe("2026-09-19T10:00:00Z");
  });

  it("falls back to OPENKT_COMMIT / OPENKT_BUILT_AT, then null", () => {
    expect(readServerMeta({ OPENKT_COMMIT: "abc123", OPENKT_BUILT_AT: "2026-01-01T00:00:00Z" }, root)).toMatchObject({
      commit: "abc123",
      built_at: "2026-01-01T00:00:00Z",
    });
    expect(readServerMeta({}, root)).toMatchObject({ commit: null, built_at: null });
  });

  it("reports the embedding model, rerank and the feature list", () => {
    expect(readServerMeta({ OPENKT_OPENAI_EMBED_MODEL: "Qwen/Qwen3-Embedding-0.6B" }, root)).toMatchObject({
      embedding_model: "Qwen/Qwen3-Embedding-0.6B",
      rerank: false,
      features: ["sessions", "grants", "hybrid_recall"],
    });
    expect(readServerMeta({ OPENKT_EMBED_MODEL: "m", OPENKT_RERANK_URL: "http://rerank" }, root)).toMatchObject({
      embedding_model: "m",
      rerank: true,
    });
    expect(META_FEATURES).toEqual(["sessions", "grants", "hybrid_recall"]);
  });

  it("finds the real server package from the controller's own directory", () => {
    const found = findServerRoot();
    expect(found).not.toBeNull();
    expect(readServerMeta({}, found).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("answers in the standard envelope", () => {
    const res = new MetaController().get();
    expect(res.error).toBeNull();
    expect(Object.keys(res.data).sort()).toEqual(["built_at", "commit", "embedding_model", "features", "rerank", "version"]);
  });
});
