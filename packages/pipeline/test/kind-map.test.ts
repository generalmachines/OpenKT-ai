import { describe, expect, it } from "vitest";
import { mapKind, unmapKind } from "../src/kind-map.js";
import type { Kind } from "../src/types.js";

const ALL: Kind[] = ["decision", "fact", "how-to", "issue", "question", "action", "idea"];

describe("mapKind", () => {
  it("maps all seven kinds per the Spec 02 §7 table", () => {
    expect(mapKind("decision")).toEqual({ dbKind: "decision", extraTags: [] });
    expect(mapKind("fact")).toEqual({ dbKind: "fact", extraTags: [] });
    expect(mapKind("how-to")).toEqual({ dbKind: "pattern", extraTags: [] });
    expect(mapKind("issue")).toEqual({ dbKind: "incident", extraTags: [] });
    expect(mapKind("question")).toEqual({ dbKind: "note", extraTags: ["open-question"] });
    expect(mapKind("action")).toEqual({ dbKind: "note", extraTags: ["action"] });
    expect(mapKind("idea")).toEqual({ dbKind: "note", extraTags: ["idea"] });
  });

  it("round-trips every kind", () => {
    for (const k of ALL) {
      const { dbKind, extraTags } = mapKind(k);
      expect(unmapKind(dbKind, extraTags)).toBe(k);
    }
  });

  it("unknown dbKind falls back to fact", () => {
    expect(unmapKind("mystery", [])).toBe("fact");
  });

  it("an unmapped note with no marker tag falls back to fact", () => {
    expect(unmapKind("note", [])).toBe("fact");
  });
});
