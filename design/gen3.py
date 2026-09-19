#!/usr/bin/env python3
"""Third part of the design canvas: skills — a library you can open, read, edit and share.

    python3 design/gen3.py
Reuses gen.py's fragments (sidebar, ico, page, colours).
"""
import html, pathlib
_FROM_GEN2 = True   # stop gen.py from chaining into gen2.py
exec((pathlib.Path(__file__).resolve().parent / "gen.py").read_text())

SKILL_MD = '''---
name: sharpen-marketing-message
description: Rewrite a marketing draft in our voice. Use when someone shares launch copy, an email, a post or a headline and asks to tighten it.
---

# Sharpen a marketing message

Rewrite the draft so it sounds like us.

## Voice
- Short sentences. One claim per message.
- Plain words. No superlatives, no "revolutionary", no exclamation marks.
- Say who it is for in the first line.

## Steps
1. Ask OpenKT for the current positioning: recall "positioning" in the marketing space.
2. Find the single claim the draft is trying to make. If there are two, ask which one.
3. Rewrite. Keep it under 60 words unless asked otherwise.
4. Show the rewrite, then one line on what you changed.'''

def file_row(name, meta, on=False):
    return f'<a href="#" style="display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 7px; text-decoration: none; color: {INK}; background: {"#ecebe7" if on else "transparent"};"><span style="color: {INK3}; display: flex;">{ico(I["note"],13)}</span><span class="mono" style="font-size: 12px; flex-grow: 1;">{name}</span><span class="mono" style="font-size: 10.5px; color: {INK3};">{meta}</span></a>'
def who(initials, name, role):
    return f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 0;"><span style="width: 26px; height: 26px; border-radius: 50%; background: #ecebe7; display: flex; align-items: center; justify-content: center; font-size: 10.5px; color: {INK2}; flex-shrink: 0;">{initials}</span><span style="font-size: 13px; flex-grow: 1;">{name}</span><span class="mono" style="font-size: 11px; color: {INK3};">{role}</span></div>'
def ver(v, t, on=False):
    return f'<a href="#" style="display: flex; gap: 10px; padding: 6px 0; text-decoration: none; color: {INK};"><span class="mono" style="font-size: 11.5px; width: 22px; color: {ACC if on else INK3};">{v}</span><span style="font-size: 12.5px; color: {INK2}; line-height: 1.4;">{t}</span></a>'
def lab(t): return f'<h3 class="mono" style="margin: 0 0 6px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 400; color: {INK3};">{t}</h3>'

def rail():
    return f'''<aside style="width: 264px; flex-shrink: 0; display: flex; flex-direction: column; gap: 22px; padding-top: 4px;">
<div>{lab("Files")}
{file_row("SKILL.md","1.1 KB",True)}
{file_row("references/voice.md","2.4 KB")}
{file_row("references/examples.md","3.0 KB")}
</div>
<div>{lab("Who can use it")}
{who("AN","Ana Reyes","owner")}
{who("MK","Marketing","editors")}
{who("SA","Sales","readers")}
</div>
<div>{lab("Versions")}
{ver("v4","Ana · 2 days ago · shorter word limit",True)}
{ver("v3","Ravi · 3 weeks ago · added the recall step")}
{ver("v2","Ana · 5 weeks ago")}
</div>
<p class="mono" style="margin: 0; font-size: 11px; line-height: 1.6; color: {INK3};">used 31 times this month · available in every connected tool</p>
</aside>'''

def head(editing=False):
    right = (f'''<button style="height: 36px; padding: 0 14px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">Cancel</button>
<button style="height: 36px; padding: 0 16px; border-radius: 18px; border: none; background: {INK}; color: #fff; font-size: 13px; font-weight: 500;">Save as v5</button>''' if editing else
f'''<button style="display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">{ico(I["users"],15)}Share</button>
<button style="height: 36px; padding: 0 14px; border-radius: 18px; border: 1px solid {LINE}; background: #fff; font-size: 13px;">Edit</button>
<button style="height: 36px; padding: 0 16px; border-radius: 18px; border: none; background: {INK}; color: #fff; font-size: 13px; font-weight: 500;">Run</button>''')
    meta = "editing · your changes become v5" if editing else "v4 · edited by Ana 2 days ago"
    return f'''<div class="mono" style="font-size: 11.5px; color: {INK3}; display: flex; gap: 8px; align-items: center;">Skills {ico(I["chev"],11)} marketing</div>
<div style="display: flex; align-items: center; gap: 10px;">
<h1 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; flex-grow: 1;">Sharpen a marketing message</h1>
{right}
</div>
<div class="mono" style="font-size: 11.5px; color: {INK3}; display: flex; gap: 14px;"><span>{meta}</span><span style="display: flex; gap: 6px; align-items: center;">{ico(I["lock"],12)}marketing can edit · sales can use</span></div>'''

def rendered():
    # the reading view: frontmatter as a quiet header, body as prose
    return f'''<div style="border: 1px solid {LINE}; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; flex-grow: 1; min-height: 0;">
<div style="display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid {LINE}; background: {SIDE};">
<span class="mono" style="font-size: 12px; flex-grow: 1;">SKILL.md</span>
<a href="#" style="font-size: 12px; padding: 4px 10px; border-radius: 6px; background: #fff; border: 1px solid {LINE}; color: {INK}; text-decoration: none;">Read</a>
<a href="#" style="font-size: 12px; padding: 4px 10px; color: {INK3}; text-decoration: none;">Source</a>
</div>
<div style="padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; overflow: hidden;">
<div style="display: grid; grid-template-columns: 90px 1fr; gap: 6px 12px; padding-bottom: 12px; border-bottom: 1px solid {LINE};">
<span class="mono" style="font-size: 11.5px; color: {INK3};">name</span><span class="mono" style="font-size: 12px;">sharpen-marketing-message</span>
<span class="mono" style="font-size: 11.5px; color: {INK3};">description</span><span style="font-size: 13px; line-height: 1.5; color: {INK2};">Rewrite a marketing draft in our voice. Use when someone shares launch copy, an email, a post or a headline and asks to tighten it.</span>
</div>
<h2 style="margin: 6px 0 0; font-size: 17px; font-weight: 600;">Sharpen a marketing message</h2>
<p style="margin: 0; font-size: 14px; line-height: 1.6;">Rewrite the draft so it sounds like us.</p>
<h3 style="margin: 6px 0 0; font-size: 14px; font-weight: 600;">Voice</h3>
<ul style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.65;"><li>Short sentences. One claim per message.</li><li>Plain words. No superlatives, no "revolutionary", no exclamation marks.</li><li>Say who it is for in the first line.</li></ul>
<h3 style="margin: 6px 0 0; font-size: 14px; font-weight: 600;">Steps</h3>
<ol style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.65;"><li>Ask OpenKT for the current positioning: recall "positioning" in the marketing space.</li><li>Find the single claim the draft is trying to make. If there are two, ask which one.</li><li>Rewrite. Keep it under 60 words unless asked otherwise.</li><li>Show the rewrite, then one line on what you changed.</li></ol>
</div></div>'''

def editor():
    lines = SKILL_MD.split("\n")
    nums = "".join(f'<span>{i+1}</span>' for i in range(len(lines)))
    return f'''<div style="border: 1px solid {INK}; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; flex-grow: 1; min-height: 0;">
<div style="display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid {LINE}; background: {SIDE};">
<span class="mono" style="font-size: 12px; flex-grow: 1;">SKILL.md</span><span class="mono" style="font-size: 11px; color: {INK3};">markdown · ⌘S saves · Esc cancels</span>
</div>
<div style="display: flex; flex-grow: 1; min-height: 0; overflow: hidden;">
<div class="mono" aria-hidden="true" style="display: flex; flex-direction: column; padding: 14px 10px 14px 16px; font-size: 12px; line-height: 20px; color: #a3a29c; text-align: right; user-select: none; border-right: 1px solid {LINE};">{nums}</div>
<label for="src" style="position: absolute; left: -9999px;">Skill source</label>
<textarea id="src" spellcheck="false" style="flex-grow: 1; border: none; outline: none; resize: none; padding: 14px 16px; font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; line-height: 20px; color: {INK}; background: #fff; white-space: pre; overflow: hidden;">{html.escape(SKILL_MD)}</textarea>
</div>
<div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid {LINE};">
<label for="note" style="font-size: 12.5px; color: {INK3};">What changed</label>
<input id="note" type="text" placeholder="One line for your teammates" style="flex-grow: 1; height: 34px; box-sizing: border-box; padding: 0 12px; border-radius: 8px; border: 1px solid {LINE}; font: inherit; font-size: 13px;">
</div></div>'''

def board(editing):
    return f'''<div style="width: {W}px; height: {H}px; box-sizing: border-box; display: flex; background: #fff; overflow: hidden;">
{sidebar(nav="Skills")}
<main style="flex-grow: 1; min-width: 0; padding: 32px 40px 28px 48px; display: flex; flex-direction: column; gap: 12px;">
{head(editing)}
<div style="display: flex; gap: 36px; flex-grow: 1; min-height: 0; padding-top: 6px;">
<section style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column;">{editor() if editing else rendered()}</section>
{rail()}
</div>
</main>
</div>'''

(P/"Skill.dc.html").write_text(page("A skill, opened", W, H, board(False)))
(P/"Skill-Edit.dc.html").write_text(page("Editing a skill", W, H, board(True)))
yE = 4240
new = [("Skill.dc.html","14 · A skill, opened",0,yE,W,H),("Skill-Edit.dc.html","15 · Editing a skill",W+80,yE,W,H)]
idx = write_index({f: {"x":x,"y":y,"w":w,"h":h,"title":t} for f,t,x,y,w,h in new}, [f for f,*_ in new],
 {"t-skills": {"x":0,"y":yE-300,"text":"Skills — open, read, edit, share","kind":"title1","maxW":2*W+80}})
print("ok", len(idx["boards"]))
