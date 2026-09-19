import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, commitArgs, contextText, metaLine, formatDate, kindKey } from "../src/model.js";
import { fixtures } from "./fixtures.js";

test("save view: suggestion first, then Only me, then the rest", () => {
  const s = normalize(fixtures.save.result, fixtures.save.arguments);
  assert.equal(s.view, "save");
  assert.equal(s.options[0].label, "sales / northgate");
  assert.equal(s.options[1].key, "me");
  assert.equal(s.suggestedKey, s.options[0].key);
  assert.equal(s.draft.pageHint, "updates page “Northgate — pricing”");
});

test("save view: never offers a space the user cannot write to; defaults to personal", () => {
  const s = normalize({ structuredContent: { view: "save", draft: { content: "x" }, suggested_space_id: "r1",
    spaces: [{ id: "r1", label: "read only", role: "reader" }, { id: "r2", label: "flagged", can_write: false }, { id: "w1", label: "ok", role: "editor" }, { id: "w1", label: "dupe" }] } });
  assert.deepEqual(s.options.map((o) => o.label), ["Only me", "ok"]);
  assert.equal(s.suggestedKey, "me");
});

test("commit args mirror kt_save_memory and omit project for Only me", () => {
  const s = normalize(fixtures.save.result, fixtures.save.arguments);
  const team = commitArgs(s.draft, s.options[0]);
  assert.deepEqual(team, { content: "Quote Northgate per store, not per seat.", kind: "decision", visibility: "project", project: s.options[0].project, session_id: "5d1c8f6e-2a0b-4c7e-9f3d-1b2a3c4d5e6f", draft_id: "d_01" });
  const me = commitArgs(s.draft, s.options[1]);
  assert.equal(me.visibility, "personal");
  assert.equal("project" in me, false);
});

test("results view: meta line, dates, mixed spaces, legacy server rows", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  const r = normalize(fixtures.results.result);
  assert.equal(r.scope, "sales / northgate");
  assert.equal(metaLine(r.items[2], false, now), "Ravi · intro call notes · 4 Sep");
  assert.equal(metaLine(r.items[3], false, now), "open · asked today");
  assert.equal(metaLine(normalize(fixtures.resultsMixed.result).items[0], true, now), "Ojas · Claude Code session · 12 Sep · eng / platform");
  assert.equal(formatDate("2026-09-19T01:00:00Z", now), "today");
  assert.equal(formatDate("2025-12-31T01:00:00Z", now), "31 Dec 2025");
  const legacy = normalize({ content: [{ type: "text", text: JSON.stringify({ memories: [{ id: 7, kind: "anti-pattern", content: "never force-push main", created_at: "2026-09-18T10:00:00Z" }] }) }] });
  assert.equal(legacy.view, "results");
  assert.equal(kindKey(legacy.items[0].kind), "issue");
});

test("context text is cumulative and cites ids", () => {
  const r = normalize(fixtures.results.result);
  const text = contextText(r.items.slice(0, 2));
  assert.match(text, /\[decision\] Quote Northgate.*id m1/);
  assert.match(text, /\[fact\] 14 stores.*id m2/);
});

test("session view and fallbacks", () => {
  const s = normalize(fixtures.session.result);
  assert.deepEqual(s.stats, [["items kept", "3"], ["recalls", "2"], ["pages updated", "2"], ["", "42 min"]]);
  assert.equal(normalize({ isError: true, content: [{ type: "text", text: "boom" }] }).text, "boom");
  assert.equal(normalize({ content: [{ type: "text", text: "plain" }] }).view, "message");
});

test("Spec 04 field names render the same views", () => {
  const save = normalize({ structuredContent: { view: "save", statement: "Ship on Tuesdays", kind: "decision",
    spaces: [{ id: "p1", name: "Demo team", access_label: "people it is shared with can read", writable: true },
             { id: "p2", name: "Read only", writable: false }],
    default_space_id: "p1", personal: { label: "Only me", project: "me1" } } });
  assert.equal(save.view, "save");
  assert.equal(save.draft.content, "Ship on Tuesdays");
  assert.equal(save.draft.kind, "decision");
  assert.deepEqual(save.options.map((o) => o.key), ["s:p1", "me"]);
  assert.equal(save.options[0].note, "people it is shared with can read");
  assert.equal(save.suggestedKey, "s:p1");

  const search = normalize({ structuredContent: { view: "search", query: "release", space_label: "Demo team",
    items: [{ id: "m1", kind: "decision", content: "Ship on Tuesdays", author: "Ana" }], recall_id: "r1" } });
  assert.equal(search.view, "results");
  assert.equal(search.scope, "Demo team");
  assert.equal(search.items[0].author, "Ana");

  const session = normalize({ structuredContent: { view: "session", title: "Release planning", summary: "Chose Tuesdays.",
    facts: [{ kind: "decision", content: "Ship on Tuesdays" }], space: "Demo team" } });
  assert.equal(session.view, "session");
  assert.equal(session.session.title, "Release planning");
  assert.equal(session.session.space, "Demo team");
  assert.equal(session.saved.length, 1);
});

test("built bundle is self-contained", () => {
  const html = readFileSync(new URL("../dist/openkt-cards.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|\bfetch\(|XMLHttpRequest|new WebSocket/);
  assert.match(html, /kt_commit_save/);
  assert.ok(html.length < 600_000, "bundle grew past 600 KB");
});
