import { describe, expect, it } from "vitest";
import { normaliseTags, slugTag } from "../src/tags.js";

describe("slugTag", () => {
  it("slugs to kebab-case ASCII", () => {
    expect(slugTag("Northgate Pricing!")).toBe("northgate-pricing");
  });

  it("folds diacritics before the kind-name check", () => {
    expect(slugTag("Décision")).toBeNull();
  });

  it("rejects empty and kind names", () => {
    expect(slugTag("")).toBeNull();
    expect(slugTag("fact")).toBeNull();
    expect(slugTag("decision")).toBeNull();
  });

  it("cuts a 50-char tag to 32 without a trailing dash", () => {
    const raw = "a".repeat(20) + "-" + "b".repeat(29);
    const out = slugTag(raw);
    expect(out).toHaveLength(32);
    expect(out?.endsWith("-")).toBe(false);
  });

  it("keeps Thai and Devanagari tags intact (any script)", () => {
    expect(slugTag("การประชุม")).toBe("การประชุม");
    expect(slugTag("निर्णय")).toBe("निर्णय");
  });

  it("strips Latin combining marks (so Décision folds to the kind name)", () => {
    expect(slugTag("Décision!")).toBeNull();
    expect(slugTag("Café Latte")).toBe("cafe-latte");
  });

  it("non-letter runs collapse to one dash", () => {
    expect(slugTag("a  --  b!!c")).toBe("a-b-c");
  });
});

describe("normaliseTags", () => {
  const vocab = [{ tag: "customer-northgate", count: 5 }];
  const sim = (a: string, b: string) => (a === "northgate" && b === "customer-northgate" ? 0.9 : 0);

  it("replaces a new tag with a similar vocab tag", () => {
    const out = normaliseTags(["northgate"], vocab, sim);
    expect(out).toEqual({ tags: ["customer-northgate"], created: [] });
  });

  it("keeps a tag as new when similarity is below 0.85", () => {
    const low = (a: string, b: string) => (a === "northgate" && b === "customer-northgate" ? 0.84 : 0);
    const out = normaliseTags(["northgate"], vocab, low);
    expect(out).toEqual({ tags: ["northgate"], created: ["northgate"] });
  });

  it("keeps a tag already in the vocabulary without creating it", () => {
    const out = normaliseTags(["customer-northgate"], vocab, sim);
    expect(out).toEqual({ tags: ["customer-northgate"], created: [] });
  });

  it("de-duplicates and keeps the first 4", () => {
    const out = normaliseTags(
      ["alpha", "beta", "gamma", "delta", "alpha", "epsilon", "zeta"],
      [],
      () => 0,
    );
    expect(out.tags).toEqual(["alpha", "beta", "gamma", "delta"]);
    // `created` lists only new tags actually returned after the first-4 cut.
    expect(out.created).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("skips slugs rejected as null", () => {
    const out = normaliseTags(["fact", "real-tag"], [], () => 0);
    expect(out.tags).toEqual(["real-tag"]);
  });
});
