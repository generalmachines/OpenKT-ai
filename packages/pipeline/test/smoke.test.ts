import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/index.js";

describe("@openkt/pipeline", () => {
  it("exports its error type", () => {
    expect(new InvalidInputError("x").name).toBe("InvalidInputError");
  });
});
