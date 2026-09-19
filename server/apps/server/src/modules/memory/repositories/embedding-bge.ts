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

export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

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
