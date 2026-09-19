"""Builds docs/architecture/system.excalidraw and system.svg from one scene description."""
import json, random, sys, html

OUT = sys.argv[1]

Z = [  # zones: id, x, y, w, h, fill, stroke, label, label colour
    ("zA", 0, 70, 340, 720, "#dbe4ff", "#4a9eed", "Where context comes from", "#2563eb"),
    ("zB", 400, 70, 420, 720, "#e5dbff", "#8b5cf6", "OpenKT server  (api / mcp.openkt.ai)", "#6d28d9"),
    ("zC", 880, 70, 340, 720, "#d3f9d8", "#22c55e", "Storage and models", "#15803d"),
]
B = [  # boxes: id, x, y, w, h, fill, stroke, dashed, text
    ("A1", 20, 120, 300, 150, "#a5d8ff", "#4a9eed", False, "AI tools over MCP\nClaude, Cowork, ChatGPT,\nCodex, Cursor,\nbrowser agents"),
    ("A2", 20, 300, 300, 170, "#a5d8ff", "#4a9eed", False, "Desktop app (Mac)\nnotes, voice, screenshots\non-device: whisper,\nApple Vision, Qwen3.5-4B"),
    ("A3", 20, 500, 300, 120, "#ffd8a8", "#f59e0b", True, "Connectors (coming)\nNotion, Gmail,\nObsidian, Linear"),
    ("A4", 20, 650, 300, 110, "#a5d8ff", "#4a9eed", False, "Claude plugin + skills\npaste-in setup prompt"),
    ("B1", 420, 120, 380, 110, "#d0bfff", "#8b5cf6", False, "MCP + REST + OAuth sign-in\nkt_* tools, MCP UI cards"),
    ("B2", 420, 255, 380, 100, "#d0bfff", "#8b5cf6", False, "Access: accounts, spaces,\ngrants, share by email"),
    ("B3", 420, 380, 380, 110, "#d0bfff", "#8b5cf6", False, "Sessions -> facts\neach fact: author, kind,\ntags, space"),
    ("B4", 420, 515, 380, 100, "#d0bfff", "#8b5cf6", False, "Recall: vector + keyword (RRF)\nonly what you may see"),
    ("B5", 420, 640, 380, 130, "#fff3bf", "#f59e0b", True, "Write pipeline (coming)\nextract, dedupe, tag, route,\nliving pages, team brief"),
    ("C1", 900, 120, 300, 150, "#c3fae8", "#22c55e", False, "Postgres 16 + pgvector\nsessions, turns, facts,\ngrants, skills"),
    ("C2", 900, 300, 300, 110, "#c3fae8", "#22c55e", False, "Embeddings\nQwen3-Embedding-0.6B"),
    ("C3", 900, 440, 300, 100, "#ffd8a8", "#f59e0b", True, "Reranker (coming)\nQwen3-Reranker-0.6B"),
    ("C4", 900, 580, 300, 180, "#b2f2bb", "#22c55e", False, "Team context map\nspaces -> living pages\n-> brief, every line\ncited to who said it"),
]
A = [  # arrows: id, x, y, dx, dy, colour, dashed, label
    ("a1", 320, 195, 100, -20, "#2563eb", False, "save / recall"),
    ("a2", 320, 385, 100, 50, "#2563eb", False, "notes"),
    ("a3", 320, 560, 100, -95, "#f59e0b", True, ""),
    ("a4", 800, 435, 100, -240, "#15803d", False, "store"),
    ("a5", 800, 565, 100, -210, "#15803d", False, "embed"),
    ("a6", 800, 705, 100, -35, "#f59e0b", True, "writes"),
]
TITLE = ("OpenKT — system architecture", 400, -10, 30)
SUB = ("what one person's AI learns reaches the whole team's AI", 352, 30, 18)
FOOT = ("Dashed = designed, not built yet.   Apache-2.0.   Every model is swappable; capture runs on your Mac.", 130, 815, 20)

# ---------- .excalidraw ----------
rnd = random.Random(7)
def base(i, t, x, y, w, h, **kw):
    e = dict(id=i, type=t, x=x, y=y, width=w, height=h, angle=0, strokeColor="#1e1e1e", backgroundColor="transparent",
             fillStyle="solid", strokeWidth=2, strokeStyle="solid", roughness=1, opacity=100, groupIds=[], frameId=None,
             roundness=None, seed=rnd.randint(1, 2**31), version=1, versionNonce=rnd.randint(1, 2**31), isDeleted=False,
             boundElements=[], updated=1, link=None, locked=False)
    e.update(kw)
    return e
def text(i, s, x, y, size, color="#1e1e1e", container=None, w=None, h=None, align="left"):
    lines = s.split("\n")
    return base(i, "text", x, y, w or max(len(l) for l in lines) * size * 0.55, h or len(lines) * size * 1.25,
                strokeColor=color, text=s, originalText=s, fontSize=size, fontFamily=5, textAlign=align,
                verticalAlign="middle" if container else "top", containerId=container, lineHeight=1.25, autoResize=True)
els = []
for i, x, y, w, h, fill, stroke, lab, lc in Z:
    els.append(base(i, "rectangle", x, y, w, h, backgroundColor=fill, strokeColor=stroke, strokeWidth=1, opacity=35, roundness={"type": 3}))
    els.append(text(i + "l", lab, x + 16, y + 10, 20, lc))
for i, x, y, w, h, fill, stroke, dashed, s in B:
    r = base(i, "rectangle", x, y, w, h, backgroundColor=fill, strokeColor=stroke, roundness={"type": 3},
             strokeStyle="dashed" if dashed else "solid", boundElements=[{"type": "text", "id": i + "t"}])
    els.append(r)
    th = len(s.split("\n")) * 18 * 1.25
    els.append(text(i + "t", s, x + 10, y + (h - th) / 2, 18, container=i, w=w - 20, h=th, align="center"))
for i, x, y, dx, dy, c, dashed, lab in A:
    a = base(i, "arrow", x, y, abs(dx), abs(dy), strokeColor=c, strokeStyle="dashed" if dashed else "solid",
             points=[[0, 0], [dx, dy]], startArrowhead=None, endArrowhead="arrow", roundness={"type": 2},
             startBinding=None, endBinding=None, lastCommittedPoint=None, elbowed=False)
    if lab:
        a["boundElements"] = [{"type": "text", "id": i + "t"}]
    els.append(a)
    if lab:
        els.append(text(i + "t", lab, x + dx / 2 - len(lab) * 4.4, y + dy / 2 - 10, 16, c, container=i, align="center"))
for n, (s, x, y, size) in enumerate([TITLE, SUB, FOOT]):
    els.append(text(f"t{n}", s, x, y, size, "#1e1e1e" if n == 0 else "#757575"))
scene = {"type": "excalidraw", "version": 2, "source": "https://github.com/masti-ai/openkt", "elements": els,
         "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None}, "files": {}}
json.dump(scene, open(f"{OUT}/system.excalidraw", "w"), indent=1)

# ---------- .svg (plain, crisp; same geometry) ----------
X0, Y0, W, H = -30, -50, 1280, 900
o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{X0} {Y0} {W} {H}" width="{W}" height="{H}" font-family="Inter, Helvetica, Arial, sans-serif">',
     f'<rect x="{X0}" y="{Y0}" width="{W}" height="{H}" fill="#ffffff"/>',
     '<defs>' + "".join(f'<marker id="m{c[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>' for c in {a[5] for a in A}) + '</defs>']
def t(s, x, y, size, color, anchor="start", weight=400):
    return f'<text x="{x:.0f}" y="{y:.0f}" font-size="{size}" fill="{color}" text-anchor="{anchor}" font-weight="{weight}">{html.escape(s)}</text>'
for i, x, y, w, h, fill, stroke, lab, lc in Z:
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{fill}" fill-opacity="0.45" stroke="{stroke}" stroke-width="1"/>')
    o.append(t(lab, x + 16, y + 30, 20, lc, weight=600))
for i, x, y, w, h, fill, stroke, dashed, s in B:
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="2"' + (' stroke-dasharray="8 6"' if dashed else "") + "/>")
    lines = s.split("\n")
    top = y + h / 2 - (len(lines) - 1) * 12.5
    for k, line in enumerate(lines):
        o.append(t(line, x + w / 2, top + k * 25 + 6, 18, "#1e1e1e", "middle", 600 if k == 0 else 400))
for i, x, y, dx, dy, c, dashed, lab in A:
    o.append(f'<line x1="{x}" y1="{y}" x2="{x+dx}" y2="{y+dy}" stroke="{c}" stroke-width="2"' + (' stroke-dasharray="8 6"' if dashed else "") + f' marker-end="url(#m{c[1:]})"/>')
    if lab:
        mx, my = x + dx / 2, y + dy / 2
        o.append(f'<rect x="{mx - len(lab)*4.6 - 4:.0f}" y="{my - 13:.0f}" width="{len(lab)*9.2 + 8:.0f}" height="22" fill="#ffffff" rx="4"/>')
        o.append(t(lab, mx, my + 4, 16, c, "middle"))
o.append(t(TITLE[0], 610, 10, 30, "#1e1e1e", "middle", 700))
o.append(t(SUB[0], 610, 44, 18, "#757575", "middle"))
o.append(t(FOOT[0], 610, 835, 18, "#757575", "middle"))
o.append("</svg>")
open(f"{OUT}/system.svg", "w").write("\n".join(o))
print("wrote", OUT)
