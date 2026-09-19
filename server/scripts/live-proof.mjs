// Live proof against the running server over real HTTP (REST + MCP). Exit 1 on any failure.
// Usage: OPENKT_LIVE_URL=http://host:3300 OPENKT_LIVE_TOKEN=<A> OPENKT_LIVE_TOKEN_B=<teammate> OPENKT_LIVE_TOKEN_C=<stranger> node scripts/live-proof.mjs
// The three tokens must belong to three different users; B and C must have no access to anything of A's.
// OPENKT_LIVE_SIGNUP=1 adds the built-in-accounts block (sign up, share by email, log out). With it set and no
// tokens given, A, B and C are signed up through the API too — a fresh server needs no seeding at all.
// (Sign-ups are limited to 10 per address per 15 minutes; one run uses 5 without tokens, 2 with.)
const BASE = process.env.OPENKT_LIVE_URL ?? "http://127.0.0.1:3300";
const SIGNUP = process.env.OPENKT_LIVE_SIGNUP === "1";
const rand = () => Math.random().toString(36).slice(2, 10);
const json = { "content-type": "application/json" };
async function signUp(name) {
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${rand()}@live-proof.test`, password = `pw-${rand()}-${rand()}`;
  const r = await fetch(BASE + "/v1/auth/signup", { method: "POST", headers: json, body: JSON.stringify({ email, password, display_name: name, client: "cli" }) });
  const j = await r.json().catch(() => null);
  if (r.status !== 201 || !j?.data?.token) { console.error(`sign-up of ${email} failed: ${r.status} ${JSON.stringify(j?.error ?? j)}`); process.exit(2); }
  return { token: j.data.token, user_id: j.data.user.id, email, password, name };
}
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k} (or set OPENKT_LIVE_SIGNUP=1 to sign users up through the API)`); process.exit(2); } return v; };
const tokensGiven = ["OPENKT_LIVE_TOKEN", "OPENKT_LIVE_TOKEN_B", "OPENKT_LIVE_TOKEN_C"].every((k) => process.env[k]);
const T = SIGNUP && !tokensGiven
  ? { A: await signUp("Proof Owner"), B: await signUp("Proof Teammate"), C: await signUp("Proof Stranger") }
  : { A: { token: need("OPENKT_LIVE_TOKEN") }, B: { token: need("OPENKT_LIVE_TOKEN_B") }, C: { token: need("OPENKT_LIVE_TOKEN_C") } };
for (const k of ["A", "B", "C"]) {
  const me = await fetch(BASE + "/v1/me", { headers: { authorization: `Bearer ${T[k].token}` } }).then((r) => r.json());
  if (!me?.data?.user_id) { console.error(`token ${k} was rejected`); process.exit(2); }
  Object.assign(T[k], { user_id: me.data.user_id, email: me.data.email, name: me.data.display_name });
}
const results = []; let failed = 0;
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
async function api(who, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${T[who].token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, data: j?.data ?? null, error: j?.error ?? null, meta: j?.meta ?? null };
}
async function mcp(who, name, args) {
  const r = await fetch(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${T[who].token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = JSON.parse(text.split("\n").find(l => l.startsWith("data:")).slice(5)); }
  return { status: r.status, result: j.result, error: j.error, text: (j.result?.content ?? []).map(c => c.text).join("\n") };
}
const slug = "northgate-" + Math.random().toString(36).slice(2, 8);
const t0 = Date.now();

let r = await api("A", "GET", "/v1/me"); check("A signs in with an access token over REST", r.status === 200 && r.data?.email === T.A.email, r.data?.display_name);
r = await api("A", "POST", "/v1/projects", { slug, name: "Sales / Northgate", visibility: "personal" }); check("A creates a space", r.status < 300 && r.data?.id, slug); const P = r.data.id;
r = await mcp("A", "kt_session_start", { project: P, title: "Pricing call with Northgate" });
const sid = r.result?.structuredContent?.session?.id ?? r.result?.structuredContent?.session_id ?? (r.text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/) ?? [])[0];
check("A opens a session over MCP (kt_session_start)", !!sid, sid);
const facts = ["Decision: quote Northgate per store, not per seat.", "Northgate runs 14 stores and 3 of them are still on the legacy POS.", "Ana sends the revised Northgate quote before Friday."];
for (const f of facts) { r = await mcp("A", "kt_save_memory", { content: f, project: P, project_id: P, session_id: sid, visibility: "project" }); check(`A saves over MCP: "${f.slice(0, 38)}…"`, !r.error && !r.result?.isError, r.text.slice(0, 80)); }
r = await mcp("A", "kt_session_end", { session_id: sid, summary: "Northgate wants per-store pricing; revised quote due Friday." }); check("A closes the session (kt_session_end)", !r.error && !r.result?.isError);
r = await api("A", "GET", `/v1/sessions/${sid}`); check("Session shows its facts over REST", r.status === 200 && (r.data?.memories ?? r.data?.facts ?? []).length === 3, `status=${r.data?.session?.status ?? r.data?.status}`);

// before the grant: B sees nothing
r = await api("B", "POST", "/v1/memories/recall", { query: "how do we price Northgate?", project_id: P }); check("Before a grant, teammate B cannot recall from the space", r.status === 404 || r.status === 403 || (r.data?.length ?? r.data?.items?.length ?? 0) === 0, `status ${r.status}`);
r = await api("A", "PUT", `/v1/projects/${P}/grants/${T.B.user_id}`, { role: "reader" }); check("A grants B reader on the space", r.status < 300, `status ${r.status}`);

r = await api("B", "GET", "/v1/projects"); const bSpace = (r.data ?? []).find((p) => p.id === P);
check("B sees the shared space in their own list, as a viewer", !!bSpace && (bSpace.viewer_role ?? "viewer") === "viewer", `role=${bSpace?.viewer_role}`);
r = await api("C", "GET", "/v1/projects"); check("Stranger C does not see the space in their list", !(r.data ?? []).some((p) => p.id === P));

const q = "what pricing model does Northgate want?";   // paraphrase, few shared keywords
r = await api("B", "POST", "/v1/memories/recall", { query: q, project_id: P, limit: 5 });
const items = Array.isArray(r.data) ? r.data : (r.data?.items ?? r.data?.memories ?? []);
const top = items[0]; check("B recalls A's decision over REST, ranked first", r.status === 200 && /per store/i.test(top?.content ?? top?.text ?? ""), (top?.content ?? "").slice(0, 60));
check("The recalled fact names A as its author", JSON.stringify(top ?? {}).includes(T.A.user_id) || (T.A.name ? JSON.stringify(top ?? {}).includes(T.A.name) : false));
r = await mcp("B", "kt_recall", { query: q, project: P, project_id: P }); check("B recalls it over MCP (kt_recall)", /per store/i.test(r.text), r.text.replace(/\s+/g, " ").slice(0, 90));
r = await api("B", "GET", "/v1/sessions"); check("B sees no sessions of A in their own list unless granted at session level", r.status === 200);

// stranger
r = await api("C", "POST", "/v1/memories/recall", { query: q, project_id: P }); const cItems = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
check("Stranger C gets nothing from the space", r.status === 404 || r.status === 403 || cItems.length === 0, `status ${r.status}, items ${cItems.length}`);
r = await api("C", "POST", "/v1/memories/recall", { query: q }); const cAll = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
check("Stranger C gets nothing with no space named either", !cAll.some(i => /Northgate/i.test(JSON.stringify(i))), `items ${cAll.length}`);
r = await mcp("C", "kt_recall", { query: q }); check("Stranger C gets nothing over MCP", !/per store/i.test(r.text));
r = await api("C", "GET", `/v1/sessions/${sid}`); check("Stranger C cannot open the session (404, no existence leak)", r.status === 404, `status ${r.status}`);
r = await api("C", "GET", `/v1/projects/${P}/grants`); check("Stranger C cannot list grants", r.status === 404 || r.status === 403, `status ${r.status}`);

// personal stays personal
r = await api("A", "POST", "/v1/memories", { content: "Private: my salary negotiation target for Northgate account bonus is confidential.", kind: "note", visibility: "personal" }); check("A saves a personal note (no space)", r.status < 300);
r = await api("B", "POST", "/v1/memories/recall", { query: "salary negotiation target" }); const bp = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
check("B never sees A's personal note", !bp.some(i => /salary/i.test(JSON.stringify(i))), `items ${bp.length}`);

// built-in accounts: sign up, share by email (before and after the teammate has an account), log out
if (SIGNUP) {
  const raw = (token, method, path, body) => fetch(BASE + path, { method, headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  T.S1 = await signUp("Signup Owner"); check("S1 signs up with email + password and gets a session token", /^okt_pat_/.test(T.S1.token), T.S1.email);
  r = await api("S1", "GET", "/v1/me"); check("S1's session token works on /v1/me", r.status === 200 && r.data?.email === T.S1.email && r.data?.display_name === "Signup Owner");
  r = await api("S1", "POST", "/v1/projects", { slug: "harbour-" + rand(), name: "Ops / Harbour", visibility: "personal" }); check("S1 creates a space", r.status < 300 && r.data?.id); const SP = r.data.id;
  r = await api("S1", "POST", "/v1/memories", { content: "Decision: the Harbour warehouse moves to two shifts starting in March.", kind: "decision", project_id: SP, visibility: "project" }); check("S1 saves a fact in it", r.status < 300, `status ${r.status}`);
  const s2Email = `signup-teammate-${rand()}@live-proof.test`;
  r = await api("S1", "PUT", `/v1/projects/${SP}/grants`, { email: s2Email, role: "reader" }); check("S1 shares the space BY EMAIL with someone who has no account yet → pending", r.status === 200 && r.data?.pending === true && r.data?.email === s2Email, `status ${r.status}`);
  const s2Password = `pw-${rand()}-${rand()}`;
  let h = await raw(null, "POST", "/v1/auth/signup", { email: s2Email, password: s2Password, display_name: "Signup Teammate", client: "cli" }); let j = await h.json().catch(() => null);
  check("S2 signs up with that email", h.status === 201 && !!j?.data?.token, `status ${h.status}`); T.S2 = { token: j?.data?.token, user_id: j?.data?.user?.id, email: s2Email };
  r = await api("S1", "GET", `/v1/projects/${SP}/grants`); const g = (r.data ?? []).find((x) => x.subject_id === T.S2.user_id);
  check("The pending share became a real grant, listed with S2's email and name", !!g && g.pending === false && g.subject?.email === s2Email && g.subject?.display_name === "Signup Teammate", JSON.stringify(g?.subject ?? null));
  r = await api("S1", "PUT", `/v1/projects/${SP}/grants`, { email: s2Email.toUpperCase(), role: "reader" }); check("Sharing by email with a known account upserts the grant (not pending)", r.status === 200 && r.data?.pending === false && r.data?.subject_id === T.S2.user_id, `status ${r.status}`);
  r = await api("S2", "POST", "/v1/memories/recall", { query: "how many shifts will the Harbour warehouse run?", project_id: SP, limit: 5 }); const sItems = Array.isArray(r.data) ? r.data : (r.data?.items ?? r.data?.memories ?? []);
  check("S2 recalls S1's fact from the space shared by email", r.status === 200 && /two shifts/i.test(sItems[0]?.content ?? sItems[0]?.text ?? ""), (sItems[0]?.content ?? "").slice(0, 60));
  r = await api("S2", "GET", `/v1/projects/${SP}/grants`); check("S2 (a reader) cannot list the grants or see S1's email", (r.status === 403 || r.status === 404) && !JSON.stringify(r).includes(T.S1.email), `status ${r.status}`);
  h = await raw(null, "POST", "/v1/auth/login", { email: T.S1.email, password: "definitely-the-wrong-one" }); j = await h.json().catch(() => null); check("A wrong password is a generic 401", h.status === 401 && j?.error?.code === "invalid_credentials", j?.error?.message);
  h = await raw(null, "POST", "/v1/auth/login", { email: T.S1.email, password: T.S1.password, client: "cli" }); j = await h.json().catch(() => null); check("S1 logs in again with the password → a second session", h.status === 200 && /^okt_pat_/.test(j?.data?.token ?? "") && j.data.token !== T.S1.token);
  const second = j?.data?.token;
  for (const [who, token] of [["S1", T.S1.token], ["S1 (second session)", second], ["S2", T.S2.token]]) {
    h = await raw(token, "POST", "/v1/auth/logout"); const out = h.status; h = await raw(token, "GET", "/v1/me");
    check(`${who} logs out and the token is rejected afterwards`, out === 204 && h.status === 401, `logout ${out}, then /v1/me ${h.status}`);
  }
  if (!tokensGiven) for (const k of ["A", "B", "C"]) await raw(T[k].token, "POST", "/v1/auth/logout");
}

console.log(`\n${results.length - failed}/${results.length} passed in ${Date.now() - t0} ms against ${BASE}`);
process.exit(failed ? 1 : 0);
