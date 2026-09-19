#!/usr/bin/env python3
"""Second half of the design canvas: the knowledge and MCP card artboards.

`python3 design/gen.py` runs this file too. Run on its own, it first regenerates
gen.py's artboards, because it reuses that file's fragments (sidebar, ico, page, colours).
"""
import pathlib
_FROM_GEN2 = True
exec((pathlib.Path(__file__).resolve().parent / "gen.py").read_text())

# ── Living page ──────────────────────────────────────────────────────────
def cite(n): return f'<sup class="mono" style="font-size: 10px; color: {ACC}; padding-left: 2px;">{n}</sup>'
def src(n, icon, t, who):
    return f'<a href="#" style="display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid {LINE}; text-decoration: none; color: {INK};"><span class="mono" style="font-size: 10.5px; color: {ACC}; width: 14px; padding-top: 2px;">{n}</span><span style="color: {INK3}; display: flex; padding-top: 1px;">{ico(I[icon],14)}</span><span style="display: flex; flex-direction: column; gap: 2px;"><span style="font-size: 13px;">{t}</span><span class="mono" style="font-size: 10.5px; color: {INK3};">{who}</span></span></a>'
pg = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar(nav="Spaces")}
<main style="flex-grow: 1; min-width: 0; padding: 36px 48px 0 56px; display: flex; gap: 48px;">
<article style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px;">
<div class="mono" style="font-size: 11.5px; color: {INK3}; display: flex; gap: 8px; align-items: center;">sales {ico(I["chev"],11)} northgate {ico(I["chev"],11)} pages</div>
<div style="display: flex; align-items: center; gap: 12px;">
<h1 style="margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; flex-grow: 1;">Northgate — pricing</h1>
<button style="height: 36px; padding: 0 14px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">Edit</button>
</div>
<div class="mono" style="font-size: 11.5px; color: {INK3}; display: flex; gap: 14px;"><span>kept up to date from 4 sessions</span><span>last change today 10:48</span><span style="display: flex; gap: 6px; align-items: center;">{ico(I["lock"],12)}sales team can read</span></div>
<div style="height: 1px; background: {LINE}; margin: 4px 0;"></div>
<h2 style="margin: 0; font-size: 15px; font-weight: 600;">Where it stands</h2>
<p style="margin: 0; font-size: 15px; line-height: 1.65; max-width: 640px;">Northgate wants to be priced per store, not per seat{cite(1)}. They run fourteen stores, three on a legacy POS, and want all fourteen included from the start{cite(1)}. A revised quote is due before their internal meeting on Friday; Ana owns it{cite(1)}.</p>
<h2 style="margin: 6px 0 0; font-size: 15px; font-weight: 600;">What changed</h2>
<p style="margin: 0; font-size: 15px; line-height: 1.65; max-width: 640px;"><span style="text-decoration: line-through; color: {INK3};">Per-seat pricing with a volume discount above 40 seats</span>{cite(2)} — replaced today by per-store pricing{cite(1)}.</p>
<h2 style="margin: 6px 0 0; font-size: 15px; font-weight: 600;">Open</h2>
<p style="margin: 0; font-size: 15px; line-height: 1.65; max-width: 640px;">Whether the legacy POS can export daily sales as CSV{cite(1)}. Procurement needs a security one-pager before any trial{cite(3)}.</p>
<div style="flex-grow: 1;"></div>
<footer style="display: flex; align-items: center; gap: 10px; padding: 14px 0 18px; border-top: 1px solid {LINE}; font-size: 13px; color: {INK3};"><span style="display: flex; color: {INK2};">{ico(I["spark"],15)}</span><span>Written and kept current by the model on your server. Your edits always win.</span></footer>
</article>
<aside style="width: 270px; flex-shrink: 0; padding-top: 64px; display: flex; flex-direction: column;">
<h3 class="mono" style="margin: 0 0 4px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 400; color: {INK3};">Sources</h3>
{src(1,"video","Pricing call with Northgate","Pratham · meeting · today")}
{src(2,"chat","Draft proposal v1","Ana · chatgpt · 11 Sep")}
{src(3,"note","Intro call notes","Ravi · note · 4 Sep")}
{src(4,"shot","Competitor pricing page","Pratham · screenshot · yesterday")}
<h3 class="mono" style="margin: 22px 0 8px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 400; color: {INK3};">Reached</h3>
<p style="margin: 0; font-size: 13px; line-height: 1.55; color: {INK2};">Used in 6 sessions by 3 teammates this week.</p>
</aside>
</main>
</div>'''
(P/"Page.dc.html").write_text(page("A living page", W, H, pg))

# ── Space view ───────────────────────────────────────────────────────────
def prow(t, d, meta):
    return f'<a href="#" style="display: flex; flex-direction: column; gap: 5px; padding: 14px 0; border-bottom: 1px solid {LINE}; text-decoration: none; color: {INK};"><span style="font-size: 15px; font-weight: 500;">{t}</span><span style="font-size: 13.5px; line-height: 1.5; color: {INK2};">{d}</span><span class="mono" style="font-size: 11px; color: {INK3};">{meta}</span></a>'
def mrow(icon,t,meta):
    return f'<a href="#" style="display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid {LINE}; text-decoration: none; color: {INK};"><span style="color: {INK3}; display: flex; padding-top: 2px;">{ico(I[icon],14)}</span><span style="display: flex; flex-direction: column; gap: 2px;"><span style="font-size: 13.5px;">{t}</span><span class="mono" style="font-size: 10.5px; color: {INK3};">{meta}</span></span></a>'
sp = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar(nav="Spaces")}
<main style="flex-grow: 1; min-width: 0; padding: 36px 48px 0 56px; display: flex; flex-direction: column; gap: 18px;">
<div style="display: flex; align-items: center; gap: 12px;">
<div style="display: flex; flex-direction: column; gap: 6px; flex-grow: 1;"><span class="mono" style="font-size: 11.5px; color: {INK3};">space</span><h1 style="margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.02em;">sales / northgate</h1></div>
<span style="display: flex;"><span style="width: 30px; height: 30px; border-radius: 50%; background: #ecebe7; border: 2px solid #fff; display: flex; align-items: center; justify-content: center; font-size: 11px; color: {INK2};">PB</span><span style="width: 30px; height: 30px; border-radius: 50%; background: #e3e1db; border: 2px solid #fff; margin-left: -8px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: {INK2};">AN</span><span style="width: 30px; height: 30px; border-radius: 50%; background: #ecebe7; border: 2px solid #fff; margin-left: -8px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: {INK2};">+5</span></span>
<button style="display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 36px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">{ico(I["users"],15)}Access</button>
</div>
<button style="display: flex; gap: 10px; align-items: center; padding: 0 16px; height: 48px; border-radius: 12px; border: 1px solid {LINE}; background: {SIDE}; font-size: 14px; color: {INK3}; text-align: left;">{ico(I["search"],16)}<span>Ask this space anything</span></button>
<div style="display: flex; gap: 48px; min-height: 0;">
<section style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column;">
<h2 style="margin: 0; font-size: 13px; font-weight: 500; color: {INK3}; padding-bottom: 2px;">Pages · kept current for you</h2>
{prow("Northgate — pricing","Per-store pricing requested; revised quote due Friday. Supersedes the per-seat proposal.","4 sessions · changed today")}
{prow("Northgate — people and process","Marcus leads operations; procurement signs off after a security review.","3 sessions · changed 4 Sep")}
{prow("Northgate — stores and systems","Fourteen stores, three on a legacy POS. Daily sales export still unconfirmed.","2 sessions · changed today")}
{prow("Retail pricing — what competitors charge","Three-tier pages are the norm; per-store billing appears only on top tiers.","1 session · changed yesterday")}
</section>
<aside style="width: 300px; flex-shrink: 0; display: flex; flex-direction: column;">
<h2 style="margin: 0; font-size: 13px; font-weight: 500; color: {INK3}; padding-bottom: 2px;">Recent sessions</h2>
{mrow("video","Pricing call with Northgate","Pratham · today")}
{mrow("shot","Competitor pricing page","Pratham · yesterday")}
{mrow("chat","Draft proposal v1","Ana · 11 Sep")}
{mrow("note","Intro call notes","Ravi · 4 Sep")}
</aside>
</div>
</main>
</div>'''
(P/"Space.dc.html").write_text(page("A space", W, H, sp))

# ── Settings: models ─────────────────────────────────────────────────────
def mdl(job, name, meta, state="ready"):
    st = f'<span class="mono" style="font-size: 11px; color: #3f6a3b; display: flex; align-items: center; gap: 6px; width: 84px;">{ico(I["check"],13)}ready</span>' if state=="ready" else f'<span class="mono" style="font-size: 11px; color: {INK3}; width: 84px;">{state}</span>'
    return f'''<div style="display: flex; align-items: center; gap: 16px; padding: 13px 0; border-bottom: 1px solid {LINE};">
<span style="width: 150px; flex-shrink: 0; font-size: 14px;">{job}</span>
<span style="display: flex; flex-direction: column; gap: 2px; flex-grow: 1;"><span style="font-size: 14px;">{name}</span><span class="mono" style="font-size: 11px; color: {INK3};">{meta}</span></span>
<button style="display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">Change{ico(I["down"],13)}</button>
{st}
</div>'''
models = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar(nav="Settings")}
<div style="width: 190px; flex-shrink: 0; box-sizing: border-box; padding: 40px 12px; display: flex; flex-direction: column; gap: 2px; border-right: 1px solid {LINE};">
{setnav("Connectors")}{setnav("Access defaults")}{setnav("Models", True)}{setnav("Hotkeys")}{setnav("Workspace")}{setnav("Account")}
</div>
<main style="flex-grow: 1; min-width: 0; padding: 40px 48px 0; display: flex; flex-direction: column; gap: 8px;">
<h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em;">Models</h1>
<p style="margin: 0 0 14px; font-size: 14px; line-height: 1.55; color: {INK2}; max-width: 560px;">Everything here runs on this Mac. Swap any of them, or point a job at your own endpoint.</p>
{mdl("Dictation","Parakeet, streaming","on the Neural Engine · as you speak")}
{mdl("Meetings","Omnilingual ASR 300M","1,600+ languages · Apache-2.0")}
{mdl("Understanding","Qwen3.5-4B","extracts, tags, files and summarises · also reads images · 3 GB")}
{mdl("Search","Qwen3-Embedding-0.6B","must match your server's index · 0.3 GB","downloading 62%")}
{mdl("Ranking","Qwen3-Reranker-0.6B","puts the right result first · 0.3 GB")}
<div style="height: 18px;"></div>
<div style="display: flex; align-items: center; gap: 16px; padding: 18px; border: 1px solid {LINE}; border-radius: 12px;">
<span style="display: flex; flex-direction: column; gap: 4px; flex-grow: 1;"><span style="font-size: 14px; font-weight: 500;">Use my own endpoint</span><span style="font-size: 13px; color: {INK2}; line-height: 1.5;">Any OpenAI-compatible server — Ollama, LM Studio, or one your team hosts.</span></span>
<label for="ep" style="position: absolute; left: -9999px;">Endpoint URL</label>
<input id="ep" type="text" placeholder="http://localhost:11434/v1" style="width: 280px; height: 44px; box-sizing: border-box; padding: 0 14px; border-radius: 10px; border: 1px solid {LINE}; font: inherit; font-size: 13.5px;">
</div>
</main>
</div>'''
(P/"Models.dc.html").write_text(page("Settings, models", W, H, models))

# ── MCP UI cards inside a chat host ──────────────────────────────────────
MW,MH = 760,620
def host(user_msg, card, after=""):
    return f'''<div style="width: {MW}px; height: {MH}px; box-sizing: border-box; background: #fff; padding: 28px 60px; display: flex; flex-direction: column; gap: 18px; overflow: hidden;">
<div class="mono" style="font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: {INK3};">inside any chat tool · rendered over MCP</div>
<div style="align-self: flex-end; max-width: 440px; background: {SIDE}; border-radius: 18px; padding: 11px 16px; font-size: 14.5px; line-height: 1.5;">{user_msg}</div>
{card}
{after}
</div>'''
def radio(t, d, on=False):
    dot = f'<span style="width: 18px; height: 18px; box-sizing: border-box; border-radius: 50%; border: {"5px solid "+INK if on else "1px solid #c9c8c3"}; flex-shrink: 0;"></span>'
    return f'<button style="display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 14px; border-radius: 10px; border: 1px solid {INK if on else LINE}; background: #fff; text-align: left;">{dot}<span style="display: flex; flex-direction: column; gap: 1px; flex-grow: 1;"><span style="font-size: 14px;">{t}</span><span class="mono" style="font-size: 10.5px; color: {INK3};">{d}</span></span></button>'
save = host("Save that — we quote Northgate per store from now on.", f'''<div style="border: 1px solid {LINE}; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 12px;">
<div style="display: flex; align-items: center; gap: 10px;"><span style="font-size: 13px; font-weight: 600;">OpenKT</span><span class="mono" style="font-size: 11px; color: {INK3};">save to team context</span></div>
<p style="margin: 0; font-size: 15px; line-height: 1.5;">Quote Northgate per store, not per seat.</p>
<div class="mono" style="font-size: 11px; color: {INK3}; display: flex; gap: 10px;">{chip("decision", KC["decision"])}<span>updates page “Northgate — pricing”</span></div>
<div style="display: flex; flex-direction: column; gap: 8px;">
{radio("sales / northgate","sales team can read", True)}
{radio("Only me","personal space")}
{radio("Another space…","12 spaces")}
</div>
<div style="display: flex; gap: 8px; justify-content: flex-end;">
<button style="height: 44px; padding: 0 18px; border-radius: 22px; border: 1px solid {LINE}; background: #fff; font-size: 13.5px;">Cancel</button>
<button style="height: 44px; padding: 0 22px; border-radius: 22px; border: none; background: {INK}; color: #fff; font-size: 13.5px; font-weight: 500;">Save</button>
</div>
</div>''')
(P/"MCP-Save.dc.html").write_text(page("Save card in a chat tool", MW, MH, save))

def hit(kind, t, meta):
    return f'<a href="#" style="display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid {LINE}; text-decoration: none; color: {INK};">{chip(kind if kind!="howto" else "how-to", KC[kind])}<span style="display: flex; flex-direction: column; gap: 3px; flex-grow: 1;"><span style="font-size: 14.5px; line-height: 1.45;">{t}</span><span class="mono" style="font-size: 10.5px; color: {INK3};">{meta}</span></span></a>'
search = host("Draft the Northgate proposal. What do we already know?", f'''<div style="border: 1px solid {LINE}; border-radius: 16px; padding: 18px 18px 8px; display: flex; flex-direction: column; gap: 4px;">
<div style="display: flex; align-items: center; gap: 10px; padding-bottom: 6px;"><span style="font-size: 13px; font-weight: 600;">OpenKT</span><span class="mono" style="font-size: 11px; color: {INK3}; flex-grow: 1;">4 things your team knows</span><span class="mono" style="font-size: 11px; color: {INK3};">sales / northgate</span></div>
{hit("decision","Quote Northgate per store, not per seat","Pratham · pricing call · today")}
{hit("fact","14 stores, 3 still on the legacy POS","Pratham · pricing call · today")}
{hit("howto","Procurement needs a security one-pager before any trial","Ravi · intro call notes · 4 Sep")}
{hit("question","Can the legacy POS export daily sales as CSV?","open · asked today")}
</div>''', f'<p style="margin: 0; font-size: 14.5px; line-height: 1.55; color: {INK};">Here is a draft built on per-store pricing for all fourteen stores…</p>')
(P/"MCP-Search.dc.html").write_text(page("Search card in a chat tool", MW, MH, search))

# ── index: add the new boards and notes to canvas.json ───────────────────
yC, yD = 2100, 3320
new = [("Space.dc.html","9 · A space",0,yC,W,H),("Page.dc.html","10 · A living page",W+80,yC,W,H),("Models.dc.html","11 · Local models",2*(W+80),yC,W,H),
       ("MCP-Save.dc.html","12 · Save, from any chat tool",0,yD,MW,MH),("MCP-Search.dc.html","13 · What your team knows",MW+80,yD,MW,MH)]
idx = write_index({f: {"x":x,"y":y,"w":w,"h":h,"title":t} for f,t,x,y,w,h in new}, [f for f,*_ in new],
 {"t-kb":  {"x":0,"y":yC-300,"text":"Knowledge — pages that keep themselves current","kind":"title1","maxW":3*W+2*80},
  "t-mcp": {"x":0,"y":yD-300,"text":"In other tools — cards over MCP","kind":"title1","maxW":2*MW+80}})
print("ok", len(idx["boards"]))
