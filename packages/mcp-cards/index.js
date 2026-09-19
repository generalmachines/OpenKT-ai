// Server-side helper: read the built bundle and its content-hashed ui:// URI.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CARDS_MIME_TYPE = "text/html;profile=mcp-app";
export const CARDS_HTML_PATH = fileURLToPath(new URL("./dist/openkt-cards.html", import.meta.url));
const META_PATH = fileURLToPath(new URL("./dist/openkt-cards.meta.json", import.meta.url));

/** @returns {{ html: string, resourceUri: string, mimeType: string }} */
export function loadCards() {
  const meta = JSON.parse(readFileSync(META_PATH, "utf8"));
  return { html: readFileSync(CARDS_HTML_PATH, "utf8"), resourceUri: meta.resourceUri, mimeType: CARDS_MIME_TYPE };
}
