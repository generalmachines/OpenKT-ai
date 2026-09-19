import { describe, expect, it } from "vitest";
import { get, list, register } from "../src/registry.js";
import { InvalidInputError } from "../src/errors.js";
import type { ToolProvider } from "../src/types.js";

function fakeProvider(id: string): ToolProvider {
  return {
    id,
    configSchema: {},
    listApps: async () => [],
    beginConnect: async () => ({ connectionId: `${id}-c1` }),
    getConnection: async () => ({ status: "active" }),
    call: async () => null as unknown as never,
    disconnect: async () => undefined,
  };
}

describe("registry", () => {
  it("register + get + list round-trip", () => {
    const a = fakeProvider("test-a");
    const b = fakeProvider("test-b");
    register(a);
    register(b);
    expect(get("test-a")).toBe(a);
    expect(get("test-b")).toBe(b);
    expect(get("missing")).toBeUndefined();
    const ids = list().map((p) => p.id);
    expect(ids).toContain("test-a");
    expect(ids).toContain("test-b");
  });

  it("a duplicate id throws", () => {
    register(fakeProvider("test-dup"));
    expect(() => register(fakeProvider("test-dup"))).toThrow(InvalidInputError);
  });
});
