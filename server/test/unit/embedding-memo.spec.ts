// embed(): the same text within a few minutes is one call to the embedding
// server (the save path asks twice), in flight or done; failures are retried.

type EmbedFn = (text: string) => Promise<number[] | null>;

function loadEmbed(): EmbedFn {
  let embed: EmbedFn | undefined;
  jest.isolateModules(() => {
    embed = require("../../apps/server/src/modules/memory/repositories/embedding-bge").embed;
  });
  return embed!;
}

describe("embed() memo", () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_BACKEND = process.env.OPENKT_EMBEDDING_BACKEND;
  const vector = new Array(1024).fill(0).map((_, i) => i / 1024);
  let calls: string[];
  let fail: boolean;

  beforeAll(() => {
    process.env.OPENKT_EMBEDDING_BACKEND = "bge";
  });
  afterAll(() => {
    if (ORIGINAL_BACKEND === undefined) delete process.env.OPENKT_EMBEDDING_BACKEND;
    else process.env.OPENKT_EMBEDDING_BACKEND = ORIGINAL_BACKEND;
    global.fetch = ORIGINAL_FETCH;
  });
  beforeEach(() => {
    calls = [];
    fail = false;
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      calls.push(JSON.parse(init?.body ?? "{}").inputs[0]);
      if (fail) return new Response("down", { status: 503 });
      return new Response(JSON.stringify([vector]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  });

  it("asks the server once for the same text, in flight or already answered", async () => {
    const embed = loadEmbed();
    const [a, b] = await Promise.all([embed("The demo runs on port 8123."), embed("  The demo runs on port 8123.  ")]);
    const c = await embed("The demo runs on port 8123.");
    expect(calls).toEqual(["The demo runs on port 8123."]);
    expect(a).toEqual(vector);
    expect(b).toEqual(vector);
    expect(c).toEqual(vector);
    // Every caller gets its own copy.
    a!.push(1);
    expect(await embed("The demo runs on port 8123.")).toHaveLength(1024);
    await embed("Another fact.");
    expect(calls).toEqual(["The demo runs on port 8123.", "Another fact."]);
  });

  it("does not remember a failure", async () => {
    const embed = loadEmbed();
    fail = true;
    expect(await embed("Flaky.")).toBeNull();
    expect(calls).toEqual(["Flaky.", "Flaky."]); // one retry
    fail = false;
    expect(await embed("Flaky.")).toEqual(vector);
    expect(calls).toHaveLength(3);
  });

  it("keeps at most 512 texts: the least recently used one is asked again", async () => {
    const embed = loadEmbed();
    for (let i = 0; i < 512; i++) await embed(`fact ${i}`);
    await embed("fact 0"); // used again: now the most recent
    await embed("fact 512"); // pushes out "fact 1"
    calls = [];
    await embed("fact 0");
    await embed("fact 2");
    expect(calls).toEqual([]);
    await embed("fact 1");
    expect(calls).toEqual(["fact 1"]);
  });
});
