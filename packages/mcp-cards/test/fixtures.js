// Fake tool results used by preview.html, the screenshot script and the unit tests.
// Shapes are the contract documented in ../server-integration.md.
const manySpaces = [
  ["sales / northgate", "sales team can read"], ["sales / pipeline", "sales team can read"], ["product / roadmap", "everyone can read"],
  ["eng / platform", "engineering can read"], ["eng / mobile", "engineering can read"], ["eng / incidents", "engineering can read"],
  ["ops / suppliers", "ops team can read"], ["ops / hiring", "founders can read"], ["marketing / voice", "everyone can read"],
  ["marketing / launches", "marketing can read"], ["ideas", "everyone can read"], ["customers / brightwell", "sales team can read"],
  ["customers / a very long customer space name that has to truncate nicely", "sales team can read"],
].map(([label, sublabel], i) => ({ id: "0b6f0d1e-0000-4000-8000-0000000000" + String(10 + i), label, sublabel, role: i % 3 ? "editor" : "owner" }));

export const fixtures = {
  save: {
    toolName: "kt_save_card",
    arguments: { content: "Quote Northgate per store, not per seat.", kind: "decision" },
    result: {
      content: [{ type: "text", text: "Draft shown to the user in a card. NOT saved yet — wait for the user to confirm the space in the card." }],
      structuredContent: {
        view: "save",
        draft: { draft_id: "d_01", content: "Quote Northgate per store, not per seat.", kind: "decision", session_id: "5d1c8f6e-2a0b-4c7e-9f3d-1b2a3c4d5e6f", page_hint: { title: "Northgate — pricing", action: "updates" } },
        spaces: manySpaces,
        suggested_space_id: manySpaces[0].id,
        personal: { label: "Only me", sublabel: "personal space" },
      },
    },
  },
  saveFew: {
    toolName: "kt_save_card",
    arguments: { content: "Staging uses port 8093; production stays on 443 behind the load balancer. The seed script takes about two minutes and must be re-run after every schema change.", kind: "how-to" },
    result: {
      content: [{ type: "text", text: "Draft shown to the user in a card. NOT saved yet." }],
      structuredContent: {
        view: "save",
        draft: { content: "Staging uses port 8093; production stays on 443 behind the load balancer. The seed script takes about two minutes and must be re-run after every schema change.", kind: "how-to" },
        spaces: manySpaces.slice(3, 5),
        suggested_space_id: null,
      },
    },
  },
  results: {
    toolName: "kt_recall",
    arguments: { query: "Northgate proposal" },
    result: {
      content: [{ type: "text", text: "4 results for “Northgate proposal” in sales / northgate:\n1. [decision] Quote Northgate per store, not per seat — Pratham, pricing call, today\n2. [fact] 14 stores, 3 still on the legacy POS — Pratham, pricing call, today\n3. [how-to] Procurement needs a security one-pager before any trial — Ravi, intro call notes, 4 Sep\n4. [question] Can the legacy POS export daily sales as CSV? — open" }],
      structuredContent: {
        view: "results", query: "Northgate proposal", total: 4, space: { id: manySpaces[0].id, label: "sales / northgate" },
        items: [
          { id: "m1", kind: "decision", content: "Quote Northgate per store, not per seat", author: "Pratham", source: "pricing call", date: "today", space: "sales / northgate" },
          { id: "m2", kind: "fact", content: "14 stores, 3 still on the legacy POS", author: "Pratham", source: "pricing call", date: "today", space: "sales / northgate" },
          { id: "m3", kind: "how-to", content: "Procurement needs a security one-pager before any trial", author: "Ravi", source: "intro call notes", date: "2026-09-04T10:00:00Z", space: "sales / northgate" },
          { id: "m4", kind: "question", content: "Can the legacy POS export daily sales as CSV?", status: "open", date: "asked today", space: "sales / northgate" },
        ],
      },
    },
  },
  resultsMixed: {
    toolName: "kt_search_memories",
    arguments: { query: "token refresh" },
    result: {
      content: [{ type: "text", text: "3 results for “token refresh” across your spaces." }],
      structuredContent: {
        view: "results", query: "token refresh", total: 3,
        items: [
          { id: "a1", kind: "issue", content: "Refresh tokens rotated twice in parallel tabs log the user out; serialise refresh behind a single in-flight promise", author: "Ojas", source: "Claude Code session", date: "2026-09-12T08:00:00Z", space: "eng / platform" },
          { id: "a2", kind: "action", content: "Move the mobile app to the same refresh lock before the 2.4 release", author: "Pratham", source: "standup", date: "2026-09-15T08:00:00Z", space: "eng / mobile" },
          { id: "a3", kind: "idea", content: "Offer a read-only offline mode when refresh fails instead of a hard sign-out", author: "Ravi", source: "voice note", date: "2026-08-30T08:00:00Z", space: "ideas" },
        ],
      },
    },
  },
  resultsEmpty: {
    toolName: "kt_recall",
    arguments: { query: "vendor contract renewal" },
    result: { content: [{ type: "text", text: "Nothing relevant found." }], structuredContent: { view: "results", query: "vendor contract renewal", total: 0, items: [] } },
  },
  session: {
    toolName: "kt_session_end",
    arguments: { session_id: "5d1c8f6e-2a0b-4c7e-9f3d-1b2a3c4d5e6f" },
    result: {
      content: [{ type: "text", text: "Session closed: “Northgate proposal draft”. 3 items kept in sales / northgate." }],
      structuredContent: {
        view: "session",
        session: { id: "5d1c8f6e-2a0b-4c7e-9f3d-1b2a3c4d5e6f", title: "Northgate proposal draft", status: "closed", space: { label: "sales / northgate" }, started_at: "2026-09-19T09:02:00Z", ended_at: "2026-09-19T09:44:00Z" },
        summary: "Drafted the Northgate proposal on per-store pricing for all fourteen stores. Procurement still needs the security one-pager before a trial can start.",
        saved: [
          { kind: "decision", content: "Quote Northgate per store, not per seat", page: { title: "Northgate — pricing" } },
          { kind: "action", content: "Send the security one-pager to procurement before Friday", page: { title: "Northgate — procurement" } },
          { kind: "fact", content: "Trial scope is the three legacy-POS stores first" },
        ],
        open_questions: ["Can the legacy POS export daily sales as CSV?"],
        counts: { saved: 3, recalled: 2, pages_updated: 2 },
      },
    },
  },
};
