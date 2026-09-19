import { lastValueFrom, of } from "rxjs";

import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";

// Pure interceptor test — exercises the wire-shape contract without
// spinning a Nest module. Catches the cases that the CLI / dashboard
// rely on:
//
//   1. camelCase → snake_case at every depth
//   2. snake_case keys pass through untouched (idempotent)
//   3. arrays preserve element shape, plain objects only
//   4. non-plain objects (Date, Buffer) are not key-walked
//   5. null / undefined survive

const intercept = (value: unknown) => {
  const interceptor = new SnakeCaseResponseInterceptor();
  return lastValueFrom(
    interceptor.intercept({} as never, { handle: () => of(value) } as never),
  );
};

describe("SnakeCaseResponseInterceptor", () => {
  it("converts camelCase keys at every depth", async () => {
    const out = await intercept({
      userId: "u1",
      displayName: "Pat",
      nestedShape: { ownerUserId: "u1", createdAt: "2026-04-29" },
      lists: [{ projectId: "p1" }, { projectId: "p2" }],
    });
    expect(out).toEqual({
      user_id: "u1",
      display_name: "Pat",
      nested_shape: { owner_user_id: "u1", created_at: "2026-04-29" },
      lists: [{ project_id: "p1" }, { project_id: "p2" }],
    });
  });

  it("is idempotent on already-snake_case keys", async () => {
    const input = {
      project_id: "p1",
      tag_slugs: ["a", "b"],
      meta: { has_more: false, next_cursor: null },
    };
    const out = await intercept(input);
    expect(out).toEqual(input);
  });

  it("preserves non-plain objects (Date) without key-walking", async () => {
    const created = new Date("2026-04-29T00:00:00Z");
    const out = await intercept({ createdAt: created }) as { created_at: Date };
    expect(out.created_at).toBeInstanceOf(Date);
    expect(out.created_at.toISOString()).toBe("2026-04-29T00:00:00.000Z");
  });

  it("survives null and undefined", async () => {
    expect(await intercept(null)).toBeNull();
    expect(await intercept(undefined)).toBeUndefined();
  });

  it("walks the standard envelope shape", async () => {
    const out = await intercept({
      data: { userId: "u1", displayName: "Pat" },
      meta: null,
      error: null,
    });
    expect(out).toEqual({
      data: { user_id: "u1", display_name: "Pat" },
      meta: null,
      error: null,
    });
  });

  it("handles paged responses with camelCase meta keys", async () => {
    const out = await intercept({
      data: [{ memoryId: "m1" }, { memoryId: "m2" }],
      meta: { hasMore: true, nextCursor: "abc" },
      error: null,
    });
    expect(out).toEqual({
      data: [{ memory_id: "m1" }, { memory_id: "m2" }],
      meta: { has_more: true, next_cursor: "abc" },
      error: null,
    });
  });
});
