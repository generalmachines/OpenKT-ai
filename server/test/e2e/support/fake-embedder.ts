// A stand-in for the embedding server (`OPENKT_BGE_URL`, TEI `/embed` shape):
// a bag of lower-cased words hashed into 1024 dimensions and L2-normalised, so
// two statements with the same words have cosine 1 and unrelated ones ≈ 0.
import { createServer, type Server } from "node:http";

const DIM = 1024;

export function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM]! += 1;
  }
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export async function startFakeEmbedder(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { inputs } = JSON.parse(body || "{}") as { inputs?: string[] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify((inputs ?? []).map(fakeVector)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/embed`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
