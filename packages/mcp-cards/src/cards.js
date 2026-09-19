// OpenKT MCP Apps cards — one bundle, three views (save · results · session).
// The view is chosen from the tool result's structuredContent. See ../server-integration.md.
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { normalize, kindKey, metaLine, contextText, commitArgs } from "./model.js";

const COMMIT_TOOL = "kt_commit_save";
const INLINE_SPACES = 4; // more than this collapses behind "Another space…"
const root = document.getElementById("root");

const app = new App({ name: "openkt-cards", version: "0.1.0" }, {}, { autoResize: true });
let toolArgs = null; // arguments of the tool call that opened this card
let state = null; // normalized view model
const ui = { selected: null, expanded: false, filter: "", phase: "idle", error: "", pinned: new Map(), note: "" };

// ── tiny DOM helper (textContent only — never innerHTML with server data) ──
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "disabled" || k === "hidden") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const kindChip = (kind) => h("span", { class: "kind", "data-k": kindKey(kind) }, h("i", { "aria-hidden": "true" }), kind || "fact");
const head = (sub, scope) =>
  h("header", { class: "head" }, h("span", { class: "brand" }, "OpenKT"), h("span", { class: "sub mono" }, sub), scope ? h("span", { class: "scope mono", title: scope }, scope) : null);

function mount(cls, ...kids) {
  const focusKey = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-key");
  root.className = "card" + (cls ? " " + cls : "");
  root.setAttribute("aria-busy", "false");
  root.replaceChildren(...kids.flat().filter(Boolean));
  if (focusKey) {
    const again = root.querySelector('[data-key="' + CSS.escape(focusKey) + '"]');
    if (again) again.focus({ preventScroll: true });
  }
}

const can = (cap) => Boolean((app.getHostCapabilities() || {})[cap]);

// ── SAVE ───────────────────────────────────────────────────────────────────
function spaceRow(opt) {
  const checked = ui.selected === opt.key;
  return h(
    "button",
    {
      type: "button", class: "space", role: "radio", "aria-checked": String(checked), "data-key": opt.key,
      tabindex: checked || (ui.selected == null && opt.first) ? "0" : "-1", disabled: ui.phase === "saving",
      onclick: () => { ui.selected = opt.key; ui.error = ""; render(); },
    },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", { class: "txt" }, h("span", { class: "name" }, opt.label), opt.note ? h("span", { class: "note" }, opt.note) : null),
  );
}

function renderSave() {
  const d = state.draft;
  const all = state.options; // [{key, label, note, project, visibility}] — "Only me" always present
  if (ui.selected == null) ui.selected = state.suggestedKey;

  if (ui.phase === "saved" || ui.phase === "cancelled") {
    const where = all.find((o) => o.key === ui.selected);
    return mount(
      "",
      head(ui.phase === "saved" ? "saved" : "not saved"),
      h("p", { class: "statement" + (d.content.length > 420 ? " is-long" : "") }, d.content),
      h("div", { class: "metaline" }, kindChip(d.kind),
        h("span", {}, ui.phase === "saved" ? "saved to " + (where ? where.label.toLowerCase() === "only me" ? "your personal space" : where.label : "OpenKT") : "nothing was written")),
      ui.note ? h("div", { class: "metaline" }, h("span", {}, ui.note)) : null,
    );
  }

  let visible = all;
  let moreRow = null;
  let filterBox = null;
  if (all.length > INLINE_SPACES && !ui.expanded) {
    const keep = new Set([state.suggestedKey, "me", ui.selected]);
    visible = all.filter((o) => keep.has(o.key));
    const hidden = all.length - visible.length;
    moreRow = h(
      "button",
      { type: "button", class: "space more", "data-key": "__more", onclick: () => { ui.expanded = true; render(); const f = root.querySelector(".filter, .space"); if (f) f.focus(); } },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "txt" }, h("span", { class: "name" }, "Another space…"), h("span", { class: "note" }, hidden + (hidden === 1 ? " space" : " spaces"))),
    );
  } else if (ui.expanded && all.length > 8) {
    const q = ui.filter.trim().toLowerCase();
    if (q) visible = all.filter((o) => o.key === ui.selected || (o.label + " " + (o.note || "")).toLowerCase().includes(q));
    filterBox = h("input", { class: "filter", type: "search", "data-key": "__filter", placeholder: "Filter spaces", "aria-label": "Filter spaces", value: ui.filter,
      oninput: (e) => { ui.filter = e.target.value; render(); const f = root.querySelector(".filter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } } });
  }
  if (visible[0]) visible = visible.map((o, i) => ({ ...o, first: i === 0 }));

  const group = h("div", { class: ui.expanded ? "scroll" : "spaces", role: "radiogroup", "aria-label": "Save to", onkeydown: onRadioKeys }, visible.map(spaceRow));
  const hint = d.pageHint ? h("span", {}, d.pageHint) : null;

  mount(
    "",
    head("save to team context"),
    h("p", { class: "statement" + (d.content.length > 420 ? " is-long" : "") }, d.content),
    h("div", { class: "metaline" }, kindChip(d.kind), hint),
    h("div", { class: "spaces" }, filterBox, group, moreRow),
    h("div", { class: "actions" },
      ui.error ? h("span", { class: "status is-error", role: "alert" }, ui.error) : ui.phase === "saving" ? h("span", { class: "status" }, "saving…") : null,
      h("button", { type: "button", class: "btn", "data-key": "__cancel", disabled: ui.phase === "saving", onclick: onCancel }, "Cancel"),
      h("button", { type: "button", class: "btn primary", "data-key": "__save", disabled: ui.phase === "saving" || !d.content, onclick: onSave }, ui.error ? "Try again" : "Save")),
  );
}

function onRadioKeys(e) {
  const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  if (!(e.key in keys)) return;
  const radios = [...e.currentTarget.querySelectorAll('[role="radio"]:not(:disabled)')];
  const i = radios.indexOf(document.activeElement);
  if (i < 0 || !radios.length) return;
  e.preventDefault();
  const next = radios[(i + keys[e.key] + radios.length) % radios.length];
  ui.selected = next.getAttribute("data-key");
  render();
  const again = root.querySelector('[data-key="' + CSS.escape(ui.selected) + '"]');
  if (again) again.focus();
}

async function onSave() {
  const opt = state.options.find((o) => o.key === ui.selected) || state.options.find((o) => o.key === "me");
  ui.phase = "saving"; ui.error = ""; render();
  try {
    if (!can("serverTools")) {
      // Host cannot proxy tools/call from the view: hand the decision back to the model as a user message.
      await app.sendMessage({ role: "user", content: [{ type: "text", text: "Save it to " + (opt.key === "me" ? "my personal space (only me)" : 'the space "' + opt.label + '"') + "." }] });
      ui.phase = "saved"; ui.note = "sent to the assistant to finish"; return render();
    }
    const res = await app.callServerTool({ name: COMMIT_TOOL, arguments: commitArgs(state.draft, opt) });
    if (res.isError) throw new Error(firstText(res) || "The server refused the save.");
    const saved = res.structuredContent || {};
    ui.phase = "saved";
    if (saved.page && saved.page.title) ui.note = "page “" + saved.page.title + "”";
    render();
    tellModel("OpenKT: the user confirmed the save in the card. Saved " + JSON.stringify(state.draft.content) + " as " + (state.draft.kind || "fact") +
      " to " + (opt.key === "me" ? "their personal space (only them)" : 'space "' + opt.label + '"') + (saved.id ? " (id " + saved.id + ")" : "") + ". Do not save it again.");
  } catch (err) {
    ui.phase = "idle"; ui.error = String((err && err.message) || err).slice(0, 160); render();
  }
}

function onCancel() {
  ui.phase = "cancelled"; render();
  tellModel("OpenKT: the user cancelled the save card. Nothing was saved; do not retry unless they ask.");
}

// ── RESULTS ────────────────────────────────────────────────────────────────
function renderResults() {
  const items = state.items;
  const n = state.total != null ? state.total : items.length;
  const sub = items.length === 0 ? "nothing relevant found" : n + (n === 1 ? " thing" : " things") + " your team knows";
  const mixed = new Set(items.map((i) => i.space).filter(Boolean)).size > 1 || !state.scope;
  const rows = items.map((it) => {
    const on = ui.pinned.has(it.id);
    return h(
      "button",
      { type: "button", class: "item", "aria-pressed": String(on), "data-key": "i:" + it.id, title: on ? "Remove from this conversation" : "Add to this conversation", onclick: () => togglePin(it) },
      kindChip(it.kind),
      h("span", { class: "body" }, h("span", { class: "text" }, it.content),
        h("span", { class: "meta" }, h("span", {}, metaLine(it, mixed)), h("span", { class: "pin", "aria-hidden": "true" }, on ? "in context" : "add to chat"))),
    );
  });
  const pinned = ui.pinned.size;
  mount(
    "is-list",
    head(sub, state.scope),
    items.length === 0 ? h("p", { class: "empty" }, state.query ? "No saved context matches “" + state.query + "”." : "No saved context matches.") : rows,
    items.length ? h("div", { class: "foot" + (ui.error ? " is-error" : "") }, ui.error || (pinned ? pinned + " added to this conversation" : "select an item to add it to this conversation")) : null,
  );
}

async function togglePin(it) {
  if (ui.pinned.has(it.id)) ui.pinned.delete(it.id); else ui.pinned.set(it.id, it);
  ui.error = ""; render();
  const list = [...ui.pinned.values()];
  try {
    if (can("updateModelContext")) {
      // Each ui/update-model-context call REPLACES the previous one, so always send the full pinned set.
      const update = { content: [{ type: "text", text: list.length ? contextText(list) : "OpenKT: the user cleared their selection." }] };
      if (list.length && (app.getHostCapabilities().updateModelContext || {}).structuredContent) {
        update.structuredContent = { openkt_selected: list.map(({ id, kind, content, space }) => ({ id, kind, content, space })) };
      }
      await app.updateModelContext(update);
    } else if (ui.pinned.has(it.id)) {
      await app.sendMessage({ role: "user", content: [{ type: "text", text: contextText([it]) }] });
    }
  } catch (err) {
    ui.pinned.delete(it.id); ui.error = "the host declined to add this to the conversation"; render();
  }
}

// ── SESSION SUMMARY ────────────────────────────────────────────────────────
function renderSession() {
  const s = state.session;
  const list = (label, arr, row) => (arr && arr.length ? [h("p", { class: "label" }, label), h("div", { class: "rows" }, arr.map(row))] : []);
  mount(
    "",
    head(s.status === "open" ? "session in progress" : "session saved", s.space),
    s.title ? h("h1", { class: "title" }, s.title) : null,
    state.summary ? h("p", { class: "para" }, state.summary) : null,
    list("kept from this session", state.saved, (m) => h("div", { class: "item" }, kindChip(m.kind), h("span", { class: "body" }, h("span", { class: "text" }, m.content), m.page ? h("span", { class: "meta" }, "page “" + m.page + "”") : null))),
    list("still open", state.open, (q) => h("div", { class: "item" }, kindChip("question"), h("span", { class: "body" }, h("span", { class: "text" }, q)))),
    h("div", { class: "stats" }, state.stats.map(([k, v]) => h("span", {}, h("b", {}, v), k ? " " + k : ""))),
  );
}

// ── plumbing ───────────────────────────────────────────────────────────────
function renderMessage(sub, text) {
  mount("", head(sub), text ? h("p", { class: "para" }, text) : null);
}
function render() {
  if (!state) return;
  if (state.view === "save") renderSave();
  else if (state.view === "results") renderResults();
  else if (state.view === "session") renderSession();
  else renderMessage(state.isError ? "something went wrong" : "result", state.text);
}
const firstText = (res) => ((res && res.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
function tellModel(text) {
  if (can("updateModelContext")) app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
}
function applyContext(ctx) {
  if (ctx && ctx.theme) applyDocumentTheme(ctx.theme);
}

app.ontoolinput = (params) => {
  toolArgs = (params && params.arguments) || null;
  if (!state && toolArgs && typeof toolArgs.content === "string") {
    // Show the statement immediately while the server gathers writable spaces.
    mount("", head("save to team context"), h("p", { class: "statement" }, toolArgs.content), h("div", { class: "metaline" }, kindChip(toolArgs.kind), h("span", {}, "finding your spaces…")));
  }
};
app.ontoolresult = (result) => {
  state = normalize(result, toolArgs);
  ui.selected = null; ui.expanded = false; ui.filter = ""; ui.phase = "idle"; ui.error = ""; ui.note = ""; ui.pinned = new Map();
  render();
};
app.ontoolcancelled = () => { if (!state) renderMessage("cancelled", ""); };
app.onhostcontextchanged = (ctx) => applyContext(ctx);
app.onteardown = async () => ({});

app.connect().then(() => applyContext(app.getHostContext())).catch((err) => renderMessage("not connected", "This card needs an MCP Apps host. " + String((err && err.message) || "")));
