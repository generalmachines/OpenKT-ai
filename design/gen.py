# Generates the .dc.html artboards from shared fragments (own content only).
import json, datetime, pathlib
P = pathlib.Path("project")
FONT = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">'
INK, INK2, INK3, LINE, SIDE, ACC = "#1a1a18", "#55544f", "#6b6a65", "#e8e7e3", "#f7f7f5", "#b4532a"
BASE = f"""body{{margin:0;font-family:'Geist',system-ui,sans-serif;color:{INK};background:#fff;-webkit-font-smoothing:antialiased}}
a{{color:{ACC}}}a:hover{{color:#8f3f1e}}
button{{font:inherit;color:inherit;cursor:pointer}}
.mono{{font-family:'Geist Mono',ui-monospace,monospace}}"""

def ico(d, s=16, w=1.6):
    return f'<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>'
I = dict(
 search='<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>',
 plus='<path d="M12 5v14M5 12h14"></path>',
 mic='<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>',
 shot='<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"></path>',
 users='<circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0M16 5.2a3.2 3.2 0 0 1 0 5.6M18 20a6 6 0 0 0-2.5-4.9"></path>',
 gear='<path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle>',
 lock='<rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>',
 check='<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
 chev='<path d="M9 6l6 6-6 6"></path>',
 code='<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"></path>',
 chat='<path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"></path>',
 video='<rect x="3" y="6" width="13" height="12" rx="2"></rect><path d="M16 10.5l5-3v9l-5-3"></path>',
 note='<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5"></path>',
 spark='<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"></path>',
 folder='<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
 more='<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
 down='<path d="M6 9l6 6 6-6"></path>',
 agent='<rect x="5" y="8" width="14" height="11" rx="3"></rect><path d="M12 8V4M9 13v1.5M15 13v1.5"></path>',
)

def page(title, w, h, body, extra_css=""):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{FONT}
<style>
{BASE}
{extra_css}
</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
"""

def srow(icon, title, sub, active=False):
    bg = "#ecebe7" if active else "transparent"
    return f'''<a href="#" style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; background: {bg}; color: {INK}; text-decoration: none;">
<span style="color: {INK3}; padding-top: 2px; display: flex;">{ico(I[icon],15)}</span>
<span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
<span style="font-size: 13.5px; font-weight: {500 if active else 400}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{title}</span>
<span class="mono" style="font-size: 11px; color: {INK3};">{sub}</span>
</span></a>'''

def sidebar(active="Pricing call with Northgate", nav=""):
    def lab(t): return f'<div class="mono" style="font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: {INK3}; padding: 14px 10px 6px;">{t}</div>'
    def navrow(icon, t):
        on = (t == nav)
        return f'<a href="#" style="display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; font-size: 13.5px; color: {INK}; text-decoration: none; background: {"#ecebe7" if on else "transparent"}; font-weight: {500 if on else 400};"><span style="color: {INK2}; display: flex;">{ico(I[icon],16)}</span>{t}</a>'
    rows = [("video","Pricing call with Northgate","meeting · 42 min"),("code","Fix auth refresh storm","claude code · openkt"),("mic","Idea: per-store onboarding kit","voice · ideas")]
    rows2 = [("chat","Q4 launch messaging","chatgpt · marketing"),("agent","Inbox triage","hermes · personal"),("shot","Competitor pricing page","screenshot · sales"),("note","Hiring plan notes","note · founders")]
    a = "\n".join(srow(i,t,s,active=(t==active and not nav)) for i,t,s in rows)
    b = "\n".join(srow(i,t,s) for i,t,s in rows2)
    return f'''<nav aria-label="Sessions" style="width: 272px; flex-shrink: 0; box-sizing: border-box; height: 100%; background: {SIDE}; border-right: 1px solid {LINE}; padding: 14px 10px; display: flex; flex-direction: column; gap: 2px;">
<div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 10px 12px;">
<span style="font-size: 15px; font-weight: 600; letter-spacing: -0.01em;">OpenKT</span>
<span class="mono" style="font-size: 10.5px; color: {INK3}; display: flex; align-items: center; gap: 6px;"><span style="width: 6px; height: 6px; border-radius: 50%; background: #4f7a4a; display: inline-block;"></span>local</span>
</div>
<button style="display: flex; gap: 10px; align-items: center; padding: 9px 10px; border-radius: 8px; border: 1px solid {LINE}; background: #fff; font-size: 13.5px; color: {INK3}; text-align: left; min-height: 44px;">{ico(I["search"],15)}<span style="flex-grow: 1;">Search all context</span><span class="mono" style="font-size: 11px;">⌘K</span></button>
<div style="height: 6px;"></div>
{navrow("plus","New note")}
{lab("Today")}
{a}
{lab("Yesterday")}
{b}
<div style="flex-grow: 1;"></div>
{navrow("folder","Spaces")}
{navrow("spark","Skills")}
{navrow("gear","Settings")}
</nav>'''

def chip(t, color):
    return f'<span class="mono" style="display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: {INK2}; width: 78px; flex-shrink: 0;"><span style="width: 7px; height: 7px; border-radius: 2px; background: {color}; display: inline-block;"></span>{t}</span>'
KC = dict(decision="#b4532a", action="#4f7a4a", fact="#4f6471", question="#9b771a", idea="#7a5a8c", howto="#55544f")

def ctx(kind, text, who):
    return f'''<div style="display: flex; align-items: center; gap: 14px; padding: 13px 0; border-bottom: 1px solid {LINE};">
{chip(kind if kind!="howto" else "how-to", KC[kind])}
<span style="flex-grow: 1; font-size: 14.5px; line-height: 1.45;">{text}</span>
<span class="mono" style="font-size: 11px; color: {INK3}; white-space: nowrap;">{who}</span>
</div>'''

def tabs(active):
    out=[]
    for t in ["Summary","Context · 6","Transcript","Access"]:
        on = t.startswith(active)
        out.append(f'<a href="#" style="padding: 10px 2px; font-size: 13.5px; text-decoration: none; color: {INK if on else INK3}; font-weight: {500 if on else 400}; border-bottom: 2px solid {INK if on else "transparent"}; margin-bottom: -1px;">{t}</a>')
    return f'<div style="display: flex; gap: 22px; border-bottom: 1px solid {LINE};">' + "".join(out) + '</div>'

def header():
    return f'''<header style="display: flex; flex-direction: column; gap: 10px;">
<div style="display: flex; align-items: center; gap: 12px;">
<h1 style="margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; flex-grow: 1;">Pricing call with Northgate</h1>
<button style="display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 36px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">{ico(I["users"],15)}Share</button>
<button aria-label="More" style="width: 36px; height: 36px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; display: flex; align-items: center; justify-content: center;">{ico(I["more"],16)}</button>
</div>
<div class="mono" style="display: flex; gap: 14px; align-items: center; font-size: 11.5px; color: {INK3};">
<span style="display: flex; gap: 6px; align-items: center;">{ico(I["video"],13)}meeting · 42 min · today 10:02</span>
<span>sales / northgate</span>
<span style="display: flex; gap: 6px; align-items: center;">{ico(I["lock"],13)}sales team can read</span>
</div>
</header>'''

W,H = 1280,800
# ── Main: session summary ────────────────────────────────────────────────
main = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar()}
<main style="flex-grow: 1; min-width: 0; padding: 36px 56px 0; display: flex; flex-direction: column; gap: 22px;">
{header()}
{tabs("Summary")}
<section style="display: flex; flex-direction: column; gap: 10px; max-width: 760px;">
<p style="margin: 0; font-size: 16px; line-height: 1.6; color: {INK};">Northgate wants pricing per store, not per seat. They run fourteen stores, three still on the legacy POS, and want those three included from day one. No decision yet — they meet internally on Friday. Ana owns the revised quote.</p>
</section>
<section style="display: flex; flex-direction: column; max-width: 860px;">
<div style="display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 4px;">
<h2 style="margin: 0; font-size: 13px; font-weight: 500; color: {INK3};">Context saved from this session</h2>
<span class="mono" style="font-size: 11px; color: {INK3};">extracted on this Mac</span>
</div>
{ctx("decision","Quote Northgate per store, not per seat","Ana, Ravi")}
{ctx("action","Ana sends the revised quote before Friday","Ana")}
{ctx("fact","Northgate runs 14 stores, 3 still on the legacy POS","Marcus (Northgate)")}
{ctx("question","Can the legacy POS export daily sales as CSV?","open")}
{ctx("howto","Their procurement needs a security one-pager before any trial","Marcus (Northgate)")}
</section>
<div style="flex-grow: 1;"></div>
<footer style="display: flex; align-items: center; gap: 12px; padding: 14px 0 18px; border-top: 1px solid {LINE}; color: {INK3}; font-size: 13px;">
<span style="display: flex; color: {INK2};">{ico(I["mic"],16)}</span>
<span style="flex-grow: 1;">Hold <span class="mono" style="padding: 2px 6px; border: 1px solid {LINE}; border-radius: 5px; font-size: 11.5px; color: {INK2};">fn</span> to add to this session</span>
<span class="mono" style="font-size: 11px;">retrievable from 4 connected tools</span>
</footer>
</main>
</div>'''
(P/"Main.dc.html").write_text(page("Session summary", W, H, main))

# ── Access ───────────────────────────────────────────────────────────────
def person(initials, name, sub, role, tone="#ecebe7"):
    return f'''<div style="display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid {LINE};">
<span style="width: 34px; height: 34px; border-radius: 50%; background: {tone}; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 500; color: {INK2}; flex-shrink: 0;">{initials}</span>
<span style="display: flex; flex-direction: column; gap: 2px; flex-grow: 1;"><span style="font-size: 14.5px;">{name}</span><span class="mono" style="font-size: 11px; color: {INK3};">{sub}</span></span>
<button style="display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid {LINE}; background: #fff; font-size: 13px; min-width: 104px; justify-content: space-between;">{role}{ico(I["down"],13)}</button>
</div>'''
access = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar()}
<main style="flex-grow: 1; min-width: 0; padding: 36px 56px 0; display: flex; flex-direction: column; gap: 22px;">
{header()}
{tabs("Access")}
<div style="display: flex; gap: 56px; align-items: flex-start;">
<section style="flex-grow: 1; max-width: 560px; display: flex; flex-direction: column;">
<h2 style="margin: 0 0 4px; font-size: 13px; font-weight: 500; color: {INK3};">Who can use this context</h2>
<label for="invite" style="position: absolute; left: -9999px;">Add people or teams</label>
<div style="display: flex; gap: 8px; padding: 10px 0 6px;">
<input id="invite" type="text" placeholder="Add people or teams" style="flex-grow: 1; height: 44px; box-sizing: border-box; padding: 0 14px; border-radius: 10px; border: 1px solid {LINE}; font: inherit; font-size: 14px;">
<button style="height: 44px; padding: 0 18px; border-radius: 10px; border: none; background: {INK}; color: #fff; font-size: 13.5px; font-weight: 500;">Invite</button>
</div>
{person("PB","Pratham Bhatnagar","you · recorded this session","Owner")}
{person("ST","Sales team","6 people · inherited from space sales / northgate","Reader")}
{person("AN","Ana Reyes","added by you","Editor")}
{person("OS","Ojas Sinha","engineering · asked for access","Reader")}
</section>
<aside style="width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 18px; padding-top: 4px;">
<div style="display: flex; flex-direction: column; gap: 8px; padding: 18px; border: 1px solid {LINE}; border-radius: 12px;">
<h3 style="margin: 0; font-size: 13.5px; font-weight: 500;">What each role means</h3>
<p style="margin: 0; font-size: 13px; line-height: 1.55; color: {INK2};"><strong style="font-weight: 500; color: {INK};">Reader</strong> — their tools can retrieve this context. They cannot open the transcript.</p>
<p style="margin: 0; font-size: 13px; line-height: 1.55; color: {INK2};"><strong style="font-weight: 500; color: {INK};">Editor</strong> — reads the transcript, corrects and adds context.</p>
<p style="margin: 0; font-size: 13px; line-height: 1.55; color: {INK2};"><strong style="font-weight: 500; color: {INK};">Owner</strong> — changes access, deletes the session.</p>
</div>
<div style="display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: {INK2}; line-height: 1.55;">
<span style="display: flex; gap: 8px; align-items: center; color: {INK};">{ico(I["lock"],14)}The recording never left this Mac</span>
<span>Only the transcript and saved context sync. Meetings default to the space they are filed in — change that in Settings.</span>
</div>
</aside>
</div>
</main>
</div>'''
(P/"Access.dc.html").write_text(page("Session access", W, H, access))

# ── Settings: connectors ─────────────────────────────────────────────────
def conn(icon, name, sub, default, on=True):
    state = f'<span class="mono" style="font-size: 11px; color: #3f6a3b; display: flex; align-items: center; gap: 6px; width: 96px;">{ico(I["check"],13)}connected</span>' if on else f'<button style="height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid {LINE}; background: #fff; font-size: 13px; width: 96px;">Connect</button>'
    dd = f'<button style="display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid {LINE}; background: #fff; font-size: 13px; width: 218px; justify-content: space-between; color: {INK if on else INK3};">{default}{ico(I["down"],13)}</button>'
    return f'''<div style="display: flex; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid {LINE};">
<span style="width: 36px; height: 36px; border-radius: 9px; background: {SIDE}; border: 1px solid {LINE}; display: flex; align-items: center; justify-content: center; color: {INK2}; flex-shrink: 0;">{ico(I[icon],17)}</span>
<span style="display: flex; flex-direction: column; gap: 2px; flex-grow: 1;"><span style="font-size: 14.5px;">{name}</span><span class="mono" style="font-size: 11px; color: {INK3};">{sub}</span></span>
{dd}
{state}
</div>'''
def setnav(t, on=False):
    return f'<a href="#" style="padding: 9px 12px; border-radius: 8px; font-size: 13.5px; text-decoration: none; color: {INK}; background: {"#ecebe7" if on else "transparent"}; font-weight: {500 if on else 400};">{t}</a>'
settings = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar(nav="Settings")}
<div style="width: 190px; flex-shrink: 0; box-sizing: border-box; padding: 40px 12px; display: flex; flex-direction: column; gap: 2px; border-right: 1px solid {LINE};">
{setnav("Connectors", True)}{setnav("Access defaults")}{setnav("Models")}{setnav("Hotkeys")}{setnav("Workspace")}{setnav("Account")}
</div>
<main style="flex-grow: 1; min-width: 0; padding: 40px 48px 0; display: flex; flex-direction: column; gap: 8px;">
<h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em;">Connectors</h1>
<p style="margin: 0 0 14px; font-size: 14px; line-height: 1.55; color: {INK2}; max-width: 560px;">Every conversation in a connected tool becomes a session here. Choose who can use what each tool produces — you can always change a single session later.</p>
<div style="display: flex; gap: 16px; padding-bottom: 6px; border-bottom: 1px solid {LINE};" class="mono">
<span style="flex-grow: 1; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: {INK3}; padding-left: 52px;">tool</span>
<span style="width: 218px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: {INK3};">new sessions are shared with</span>
<span style="width: 96px;"></span>
</div>
{conn("code","Claude Code","sessions follow the folder's space","The space's team · read")}
{conn("chat","ChatGPT","remote MCP · signed in","Only me")}
{conn("chat","Claude","remote MCP · signed in","Only me")}
{conn("agent","Hermes","personal agent · access token","Only me")}
{conn("video","Meetings","Zoom, Meet, Teams · no bot joins","The space I file it in · read")}
{conn("mic","Voice and screenshots","hold fn · on this Mac","Ideas · team can read")}
{conn("code","Cursor","not connected","Only me", on=False)}
</main>
</div>'''
(P/"Connectors.dc.html").write_text(page("Settings, connectors", W, H, settings))

# ── Skills ───────────────────────────────────────────────────────────────
def skill(name, desc, meta, team):
    return f'''<div style="display: flex; flex-direction: column; gap: 10px; padding: 18px; border: 1px solid {LINE}; border-radius: 12px; background: #fff;">
<div style="display: flex; align-items: center; gap: 10px;"><span style="color: {INK2}; display: flex;">{ico(I["spark"],16)}</span><span style="font-size: 15px; font-weight: 500; flex-grow: 1;">{name}</span><span class="mono" style="font-size: 11px; color: {INK3};">{team}</span></div>
<p style="margin: 0; font-size: 13.5px; line-height: 1.55; color: {INK2};">{desc}</p>
<div style="display: flex; align-items: center; gap: 10px; padding-top: 2px;"><span class="mono" style="font-size: 11px; color: {INK3}; flex-grow: 1;">{meta}</span><button style="height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">Run</button></div>
</div>'''
skills = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar(nav="Skills")}
<main style="flex-grow: 1; min-width: 0; padding: 40px 56px 0; display: flex; flex-direction: column; gap: 10px;">
<div style="display: flex; align-items: center; gap: 12px;">
<h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; flex-grow: 1;">Skills</h1>
<button style="display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 20px; border: none; background: {INK}; color: #fff; font-size: 13.5px; font-weight: 500;">{ico(I["plus"],15)}New skill</button>
</div>
<p style="margin: 0 0 12px; font-size: 14px; line-height: 1.55; color: {INK2}; max-width: 600px;">The way your team does things, written once. Run one here on the local model, or let any connected tool pick it up with the context it needs.</p>
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;">
{skill("Sharpen a marketing message","Rewrites a draft in our voice: short sentences, one claim, no superlatives. Pulls the current positioning from the marketing space.","v4 · used 31 times this month","marketing · sales")}
{skill("Follow-up after a customer call","Turns a meeting session into a follow-up email with decisions, owners and dates.","v2 · used 12 times this month","sales")}
{skill("Write a pull request description","What changed, why, how it was tested. Reads the coding session it came from.","v7 · skill file · claude code, cursor","engineering")}
{skill("Weekly update for founders","Collects decisions and open questions across every space you can read.","v1 · draft","only me")}
</div>
</main>
</div>'''
(P/"Skills.dc.html").write_text(page("Shared skills", W, H, skills))

# ── Onboarding ───────────────────────────────────────────────────────────
def step(n, t, d, state):
    mark = f'<span style="width: 26px; height: 26px; border-radius: 50%; background: {INK}; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">{ico(I["check"],14,2)}</span>' if state=="done" else f'<span class="mono" style="width: 26px; height: 26px; box-sizing: border-box; border-radius: 50%; border: 1px solid {"#1a1a18" if state=="now" else LINE}; display: flex; align-items: center; justify-content: center; font-size: 12px; color: {INK if state=="now" else INK3}; flex-shrink: 0;">{n}</span>'
    return f'<div style="display: flex; gap: 14px; align-items: flex-start;">{mark}<span style="display: flex; flex-direction: column; gap: 3px;"><span style="font-size: 15px; font-weight: {500 if state!="todo" else 400}; color: {INK if state!="todo" else INK3};">{t}</span><span style="font-size: 13px; color: {INK3}; line-height: 1.5;">{d}</span></span></div>'
def tool(icon, name, found, on):
    box = f'<span style="width: 22px; height: 22px; border-radius: 6px; background: {INK}; color: #fff; display: flex; align-items: center; justify-content: center;">{ico(I["check"],13,2.2)}</span>' if on else f'<span style="width: 22px; height: 22px; box-sizing: border-box; border-radius: 6px; border: 1px solid #c9c8c3;"></span>'
    return f'<button style="display: flex; align-items: center; gap: 14px; min-height: 56px; padding: 0 16px; border-radius: 12px; border: 1px solid {LINE}; background: #fff; text-align: left;"><span style="color: {INK2}; display: flex;">{ico(I[icon],18)}</span><span style="display: flex; flex-direction: column; gap: 2px; flex-grow: 1;"><span style="font-size: 14.5px;">{name}</span><span class="mono" style="font-size: 11px; color: {INK3};">{found}</span></span>{box}</button>'
onb = f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
<aside style="width: 420px; flex-shrink: 0; box-sizing: border-box; background: {SIDE}; border-right: 1px solid {LINE}; padding: 56px 48px; display: flex; flex-direction: column; gap: 28px;">
<span style="font-size: 15px; font-weight: 600;">OpenKT</span>
<h1 style="margin: 0; font-size: 30px; line-height: 1.15; font-weight: 600; letter-spacing: -0.025em;">Three steps. No terminal.</h1>
<div style="display: flex; flex-direction: column; gap: 22px; padding-top: 6px;">
{step(1,"Sign in","Joined workspace Deepwork as Pratham.","done")}
{step(2,"Connect your tools","We found these on your Mac. Pick the ones to connect.","now")}
{step(3,"Get the local models","About 3 GB. Transcription and extraction run on this Mac.","todo")}
</div>
</aside>
<main style="flex-grow: 1; padding: 56px 72px; display: flex; flex-direction: column; gap: 12px;">
<h2 style="margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.015em;">Connect your tools</h2>
<p style="margin: 0 0 10px; font-size: 14px; line-height: 1.55; color: {INK2}; max-width: 520px;">Each conversation in a connected tool is saved as a session, private to you until you share it. Nothing to paste, nothing to restart.</p>
{tool("code","Claude Code","found · ~/.claude",True)}
{tool("code","Cursor","found · ~/.cursor",True)}
{tool("chat","ChatGPT","opens a sign-in page",True)}
{tool("chat","Claude","opens a sign-in page",False)}
{tool("video","Meetings, voice and screenshots","asks for microphone and screen recording next",True)}
<div style="flex-grow: 1;"></div>
<div style="display: flex; align-items: center; gap: 14px;">
<span style="flex-grow: 1; font-size: 13px; color: {INK3};">You can add or remove tools later in Settings.</span>
<button style="height: 44px; padding: 0 22px; border-radius: 22px; border: none; background: {ACC}; color: #fff; font-size: 14px; font-weight: 500;">Connect 4 tools</button>
</div>
</main>
</div>'''
(P/"Onboarding.dc.html").write_text(page("First run", W, H, onb))

# ── Capture moments (small) ──────────────────────────────────────────────
CW,CH = 760,460
def desk(inner):
    return f'''<div style="width: {CW}px; height: {CH}px; box-sizing: border-box; background: #d9d7d1; position: relative; overflow: hidden; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 40px;">
<div aria-hidden="true" style="position: absolute; left: 60px; top: 44px; width: 640px; height: 330px; border-radius: 12px; background: #ecebe7; border: 1px solid #c9c8c3; box-sizing: border-box; padding: 40px 36px; display: flex; flex-direction: column; gap: 12px;">
<span style="width: 46%; height: 14px; border-radius: 4px; background: #d9d7d1;"></span><span style="width: 82%; height: 9px; border-radius: 4px; background: #dedcd6;"></span><span style="width: 74%; height: 9px; border-radius: 4px; background: #dedcd6;"></span><span style="width: 79%; height: 9px; border-radius: 4px; background: #dedcd6;"></span><span style="width: 38%; height: 9px; border-radius: 4px; background: #dedcd6;"></span>
</div>
{inner}
</div>'''
bars = "".join(f'<span style="width: 3px; height: {h}px; border-radius: 2px; background: {ACC};"></span>' for h in [8,14,22,12,26,18,9,20,28,16,10,22,13,7])
voice = desk(f'''<div style="position: relative; width: 520px; box-sizing: border-box; background: #fff; border: 1px solid #c9c8c3; border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px;">
<div style="display: flex; align-items: center; gap: 12px;">
<span aria-hidden="true" style="display: flex; align-items: center; gap: 3px; height: 28px;">{bars}</span>
<span class="mono" style="font-size: 11px; color: {INK3}; flex-grow: 1;">listening · 0:14 · on this Mac</span>
<span class="mono" style="font-size: 11px; color: {INK3};">release fn to save</span>
</div>
<p style="margin: 0; font-size: 16px; line-height: 1.5;">What if every new store got an onboarding kit — a printed shelf map, the first week's planogram, and <span style="color: {INK3};">a QR code to the floor plan…</span></p>
<div style="display: flex; align-items: center; gap: 8px; padding-top: 2px;">
<span style="font-size: 12.5px; color: {INK3};">Save to</span>
<button style="display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid {LINE}; background: {SIDE}; font-size: 12.5px;">{ico(I["folder"],13)}Ideas{ico(I["down"],12)}</button>
<span class="mono" style="font-size: 11px; color: {INK3};">team can read</span>
</div>
</div>''')
(P/"Capture-Voice.dc.html").write_text(page("Voice capture", CW, CH, voice))

meet = desk(f'''<div style="position: absolute; right: 24px; top: 24px; width: 360px; box-sizing: border-box; background: #fff; border: 1px solid #c9c8c3; border-radius: 16px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px;">
<div style="display: flex; align-items: center; gap: 10px;"><span style="color: {INK2}; display: flex;">{ico(I["video"],17)}</span><span style="font-size: 14.5px; font-weight: 500; flex-grow: 1;">Google Meet is using your mic</span></div>
<p style="margin: 0; font-size: 13px; line-height: 1.5; color: {INK2};">Keep this meeting as a session? It is transcribed on this Mac. No bot joins, and the audio is never uploaded.</p>
<div style="display: flex; gap: 8px;">
<button style="flex-grow: 1; height: 44px; border-radius: 10px; border: none; background: {INK}; color: #fff; font-size: 13.5px; font-weight: 500;">Record</button>
<button style="flex-grow: 1; height: 44px; border-radius: 10px; border: 1px solid {LINE}; background: #fff; font-size: 13.5px;">Not this one</button>
</div>
<span class="mono" style="font-size: 11px; color: {INK3};">tell the others you are recording</span>
</div>
<div style="position: relative; display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px; border-radius: 20px; background: #fff; border: 1px solid #c9c8c3;">
<span style="width: 8px; height: 8px; border-radius: 50%; background: {ACC};"></span><span style="font-size: 13px;">Recording · Pricing call with Northgate</span><span class="mono" style="font-size: 11.5px; color: {INK3};">12:41</span>
</div>''')
(P/"Capture-Meeting.dc.html").write_text(page("Meeting capture", CW, CH, meet))

shot = desk(f'''<div aria-hidden="true" style="position: absolute; left: 96px; top: 84px; width: 330px; height: 150px; border: 1.5px dashed {ACC}; border-radius: 6px; background: rgba(180,83,42,0.06);"></div>
<div style="position: relative; width: 520px; box-sizing: border-box; background: #fff; border: 1px solid #c9c8c3; border-radius: 18px; padding: 16px 18px; display: flex; gap: 16px; align-items: center;">
<div aria-hidden="true" style="width: 96px; height: 64px; border-radius: 8px; background: #ecebe7; border: 1px solid {LINE}; flex-shrink: 0; box-sizing: border-box; padding: 12px 10px; display: flex; flex-direction: column; gap: 6px;"><span style="width: 60%; height: 6px; border-radius: 3px; background: #d0cec8;"></span><span style="width: 90%; height: 4px; border-radius: 2px; background: #dedcd6;"></span><span style="width: 80%; height: 4px; border-radius: 2px; background: #dedcd6;"></span></div>
<div style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1; min-width: 0;">
<span style="font-size: 14.5px;">Competitor pricing page — three tiers, per-store billing on the top tier</span>
<div style="display: flex; align-items: center; gap: 8px;">
<button style="display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid {LINE}; background: {SIDE}; font-size: 12.5px;">{ico(I["folder"],13)}sales / northgate{ico(I["down"],12)}</button>
<span class="mono" style="font-size: 11px; color: {INK3}; flex-grow: 1;">text read on this Mac</span>
<button style="height: 32px; padding: 0 14px; border-radius: 16px; border: none; background: {INK}; color: #fff; font-size: 12.5px; font-weight: 500;">Save</button>
</div>
</div>
</div>''')
(P/"Capture-Screenshot.dc.html").write_text(page("Screenshot capture", CW, CH, shot))

# ── canvas index ─────────────────────────────────────────────────────────
rowA = ["Onboarding.dc.html","Main.dc.html","Access.dc.html","Connectors.dc.html","Skills.dc.html"]
titlesA = ["1 · First run","2 · A session","3 · Who can use it","4 · Connectors and defaults","5 · Shared skills"]
order = ["Main.dc.html"] + [b for b in rowA if b!="Main.dc.html"]
boards = {}
for i,(b,t) in enumerate(zip(rowA,titlesA)):
    boards[b] = {"x": i*(W+80), "y": 0, "w": W, "h": H, "title": t}
yB = H + 120 + 300
rowB = [("Capture-Voice.dc.html","6 · Hold fn, think out loud"),("Capture-Meeting.dc.html","7 · A meeting, no bot"),("Capture-Screenshot.dc.html","8 · A screenshot, filed")]
for i,(b,t) in enumerate(rowB):
    boards[b] = {"x": i*(CW+80), "y": yB, "w": CW, "h": CH, "title": t}; order.append(b)
idx = {"v":3,"createdOnFiles":{"v":1,"at":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
 "title":"OpenKT desktop app mocks","launch":{"view":"canvas"},"pages":[],"boards":boards,"order":order,
 "notes":{"t-app":{"x":0,"y":-300,"text":"The app — a quiet control pane","kind":"title1","maxW":5*W+4*80},
          "t-cap":{"x":0,"y":yB-300,"text":"Capture — a function key away","kind":"title1","maxW":3*CW+2*80}},
 "designSystems":[]}
(P/"canvas.json").write_text(json.dumps(idx, indent=1))
print(sorted(p.name for p in P.iterdir()))
