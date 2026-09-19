import { afterEach, describe, expect, it, vi } from "vitest";
import { createReranker } from "../src/rerank.js";
import { RECALL } from "../src/constants.js";
import type { Scored } from "../src/types.js";

let n = 0;
function item(overrides?: Partial<Scored>): Scored {
  n += 1;
  return {
    id: `item-${n}`,
    type: "fact",
    text: `text of ${n}`,
    project_id: "p1",
    cites: [],
    created_at: "2026-09-19T00:00:00Z",
    is_pinned: false,
    locked: false,
    recalls_30d_unused: 0,
    ranks: { vector: 1 },
    scope: "S3",
    fused: 0.01,
    weighted: 1,
    score: 0.01,
    ...overrides,
  };
}

function okFetch(scores: { index: number; score: number }[]): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(scores), { status: 200 }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createReranker", () => {
  it("no url → no fetch call and score = weighted", async () => {
    const fetchImpl = vi.fn();
    const { rerank } = createReranker({ fetchImpl });
    const items = [item({ weighted: 5 }), item({ weighted: 2.5 })];
    const out = await rerank("q", items);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
    expect(out[0]!.score).toBe(5);
    expect(out[1]!.score).toBe(2.5);
    expect(out.every((i) => i.rerank === undefined)).toBe(true);
  });

  it("an empty url behaves like no url", async () => {
    const fetchImpl = vi.fn();
    const { rerank } = createReranker({ url: "", fetchImpl });
    const a = item({ weighted: 3 });
    const out = await rerank("q", [a]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out[0]!.score).toBe(3);
  });

  it("a low-weighted item with rerank 0.95 ends up first", async () => {
    // weighted 10 (normalised 1.0) vs weighted 0.01; rerank says the reverse.
    const a = item({ weighted: 10 });
    const b = item({ weighted: 0.01 });
    const fetchImpl = okFetch([
      { index: 0, score: 0.0 },
      { index: 1, score: 0.95 },
    ]);
    const { rerank } = createReranker({ url: "http://rr", fetchImpl });
    const out = await rerank("q", [a, b]);
    expect(out[0]!.id).toBe(b.id);
    // blended: 0.6 × 0.95 + 0.4 × 0.001 for b; 0.6 × 0 + 0.4 × 1 for a
    expect(out[0]!.score).toBeCloseTo(0.6 * 0.95 + 0.4 * 0.001, 10);
    expect(out[1]!.score).toBeCloseTo(0.4, 10);
    expect(out[0]!.rerank).toBe(0.95);
    expect(out[1]!.rerank).toBe(0);
  });

  it("the request body, url and headers match the spec", async () => {
    const spy = vi.fn(async () => new Response("[]", { status: 200 }));
    const { rerank } = createReranker({
      url: "http://rr",
      apiKey: "sk-test",
      fetchImpl: spy as unknown as typeof fetch,
    });
    await rerank("find things", [item({ text: "alpha" }), item({ text: "beta" })]);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://rr/rerank");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "find things",
      texts: ["alpha", "beta"],
      raw_scores: false,
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("omits Authorization when no apiKey is set", async () => {
    const spy = vi.fn(async () => new Response("[]", { status: 200 }));
    const { rerank } = createReranker({ url: "http://rr", fetchImpl: spy as unknown as typeof fetch });
    await rerank("q", [item()]);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("only the first rerankTop texts are sent; the rest keep score = 0.4 × normalised", async () => {
    const spy = vi.fn(async () =>
      new Response(
        JSON.stringify(
          Array.from({ length: RECALL.rerankTop }, (_, i) => ({ index: i, score: 0.5 })),
        ),
        { status: 200 },
      ),
    );
    const { rerank } = createReranker({ url: "http://rr", fetchImpl: spy as unknown as typeof fetch });
    const items = Array.from({ length: 60 }, (_, i) => item({ id: `i-${i}`, text: `t-${i}` }));
    const out = await rerank("q", items);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { texts: string[] };
    expect(body.texts).toHaveLength(RECALL.rerankTop);
    expect(body.texts[0]).toBe("t-0");
    // items beyond rerankTop: score = 0.4 × normalised, no rerank set
    const tail = out.find((i) => i.id === "i-59")!;
    expect(tail.rerank).toBeUndefined();
    expect(tail.score).toBeCloseTo(0.4, 12);
    const head = out.find((i) => i.id === "i-0")!;
    expect(head.rerank).toBe(0.5);
  });

  it.each([
    ["HTTP 500", undefined],
    ["a thrown fetch", "throw"],
    ["a body that is not an array", "not-array"],
    ["an array of the wrong length", "wrong-length"],
    ["a non-finite score (NaN)", "nan"],
    ["a score above 1", "too-big"],
  ])("%s → fallback + onError once", async (_name, mode) => {
    let fetchImpl: typeof fetch;
    if (mode === undefined) {
      fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    } else if (mode === "throw") {
      fetchImpl = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
    } else if (mode === "not-array") {
      fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ index: 0, score: 0.5 }), { status: 200 }),
      ) as unknown as typeof fetch;
    } else if (mode === "wrong-length") {
      // one item in, an empty array back → wrong length
      fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify([]), { status: 200 }),
      ) as unknown as typeof fetch;
    } else if (mode === "nan") {
      fetchImpl = okFetch([{ index: 0, score: Number.NaN }]);
    } else {
      fetchImpl = okFetch([{ index: 0, score: 1.5 }]);
    }
    const onError = vi.fn();
    const { rerank } = createReranker({ url: "http://rr", fetchImpl, onError });
    const a = item({ weighted: 4 });
    const out = await rerank("q", [a]);
    expect(onError).toHaveBeenCalledOnce();
    // the no-rerank result: input unchanged, score = weighted
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(a.id);
    expect(out[0]!.score).toBe(4);
    expect(out[0]!.rerank).toBeUndefined();
  });

  it("a request slower than timeoutMs falls back", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ) as unknown as typeof fetch;
      const onError = vi.fn();
      const { rerank } = createReranker({ url: "http://rr", timeoutMs: 50, fetchImpl, onError });
      const a = item({ weighted: 2 });
      const pending = rerank("q", [a]);
      await vi.advanceTimersByTimeAsync(50);
      const out = await pending;
      expect(onError).toHaveBeenCalledOnce();
      expect(out[0]!.score).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
