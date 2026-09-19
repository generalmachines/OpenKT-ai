# Wiring the OpenKT cards into the MCP server

Audience: whoever owns `McpServerFactoryService` in `server/`. **Implemented** in `server/apps/server/src/modules/mcp/services/mcp-card-tools.ts` (tools, resource) and `mcp-apps.ts` (capability negotiation); where it differs from this page, the resource URI is the fixed `ui://openkt/cards.html` that Spec 04 names, and tools carry `_meta.ui` only on the card tools. Everything the view assumes is on this page. Checked against the primary sources on 2026-09-19; they are listed at the end, with what could not be confirmed.

The bundle is one file, `dist/openkt-cards.html` (about 470 KB, almost all of it the official `@modelcontextprotocol/ext-apps` view SDK and its schema validation). It makes no network requests and runs under the default MCP Apps policy (`default-src 'none'`), so **do not declare `_meta.ui.csp`**.

## 1. Register the resource once

```ts
import { loadCards } from "@openkt/mcp-cards";            // { html, resourceUri, mimeType }
import { registerAppResource, registerAppTool, getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

const cards = loadCards(); // resourceUri = ui://openkt/cards-<sha256[:12]>.html

registerAppResource(server, "OpenKT cards", cards.resourceUri, { description: "Save, search results and session summary cards" }, async () => ({
  contents: [{ uri: cards.resourceUri, mimeType: RESOURCE_MIME_TYPE, text: cards.html,
    _meta: { ui: { prefersBorder: false } } }],   // the card draws its own 1px border and 16px radius
}));
```

- **SDK version.** `openkt-server` is on `@modelcontextprotocol/sdk ^1.29`. The server helpers that match it are `@modelcontextprotocol/ext-apps@^1.7.5` (peer: sdk ^1.29). `ext-apps@2` needs the split `@modelcontextprotocol/server@2` packages. The view is built with 2.0.0; the wire protocol (`2026-01-26`) is the same. The helpers only add metadata (including ChatGPT's `openai/outputTemplate` alias), so setting `_meta` by hand is also fine.
- **The URI is a cache key.** Hosts may prefetch and cache the template, and OpenAI's docs say to publish a new URI on any change. `loadCards()` already returns a content-hashed URI from `dist/openkt-cards.meta.json`; never hard-code it.
- **MIME type** must be exactly `text/html;profile=mcp-app`.
- **`_meta.ui.domain` is optional.** The spec says that when it is omitted the host uses its default sandbox origin. The card needs no stable origin (no OAuth, no CORS, no fetch), so leave it out. If a stable origin is ever needed, Claude's format is `sha256(serverUrl).hex[:32] + ".claudemcpcontent.com"`; for `https://mcp.openkt.ai/mcp` that is `3d7f25498f9561a98debc1e18de7a8d2.claudemcpcontent.com`. It is derived from the server URL, so self-hosters must compute their own.

## 2. Only attach UI when the client supports it

```ts
const ui = getUiCapability(clientCapabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE);
```

| Client | What to register |
|---|---|
| Advertises `io.modelcontextprotocol/ui` | `_meta.ui.resourceUri` on the tools in section 3, plus `kt_save_card` and the app-only `kt_commit_save`. |
| No Apps, but form elicitation (Claude Code, Cursor, VS Code) | No UI metadata, no `kt_save_card`. When `kt_save_memory` is called without `project`/`visibility` and the user can write to more than one space, elicit once: a single `enum` field whose values are the writable spaces plus "Only me". Remember the answer for the session. Under the 2026-07-28 revision this is an `InputRequiredResult` and the client retries the call. |
| Neither | Plain arguments. The skill tells the model to ask the user once and pass `project` / `visibility`. |

If capabilities are not available when tools are registered, register the UI metadata unconditionally: hosts without Apps ignore `_meta.ui`, which is why the text fallbacks in section 5 are mandatory.

## 3. Which tool opens which view

The view is picked from `structuredContent.view`. If `view` is missing the card infers it (`draft` → save, `session` → session, `items | memories | results` → results), and if there is no `structuredContent` it tries to parse the first text block as JSON, so today's `jsonAndUi` payloads still render.

| Tool | `_meta.ui` | View |
|---|---|---|
| `kt_recall`, `kt_search_memories` | `{ resourceUri }` | `results` |
| `kt_session_end` | `{ resourceUri }` | `session` |
| `kt_save_card` (new, model-visible) | `{ resourceUri }` | `save` |
| `kt_commit_save` (new) | `{ resourceUri, visibility: ["app"] }` | none; called by the card |
| `kt_save_memory` | none | none. Stays the direct, no-UI write. |

`kt_save_card(content, kind?, project?, session_id?)` **must not write**. It returns the draft and the spaces the caller can write to. Description for the model, roughly: "Show the user a card to confirm what is saved and which space it goes to. Use when the user asks to save something in a chat client and the space is not already settled. Nothing is saved until the user confirms; do not also call kt_save_memory."

`kt_commit_save` takes what `kt_save_memory` takes, so its handler can delegate to `memoryCommands.create` after re-checking write access:

```jsonc
{ "content": "Quote Northgate per store, not per seat.", "kind": "decision",
  "visibility": "project",            // "project" for a space, "personal" for Only me
  "project": "<space id>",            // omitted for Only me unless personal.project was sent
  "session_id": "<uuid>",             // when the draft carried one
  "draft_id": "d_01" }                // when the draft carried one; use it for idempotency
```

Rules: the host must hide `visibility: ["app"]` tools from the model and must reject app calls to tools without `"app"`, but **the server still authorises every `kt_commit_save` call** against the caller's grants; the space list in the card is a convenience, never the access check. Return `isError: true` with a short human sentence on failure; the card shows that text and offers "Try again".

## 4. `structuredContent` for each view

Unknown fields are ignored. Everything marked `?` is optional and the card degrades without it. All strings are rendered with `textContent`, never as HTML.

### save

```jsonc
{
  "view": "save",
  "draft": {
    "content": "Quote Northgate per store, not per seat.",   // falls back to the tool's `content` argument
    "kind": "decision",                                       // ? default "fact"
    "session_id": "…", "draft_id": "…",                       // ? echoed to kt_commit_save
    "page_hint": { "title": "Northgate — pricing", "action": "updates" }   // ? "updates" | "creates" → “updates page …”
  },
  "spaces": [                          // ONLY spaces the caller can write to (editor or owner). Never readers.
    { "id": "<space id>", "label": "sales / northgate", "sublabel": "sales team can read", "role": "editor" }
  ],
  "suggested_space_id": "<space id>",  // ? null or absent → "Only me" is preselected
  "personal": { "label": "Only me", "sublabel": "personal space", "project": "<personal space id>" }   // ? all optional
}
```

- `id` is whatever `kt_commit_save` should receive as `project` (today: `project_id` or slug).
- `sublabel` is the access line under the name; say who will be able to read it.
- The card lists the suggestion, then "Only me", then the rest. With more than four options the rest sit behind "Another space…", with a filter box above eight. As a second line of defence the card drops any entry with `role: "reader"` or `can_write: false`.
- `kt_commit_save` result: `{ "id": "<memory id>", "page": { "title": "…" } }` (both optional).
- After a save or a cancel the card sends `ui/update-model-context` with one sentence ("…saved to space X (id …). Do not save it again." / "…cancelled. Nothing was saved…").

### results

```jsonc
{
  "view": "results",
  "query": "Northgate proposal",
  "total": 4,                                        // ? defaults to items.length
  "space": { "id": "…", "label": "sales / northgate" },   // ? the scope searched; shown top right. Omit for a search across spaces.
  "items": [
    { "id": "m1", "kind": "decision", "content": "Quote Northgate per store, not per seat",
      "author": "Pratham", "source": "pricing call",  // ? source = session title or connector
      "date": "2026-09-19T09:30:00Z",                  // ? ISO → "today" / "yesterday" / "4 Sep"; any other string is shown as is
      "status": "open",                                // ? only "open" is shown
      "space": "sales / northgate" }                   // ? shown per item when the result spans spaces or no scope is given
  ]
}
```

- Also accepted: `memories` or `results` instead of `items`; `created_at`, `author_name`, `session_title`, `project_name` on rows.
- An empty `items` renders an explicit "nothing relevant found", matching the abstain rule in `architecture.md`.
- Selecting rows sends `ui/update-model-context` with **the whole current selection** (each call replaces the last, per the spec): a text block listing `[kind] statement (author; source; space; id)`, plus `structuredContent.openkt_selected` when the host lists that modality. Hosts without `updateModelContext` get a `ui/message` instead.
- Kinds map to the seven product kinds for colour only; the label shown is the server's string. Current server kinds map as `pattern | skill | debug-recipe → how-to`, `incident | anti-pattern → issue`, `context | environment | note | other → fact`.

### session

```jsonc
{
  "view": "session",
  "session": { "id": "…", "title": "Northgate proposal draft", "status": "closed",    // "open" → "session in progress"
               "space": { "label": "sales / northgate" }, "started_at": "…", "ended_at": "…" },
  "summary": "Drafted the proposal on per-store pricing…",      // falls back to the tool's `summary` argument
  "saved": [ { "kind": "decision", "content": "…", "page": { "title": "Northgate — pricing" } } ],   // ?
  "open_questions": [ "Can the legacy POS export daily sales as CSV?" ],                               // ?
  "counts": { "saved": 3, "recalled": 2, "pages_updated": 2 }                                           // ?
}
```

## 5. Text fallbacks (required)

The spec requires a meaningful `content` array even when a UI renders, and the model reads `content`, not the card.

- `kt_recall` / `kt_search_memories`: a numbered list with kind, statement, author, source, date and id. Say "Nothing relevant found." when empty.
- `kt_save_card`: "Draft shown to the user in a card. NOT saved yet. Wait for the user to confirm the space in the card." Without this line models tend to report a save that has not happened.
- `kt_commit_save`: "Saved to <space>." The card is the only caller, but hosts may log it.
- `kt_session_end`: the title, where it was filed and how many items were kept.

Keep each tool description under 2 KB; Claude Code truncates there.

## 6. What the view sends to the host

| Message | When | If the host lacks it |
|---|---|---|
| `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/size-changed` | always (SDK, auto-resize) | none needed |
| `tools/call` `kt_commit_save` | Save | no `serverTools` capability → sends a `ui/message` ("Save it to the space …") so the model finishes with `kt_save_memory` |
| `ui/update-model-context` | after save or cancel; on every selection change | results fall back to `ui/message`; the save note is skipped |

No `ui/open-link`, no display-mode requests, no downloads, no sampling.

## 7. Try it

`npm run preview -w @openkt/mcp-cards` serves `preview.html`, a fake host that loads the bundle into a sandboxed iframe (`sandbox="allow-scripts"`, CSP `default-src 'none'`), answers the handshake, plays the fixtures in `test/fixtures.js`, fakes `kt_commit_save`, and logs every message. `?host=noctx | notools | fail` exercises the fallbacks. `npm run shots` re-takes the screenshots and runs the end-to-end assertions.

## Sources

- Spec (SEP-1865, `2026-01-26`): https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx — `ui://`, MIME type, `_meta.ui.resourceUri`, `visibility`, default CSP, `domain` optional, `prefersBorder`, the `ui/*` messages, update-model-context overwrite semantics, capability negotiation, text-fallback requirement.
- Claude + ChatGPT from one codebase, and the Claude `domain` formula: https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility.md
- ChatGPT bridge (`tools/call`, `ui/message`, `ui/update-model-context` supported; `openai/outputTemplate` is an alias; URI as cache key): https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- SDK: `@modelcontextprotocol/ext-apps` 2.0.0 (npm, MIT), type definitions read from the published package.

Not verified: whether claude.ai or ChatGPT currently advertise the `structuredContent` modality for `ui/update-model-context` (the card feature-detects it); whether any host renders the card for a tool whose call the user started from a slash command rather than the model; host behaviour for `prefersBorder: false` in ChatGPT; elicitation support in claude.ai, Claude Desktop, Cowork and ChatGPT (treat as absent). No real host was available here, so rendering was verified only in the fake host.
