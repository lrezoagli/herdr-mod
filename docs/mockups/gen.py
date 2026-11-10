#!/usr/bin/env python3
"""Mockups of herdr-mod with made-up data (acme/*), rendered with headless Chrome."""
import os, re, subprocess, pathlib

HERE = pathlib.Path(__file__).parent
ICONS = pathlib.Path.home() / ".config/herdr-app/icons"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def icon(name, color, size=16):
    svg = (ICONS / f"{name}.svg").read_text()
    svg = re.sub(r'<title>.*?</title>', '', svg)
    svg = re.sub(r'height="[^"]*"', f'height="{size}"', svg, count=1)
    svg = re.sub(r'width="[^"]*"', f'width="{size}"', svg, count=1)
    svg = svg.replace("<svg ", f'<svg fill="{color}" style="flex:none;display:block" ', 1)
    svg = svg.replace('style="flex:none;line-height:1" ', "")
    return svg


CL = lambda s=15: icon("claude", "#d97757", s)
CX = lambda s=15: icon("codex", "#7aa2f7", s)

CSS = """
:root{--chrome:#101114;--bg:#17191d;--raised:#1f2125;--sel:#262629;--hover:#1c1e22;--border:#25272b;
--fg:#e7e7ea;--muted:#a3a4a9;--dim:#6c6d72;--accent:#96b2d7;--blocked:#e06c75;--ansi2:#8fcf7f;--ansi3:#e5c07b;
--ansi4:#7aa2f7;--ansi5:#c678dd;--ansi6:#56b6c2;--working:#d97757;--done:#8fcf7f}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--chrome);color:var(--fg);font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:Menlo,monospace}
.row{display:flex;align-items:center}
.col{display:flex;flex-direction:column}
.dim{color:var(--dim)}.muted{color:var(--muted)}
.chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;font-size:11.25px;white-space:nowrap}
.btn{display:inline-flex;align-items:center;height:21px;padding:0 7px;border-radius:5px;font-size:11.75px;font-weight:600;border:1px solid}
.spin{width:12px;height:12px;border-radius:50%;border:2px solid #3a2a22;border-top-color:var(--working)}
.ring{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--dim)}
.dot{width:7px;height:7px;border-radius:4px;background:var(--done)}
.zz{font-size:10.5px;color:var(--dim)}
"""


def chip(text, color, strong=False):
    return f'<span class="chip" style="background:{color}26;color:{color};{"font-weight:600" if strong else ""}">{text}</span>'


def btn(text, color):
    return f'<span class="btn" style="color:{color};border-color:{color}55;background:{color}22">{text}</span>'


# ---------- sidebar ----------
SPACES = [("A", "#56b6c2", "api", "acme/api", "↑2"), ("W", "#e5c07b", "web", "acme/web · feat/billing", ""),
          ("M", "#c678dd", "mobile", "acme/mobile", "↓3"), ("D", "#7aa2f7", "docs", "acme/docs", ""),
          ("I", "#8fcf7f", "infra", "acme/infra", "")]


def spaces(active="api"):
    rows = []
    for av, c, name, tail, ab in SPACES:
        on = name == active
        rows.append(f'''<div class="row" style="height:27px;padding:0 8px;gap:9px;border-radius:8px;{"background:var(--sel)" if on else ""}">
<div style="width:18px;height:18px;border-radius:5px;background:{c};color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center">{av}</div>
<div style="color:var(--fg)">{name}</div><div style="flex:1;text-align:right;font-size:11.5px" class="dim">{tail} <span style="color:{"var(--ansi2)" if ab.startswith("↑") else "var(--blocked)"}">{ab}</span></div></div>''')
    return f'''<div class="row dim" style="height:31px;padding:0 10px 0 16px;justify-content:space-between;font-size:11.5px">Spaces<span>+</span></div>
<div class="col" style="padding:0 8px">{"".join(rows)}</div>'''


def conn(kind):
    v = {"tee": '<div style="position:absolute;left:6px;top:0;width:1px;height:30px;background:var(--dim)"></div><div style="position:absolute;left:6px;top:15px;width:8px;height:1px;background:var(--dim)"></div>',
         "elbow": '<div style="position:absolute;left:6px;top:0;width:1px;height:15px;background:var(--dim)"></div><div style="position:absolute;left:6px;top:15px;width:8px;height:1px;background:var(--dim)"></div>',
         "pipe": '<div style="position:absolute;left:6px;top:0;width:1px;height:30px;background:var(--dim)"></div>', "blank": ""}[kind]
    return f'<div style="position:relative;width:14px;height:30px;flex:none">{v}</div>'


def agent(name, when, state, prefix=(), prog="cl", branch="", focused=False, tags="", ghost=False, hover=False):
    pic = CL() if prog == "cl" else CX()
    st = {"working": '<div class="spin"></div>', "idle": '<div class="ring"></div>', "done": '<div class="dot"></div>',
          "sleep": '<span class="zz">zz</span>', "blocked": chip("Needs you", "#e06c75", True)}.get(state, "")
    pre = "".join(conn(k) for k in prefix)
    if ghost:
        body = f'''<div class="row" style="flex:1;height:30px;padding:0 8px;gap:7px;border-radius:8px">
<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6c6d72" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5"/></svg>
<div class="dim">{name}</div><div style="flex:1"></div>{tags}</div>'''
    else:
        color = "var(--dim)" if state == "sleep" else ("var(--muted)" if state == "idle" and not focused else "var(--fg)")
        right = ('<span class="dim" style="padding:0 3px">✎</span><span class="dim">📌</span>' if hover else f'<span class="dim" style="font-size:11px">{when}</span>')
        body = f'''<div class="row" style="flex:1;min-width:0;height:30px;padding:0 8px;gap:9px;border-radius:8px;{"background:var(--sel)" if focused else ("background:var(--hover)" if hover else "")}">
{pic}<div class="row" style="flex:1;min-width:0;gap:5px"><span style="color:{color};white-space:nowrap">{name}</span>{f'<span class="dim" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{branch}</span>' if branch else ""}</div>
{tags}{right}{st}</div>'''
    return f'<div class="row" style="padding-left:{8 if prefix else 0}px">{pre}{body}</div>'


def head(name, first=False, extra=""):
    return f'''<div class="row" style="height:{30 if first else 38}px;padding:{8 if first else 14}px 8px 0;gap:6px;font-size:12.5px;font-weight:600;{"" if first else "margin-top:8px;border-top:1px solid var(--border)"}">{name}{extra}</div>'''


def agents_list():
    return f'''<div class="row dim" style="height:41px;padding:14px 16px 5px;justify-content:space-between;font-size:11.5px;font-weight:500">Agents<span>☰</span></div>
<div class="col" style="padding:0 8px">
{head("api", True)}
{agent("main", "2m", "working", focused=True)}
{agent("IS-42", "8m", "done", ("tee",), branch="")}
{agent("rv/PR-118", "3m", "working", ("tee",))}
{agent("IS-57", "1h", "idle", ("elbow",), prog="cx")}
{agent("reviewer", "6m", "working", ("blank", "elbow"))}
{head("web")}
{agent("IS-12 billing", "", "", ghost=True, tags=chip("pedido", "#6c6d72"))}
{agent("IS-13", "25m", "blocked", ("tee",))}
{agent("IS-14", "4m", "working", ("elbow",), branch="feat/invoices-pdf", hover=True)}
{head("mobile")}
{agent("android", "3h", "sleep", branch="")}
{agent("ios-push", "5h", "sleep", prog="cx")}
</div>'''


def sidebar():
    return f'''<div class="col" style="width:250px;flex:none;background:var(--chrome);border-right:1px solid var(--border)">
<div class="row" style="height:38px;padding:0 16px;gap:8px;font-weight:600"><span style="font-size:14px">◈</span>Herdr<div style="flex:1"></div><span class="dim">⌕</span></div>
{spaces()}<div style="height:18px"></div>{agents_list()}<div style="flex:1"></div>
<div class="col dim" style="padding:10px 16px;gap:8px;font-size:12px"><span>⚙ Settings</span><span>+ Add machine</span></div></div>'''


def tabs_bar():
    tab = lambda t, on, ic: f'<div class="row" style="height:26px;padding:0 10px;gap:6px;border-radius:7px;{"background:var(--sel)" if on else ""};font-size:12.5px">{ic}{t}{" ×" if on else ""}</div>'
    tool = lambda t, n="": f'<div class="row muted" style="gap:5px;font-size:12px">{t}{f"<span class=chip style=background:#e5c07b33;color:#e5c07b;height:15px;padding:0_4px>{n}</span>".replace("_"," ") if n else ""}</div>'
    return f'''<div class="row" style="height:38px;padding:0 10px;gap:6px;background:var(--chrome);border-bottom:1px solid var(--border)">
{tab("main", True, CL(13))}{tab("IS-42", False, CL(13))}{tab("rv/PR-118", False, CL(13))}{tab("IS-57", False, CX(13))}
<div style="flex:1"></div>
<div class="row" style="gap:6px;height:24px;padding:0 9px;border-radius:6px;background:#2b2823;border:1px solid #d9775755;color:#d97757;font-size:12px">{CL(12)}Claude</div>
<div class="row" style="gap:6px;height:24px;padding:0 9px;border-radius:6px;background:#22262e;border:1px solid #7aa2f755;color:#7aa2f7;font-size:12px">{CX(12)}Codex</div>
<span class="dim">+</span><div style="width:14px"></div>
<div class="row" style="gap:16px">{tool("Files")}{tool("Changes")}{tool("GitHub", "3")}{tool("Equipo")}</div></div>'''


def terminal():
    lines = [
        ('<span style="color:#d97757">✻</span> <b>Claude Code</b> <span class="dim">· ~/code/api · main</span>', ""),
        ("", ""),
        ('<span class="dim">›</span> add rate limiting to the public endpoints', ""),
        ("", ""),
        ('<span style="color:#8fcf7f">●</span> Read <span class="dim">src/server.ts</span>', ""),
        ('<span style="color:#8fcf7f">●</span> Edit <span class="dim">src/middleware/rate-limit.ts</span> <span class="dim">(+48)</span>', ""),
        ('<span style="color:#8fcf7f">●</span> Bash <span class="dim">npm test -- rate-limit</span>', ""),
        ('  <span class="dim">⎿ 12 passed</span>', ""),
        ("", ""),
        ('<span style="color:#d97757">✶</span> <span style="color:#d97757">Wiring the limiter into the router…</span> <span class="dim">(1m 12s)</span>', ""),
    ]
    body = "".join(f'<div style="height:20px;white-space:pre">{l}</div>' for l, _ in lines)
    return f'''<div class="col" style="flex:1;min-width:0;background:var(--bg);margin:6px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
<div class="row" style="height:30px;padding:0 10px;gap:8px;border-bottom:1px solid var(--border);font-size:12px">{CL(13)}<b>Claude Code</b><span class="dim">~/code/api</span><div style="flex:1"></div><div class="spin"></div></div>
<div class="mono" style="padding:16px 18px;font-size:12.5px;line-height:20px">{body}</div><div style="flex:1"></div>
<div class="mono" style="margin:0 18px 14px;padding-top:10px;border-top:1px solid var(--border);font-size:12.5px"><span class="dim">›</span> <span style="background:#e7e7ea;color:#17191d"> </span></div></div>'''


def strip(color):
    return f'<div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:{color}"></div>'


def pr_row(num, title, when, chips, button="", needs=None):
    return f'''<div class="col" style="position:relative;padding:8px 12px;gap:5px;border-bottom:1px solid var(--border)">{strip(needs) if needs else ""}
<div class="row" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:0;font-size:13.5px"><div class="dim" style="font-size:11.75px">{num}</div><div>{title}</div></div><div class="dim" style="font-size:11.75px">{when}</div></div>
<div class="row" style="gap:4px;flex-wrap:wrap">{"".join(chips)}<div style="flex:1"></div>{button}</div></div>'''


def gh_header(section):
    seg = lambda id_, label, n, c: f'<div class="row" style="flex:1;height:26px;justify-content:center;gap:5px;border-radius:6px;{"background:var(--sel);color:var(--fg)" if id_ == section else "color:var(--muted)"};font-size:12.75px">{label}{f"<span style=padding:0_5px;border-radius:8px;font-size:10.5px;font-weight:600;background:{c}33;color:{c}>{n}</span>".replace("_", " ") if n else ""}</div>'
    return f'''<div class="row" style="height:38px;padding:0 12px;gap:8px;border-bottom:1px solid var(--border)"><span class="muted">⊙</span><b style="font-size:13.5px">acme/api</b><span class="dim">↗</span><div style="flex:1"></div><span class="dim">↻</span></div>
<div class="row" style="padding:8px 8px 0;gap:4px">{seg("issues", "Issues", 0, "")}{seg("prs", "Mis PRs", 3, "#e5c07b")}{seg("reviews", "Reviews", 2, "#c678dd")}</div>
<div class="row dim" style="padding:6px 12px 0;font-size:11.75px;justify-content:space-between"><span>todos tus repos</span><span>recién</span></div>'''


def repo_head(name, n, toca=0, color="var(--muted)"):
    return f'<div class="row" style="padding:12px 12px 5px;gap:6px"><span style="font-size:11px;font-weight:600;color:{color}">{name.upper()} · {n}</span>{f"<span style=font-size:10.5px;color:var(--ansi3)>te toca {toca}</span>" if toca else ""}</div>'


def gh_prs():
    here = f'''<div class="col" style="margin:8px 8px 0;border-radius:8px;overflow:hidden;border:1px solid #96b2d788;background:#96b2d714">
<div style="padding:8px 12px 0;font-size:10.5px;font-weight:600;color:var(--accent)">ESTE PROYECTO</div>
{repo_head("api", 2, 1, "var(--accent)")}
{pr_row("#212", "Rate limiting for public endpoints", "2h", [chip("2 hilos sin responder", "#e5c07b", True), chip("CI ✗", "#e06c75", True)], btn("/pr-fix", "#c678dd"), "#e06c75")}
{pr_row("#205", "Cache tenant settings in Redis", "1d", [chip("aprobado", "#8fcf7f"), chip("bots 1", "#6c6d72")])}
</div>'''
    sep = '<div class="row" style="padding:26px 12px 2px;gap:8px"><span class="dim" style="font-size:11px;font-weight:600">OTROS PROYECTOS</span><div style="flex:1;height:1px;background:var(--border)"></div></div>'
    others = f'''{repo_head("web", 2, 1)}
{pr_row("#88", "Invoices: download as PDF", "5h", [chip("cambios pedidos", "#e06c75", True)], btn("/pr-fix", "#c678dd"), "#e06c75")}
{pr_row("#91", "Dark mode for the dashboard", "3d", [chip("esperando a @maria", "#a3a4a9"), chip("CI …", "#a3a4a9")])}
{repo_head("mobile", 1)}
{pr_row("#34", "Push notifications on iOS", "1w", [chip("conflicto", "#e06c75", True), chip("borrador", "#6c6d72")], "", "#e06c75")}'''
    return f'<div class="col" style="width:400px;background:var(--chrome);height:100%">{gh_header("prs")}{here}{sep}{others}</div>'


def rr_row(num, title, when, chips, needs=None):
    b = btn("/pr-review cc", "#c678dd") + " " + btn("cx", "#7aa2f7")
    return pr_row(num, title, when, chips, f'<span class="row" style="gap:4px">{b}</span>', needs)


def gh_reviews():
    g = lambda t, n: f'<div style="padding:10px 12px 5px;font-size:11px;font-weight:600;color:var(--muted)">{t.upper()} · {n}</div>'
    return f'''<div class="col" style="width:400px;background:var(--chrome);height:100%">{gh_header("reviews")}
{g("Te pidieron review", 1)}
{rr_row("api #219", "Retry webhooks with exponential backoff", "1d", [chip("@sam", "#a3a4a9"), chip("+312 −40", "#a3a4a9"), chip("te lo volvieron a pedir", "#96b2d7", True)], "#e06c75")}
{g("Te respondieron", 1)}
{rr_row("web #95", "Split the checkout into steps", "3h", [chip("@maria", "#a3a4a9"), chip("comentaste", "#a3a4a9"), chip("te respondió: 2 respuestas en tus hilos, commits nuevos", "#96b2d7", True)], "#c678dd")}
{g("Ya revisaste", 2)}
{rr_row("infra #17", "Move staging to the new cluster", "2d", [chip("@leo", "#a3a4a9"), chip("aprobaste", "#8fcf7f")])}
{rr_row("docs #8", "Document the public API limits", "4d", [chip("@sam", "#a3a4a9"), chip("pediste cambios", "#e5c07b")])}
</div>'''


def footer():
    return f'''<div class="row" style="height:30px;padding:0 12px;gap:14px;background:var(--chrome);border-top:1px solid var(--border);font-size:11.5px">
<span class="row" style="gap:5px">{CL(12)}<span style="color:#8fcf7f">72%</span></span><span class="row" style="gap:5px">{CX(12)}<span style="color:#8fcf7f">88%</span></span>
<span class="dim">CPU</span><span>14%</span><span class="dim">RAM</span><span style="color:#e5c07b">58%</span><div style="flex:1"></div>
<div class="row" style="height:24px;padding:0 14px;gap:8px;border-radius:8px;background:var(--accent);color:#101114;font-weight:600">{CL(12)}api › main</div>
<span class="chip" style="background:var(--raised);color:var(--muted)">editando rate-limit.ts</span><div style="flex:1"></div>
<span class="chip" style="background:#e5c07b26;color:#e5c07b">2 PRs con comentarios</span><span class="chip" style="background:#e06c7526;color:#e06c75">1 review pendiente</span></div>'''


def page(body, w, h, extra=""):
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}{extra}html,body{{width:{w}px;height:{h}px;overflow:hidden}}</style></head><body>{body}</body></html>'


def overview():
    return page(f'''<div class="row" style="height:100%;align-items:stretch">{sidebar()}
<div class="col" style="flex:1;min-width:0">{tabs_bar()}<div class="row" style="flex:1;min-height:0;align-items:stretch">{terminal()}
<div style="border-left:1px solid var(--border)">{gh_prs()}</div></div>{footer()}</div></div>''', 1600, 940)


def dialog(inner, w, h):
    return page(f'<div style="padding:28px;background:#0c0d0f;height:100%"><div style="width:{w}px;height:{h}px;background:var(--raised);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 60px #0008;overflow:hidden">{inner}</div></div>', w + 56, h + 56)


def waiting():
    def row(i, st, ic, space, name, sub, buttons):
        color = {"blocked": "#e06c75", "done": "#8fcf7f", "working": "#d97757"}[st]
        return f'''<div class="row" style="height:64px;padding:0 16px;gap:14px;border-radius:9px;{"background:var(--sel)" if i == 1 else ""}">
<span class="dim" style="width:18px">{i}</span><div style="width:11px;height:11px;border-radius:6px;background:{color}"></div>{ic}
<div class="col" style="flex:1;min-width:0"><span class="dim">{space}</span><b>{name}</b><span class="muted" style="font-size:12.5px">{sub}</span></div>{buttons}</div>'''
    alert = lambda who, title, what, b: f'''<div class="row" style="height:54px;padding:0 16px;gap:12px"><span style="color:#e5c07b">◆</span><div class="col" style="flex:1"><span><b>{who}</b> <span class="muted">{title}</span></span><span class="dim" style="font-size:12.5px">{what}</span></div>{b}<span class="dim">✕</span></div>'''
    inner = f'''<div class="row" style="height:48px;padding:0 18px;border-bottom:1px solid var(--border)"><b style="font-size:15px">Esperándote</b><div style="flex:1"></div><span class="dim" style="font-size:11px">⌘J · Esc</span></div>
<div class="col" style="padding:8px">
{row(1, "blocked", CL(16), "web", "IS-13", "pregunta: ¿borro las facturas de prueba?", btn("ir", "#96b2d7"))}
{row(2, "done", CL(16), "api", "IS-42", "terminó", btn("ir", "#96b2d7"))}
{row(3, "done", CX(16), "api", "IS-57", "terminó", btn("ir", "#96b2d7"))}
<div style="padding:12px 16px 4px;font-size:11px;font-weight:600;color:var(--muted)">AVISOS · 2</div>
{alert("web #88", "Invoices: download as PDF", "pidieron cambios · 1 comentario nuevo", btn("/pr-fix…", "#c678dd"))}
{alert("api #219", "Retry webhooks with exponential backoff", "@sam te pidió review otra vez · +312 −40", btn("/pr-review…", "#c678dd"))}
</div>'''
    return dialog(inner, 760, 420)


def close():
    inner = f'''<div class="col" style="height:100%;padding:18px;gap:12px;font-size:13px">
<div class="row"><b style="font-size:15px;flex:1">¿Cerrar Claude Code?</b><span class="dim" style="font-size:11px">Esc</span></div>
<div class="muted" style="flex:1">Claude Code en IS-14 (web). Está trabajando: se corta en el medio.</div>
<div class="row" style="justify-content:flex-end;gap:8px;font-size:12px">
<div class="row" style="height:32px;padding:0 14px;border-radius:8px;border:1px solid #33353a;background:var(--sel)">Cancelar</div>
<div class="row" style="height:32px;padding:0 14px;border-radius:8px;background:#e06c75;color:#fff;font-weight:600">Cerrar (Enter)</div></div></div>'''
    return dialog(inner, 440, 180)


def panel_page(fn):
    return page(f'<div style="height:100%;border-left:1px solid var(--border)">{fn()}</div>', 401, 760)


PAGES = {"overview": (overview, 1600, 940), "github-prs": (lambda: panel_page(gh_prs), 401, 760),
         "github-reviews": (lambda: panel_page(gh_reviews), 401, 640), "waiting": (waiting, 816, 476), "close": (close, 496, 236)}

out = HERE / "out"
out.mkdir(exist_ok=True)
for name, (fn, w, h) in PAGES.items():
    html = HERE / f"{name}.html"
    html.write_text(fn())
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={w},{h}",
                    "--force-device-scale-factor=2", f"--screenshot={out / (name + '.png')}", html.as_uri()],
                   capture_output=True, timeout=60)
    print(name, (out / (name + ".png")).exists())
