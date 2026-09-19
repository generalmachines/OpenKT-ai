#!/usr/bin/env python3
"""Render docs/tasks/JUNIOR_TASKS.md from issues.py, and with --github create the issues.
   python3 docs/tasks/build.py            # render only
   python3 docs/tasks/build.py --github   # render + create milestones, labels, issues (idempotent via issue-map.json)
"""
import json, subprocess, sys, pathlib, importlib.util
HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("issues", HERE / "issues.py"); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
ISSUES = mod.ISSUES
MAP = HERE / "issue-map.json"
idmap = json.loads(MAP.read_text()) if MAP.exists() else {}

def ref(k): return f"#{idmap[k]}" if k in idmap else f"`{k}`"

def body(i, for_github=False):
    out = []
    if i["who"] == "junior":
        out.append("> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.\n")
    out.append(f"**Context.** {i['context']}\n")
    if i.get("read"): out.append("**Read first**\n" + "\n".join(f"- `{r}`" if not r.startswith("the ") and not r.startswith("an ") and " " not in r.split("(")[0].strip() else f"- {r}" for r in i["read"]) + "\n")
    out.append("**Do exactly this**\n" + "\n".join(f"{n}. {s}" for n, s in enumerate(i["steps"], 1)) + "\n")
    if i.get("files"): out.append("**Files you may touch**\n" + "\n".join(f"- {f if f.startswith('`') or ' ' in f else '`'+f+'`'}" for f in i["files"]) + "\n")
    out.append("**Acceptance — every line must be true and tested**\n" + "\n".join(f"- [ ] {a}" for a in i["accept"]) + "\n")
    if i.get("out"): out.append("**Out of scope**\n" + "\n".join(f"- {o}" for o in i["out"]) + "\n")
    deps = i.get("deps") or []
    out.append("**Depends on:** " + (", ".join(ref(d) for d in deps) if deps else "nothing — can start now") + "\n")
    if i["who"] == "junior":
        out.append(f"**Branch:** `task/<issue-number>-{i['key'].lower()}` · **Rules:** `AGENTS.md`" + (" · a senior engineer reviews this pull request before merge" if i.get("review") else ""))
    return "\n".join(out)

def labels(i):
    l = [i["who"]]
    if i.get("review"): l.append("needs-senior-review")
    l += i.get("tags", [])
    if any(d not in ("",) for d in (i.get("deps") or [])): l.append("blocked")
    return l

def render():
    md = ["# Task breakdown\n", "> Generated from `docs/tasks/issues.py` — edit that file, then run `python3 docs/tasks/build.py`. Mirrored as GitHub issues.\n",
          "How to work: read `AGENTS.md`. Pick a task marked **junior** whose dependencies are closed. One task = one branch = one pull request.\n"]
    ms_seen = []
    for i in ISSUES:
        if i["ms"] not in ms_seen:
            ms_seen.append(i["ms"]); md.append(f"\n---\n\n## Version {i['ms']}\n")
            md.append("| Task | Who | Title | Depends on |\n|---|---|---|---|")
            for j in [x for x in ISSUES if x["ms"] == i["ms"]]:
                md.append(f"| {ref(j['key'])} {j['key']} | {j['who']} | {j['title']} | {', '.join(ref(d) for d in j.get('deps') or []) or '—'} |")
            md.append("")
        md.append(f"\n### {i['key']} · {i['title']}  {ref(i['key']) if i['key'] in idmap else ''}\n")
        md.append(f"`{'` `'.join(labels(i))}`\n"); md.append(body(i))
    (HERE / "JUNIOR_TASKS.md").write_text("\n".join(md) + "\n")

def gh(*a, inp=None):
    r = subprocess.run(["gh", *a], input=inp, capture_output=True, text=True)
    if r.returncode: print("gh", a[:3], r.stderr.strip()[:200], file=sys.stderr)
    return r

def github(repo):
    for name, color, desc in [("senior","5319e7","Decided and built by the senior engineer"),("junior","0e8a16","Ready for a junior engineer or local agent"),
        ("blocked","d93f0b","Has an open dependency listed in the issue"),("needs-senior-review","fbca04","A senior reads the pull request before merge"),
        ("needs-mac","1d76db","Must be built and tested on Apple Silicon"),("question","cc317c","A decision is needed")]:
        gh("label","create",name,"--repo",repo,"--color",color,"--description",desc,"--force")
    existing = {m["title"]: m["number"] for m in json.loads(gh("api",f"repos/{repo}/milestones?state=all").stdout or "[]")}
    for ms in dict.fromkeys(i["ms"] for i in ISSUES):
        if ms not in existing: gh("api",f"repos/{repo}/milestones","-f",f"title={ms}")
    # two passes so dependency references resolve to real numbers
    for i in ISSUES:
        if i["key"] in idmap: continue
        r = gh("issue","create","--repo",repo,"--title",f"[{i['key']}] {i['title']}","--body","(filling in…)","--milestone",i["ms"],*sum((["--label",l] for l in labels(i)),[]))
        if r.returncode == 0:
            idmap[i["key"]] = int(r.stdout.strip().rsplit("/",1)[1]); MAP.write_text(json.dumps(idmap, indent=1))
    for i in ISSUES:
        if i["key"] in idmap: gh("issue","edit",str(idmap[i["key"]]),"--repo",repo,"--body-file","-", inp=body(i, True))

if __name__ == "__main__":
    if "--github" in sys.argv:
        repo = sys.argv[sys.argv.index("--github")+1] if len(sys.argv) > sys.argv.index("--github")+1 else "masti-ai/openkt-next"
        github(repo)
    render(); print("rendered", len(ISSUES), "tasks;", len(idmap), "mapped to GitHub issues")
