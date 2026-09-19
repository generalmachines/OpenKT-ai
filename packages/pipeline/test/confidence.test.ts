import { describe, expect, it } from "vitest";
import { assignConfidence, bumpOnConfirmation, MARKED_WRONG } from "../src/confidence.js";

describe("assignConfidence", () => {
  it("one row per line of the Spec 02 §8 table plus the extra rules", () => {
    // saved directly by a person or an explicit kt_save_memory
    expect(assignConfidence({ origin: "explicit_save", source: "api" })).toBe(0.9);
    // extracted, quote found verbatim, stated by the user
    expect(
      assignConfidence({ origin: "extracted", source: "claude-code", quoteTurnRole: "user" }),
    ).toBe(0.75);
    // extracted, stated by the assistant, not contradicted later
    expect(
      assignConfidence({
        origin: "extracted",
        source: "claude-code",
        quoteTurnRole: "assistant",
        contradictedLater: false,
      }),
    ).toBe(0.55);
    // extracted, stated by the assistant, contradicted later (decided: 0.30)
    expect(
      assignConfidence({
        origin: "extracted",
        source: "claude-code",
        quoteTurnRole: "assistant",
        contradictedLater: true,
      }),
    ).toBe(0.3);
    // extracted from an image description or OCR
    expect(
      assignConfidence({ origin: "extracted", source: "desktop", quoteFrom: "image_description" }),
    ).toBe(0.5);
    expect(assignConfidence({ origin: "extracted", source: "desktop", quoteFrom: "ocr" })).toBe(0.5);
    // meeting transcript with an unknown speaker
    expect(
      assignConfidence({
        origin: "extracted",
        source: "meeting",
        quoteTurnRole: "speaker",
        speakerKnown: false,
      }),
    ).toBe(0.5);
    // anything not covered
    expect(assignConfidence({ origin: "extracted", source: "note" })).toBe(0.5);
  });
});

describe("bumpOnConfirmation", () => {
  it("adds 0.10 and caps at 0.95", () => {
    expect(bumpOnConfirmation(0.75)).toBeCloseTo(0.85);
    expect(bumpOnConfirmation(0.9)).toBe(0.95);
    expect(bumpOnConfirmation(0.95)).toBe(0.95);
  });
});

describe("MARKED_WRONG", () => {
  it("is 0.10", () => {
    expect(MARKED_WRONG).toBe(0.1);
  });
});
