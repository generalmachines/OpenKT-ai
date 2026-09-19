const EMBEDDING_BACKEND = (
  process.env.OPENKT_EMBEDDING_BACKEND ??
  "bge"
).toLowerCase();
const BGE_URL = process.env.OPENKT_BGE_URL ?? "http://localhost:8089/embed";
const BGE_MODEL = process.env.OPENKT_BGE_MODEL ?? "BAAI/bge-m3";
const OPENAI_URL =
  process.env.OPENKT_OPENAI_EMBED_URL ??
  "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL =
  process.env.OPENKT_OPENAI_EMBED_MODEL ??
  "text-embedding-3-large";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

export const EMBEDDING_MODEL = EMBEDDING_BACKEND === "openai" ? OPENAI_MODEL : BGE_MODEL;
export const EMBEDDING_DIM = 1024;

const EMBEDDING_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 800;

// Saving a fact embeds the same text twice within milliseconds (synthesis
// dedup, then embedNow), and a room of people asking the same question embeds
// it once each. A short memo of recent texts — requests still in flight
// included — makes each of those one call to the embedding server, which is
// the bottleneck on a small host. Failures are not remembered.
const MEMO_MAX = 512;
const MEMO_TTL_MS = 10 * 60_000;
const memo = new Map<string, { at: number; vector: Promise<number[] | null> }>();

export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const now = Date.now();
  const hit = memo.get(trimmed);
  if (hit && now - hit.at < MEMO_TTL_MS) {
    memo.delete(trimmed);
    memo.set(trimmed, hit); // most recently used last
    return (await hit.vector)?.slice() ?? null;
  }
  const vector = embedUncached(trimmed);
  memo.set(trimmed, { at: now, vector });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  const settled = await vector.catch(() => null);
  if (!settled && memo.get(trimmed)?.vector === vector) memo.delete(trimmed);
  return settled?.slice() ?? null;
}

async function embedUncached(trimmed: string): Promise<number[] | null> {
  if (EMBEDDING_BACKEND === "openai") {
    return embedOpenAi(trimmed);
  }

  return (await embedBge(trimmed)) ?? (await retryBge(trimmed));
}

export function toPgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function retryBge(text: string): Promise<number[] | null> {
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return embedBge(text);
}

async function embedBge(text: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch(BGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: [text] }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as number[][];
    const vector = payload?.[0];
    return vector && vector.length === EMBEDDING_DIM ? vector : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function embedOpenAi(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: text,
        // Only OpenAI itself understands `dimensions`; local OpenAI-compatible
        // servers (llama.cpp, TEI, Infinity) reject or ignore it.
        ...(OPENAI_URL.includes("api.openai.com") ? { dimensions: EMBEDDING_DIM } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    const vector = payload.data?.[0]?.embedding;
    return vector && vector.length === EMBEDDING_DIM ? vector : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
