// Builds dist/openkt-cards.html: one self-contained file (inline CSS + JS, no network).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(pkg, "src/cards.js")],
  bundle: true, format: "iife", platform: "browser", target: "es2022",
  minify: true, legalComments: "none", write: false, logLevel: "warning",
});
const js = out.outputFiles[0].text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const css = (await readFile(join(pkg, "src/cards.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "\n").trim();
const template = await readFile(join(pkg, "src/template.html"), "utf8");
const html = template.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => js);

// Guard: the default MCP Apps CSP is default-src 'none' — the bundle must not touch the network.
const shell = template + css;
const external = shell.match(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|@import|url\(/g);
if (external) throw new Error("template/CSS references external resources: " + external.join(", "));
const net = js.match(/\bfetch\(|XMLHttpRequest|new WebSocket|EventSource\(|importScripts|sendBeacon/g);
if (net) throw new Error("bundle contains network APIs: " + [...new Set(net)].join(", "));

await mkdir(join(pkg, "dist"), { recursive: true });
await writeFile(join(pkg, "dist/openkt-cards.html"), html);
const hash = createHash("sha256").update(html).digest("hex").slice(0, 12);
await writeFile(join(pkg, "dist/openkt-cards.meta.json"), JSON.stringify({ resourceUri: `ui://openkt/cards-${hash}.html`, mimeType: "text/html;profile=mcp-app", sha256_12: hash, bytes: Buffer.byteLength(html) }, null, 2) + "\n");
console.log(`dist/openkt-cards.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB  ui://openkt/cards-${hash}.html`);
