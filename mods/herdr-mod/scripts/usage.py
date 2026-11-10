#!/usr/bin/env python3
"""Consumo de Claude Code y Codex leido de sus registros locales (idea de Orca).

- Claude: ~/.claude/projects/**/*.jsonl (sesiones y sub-agentes). Cada respuesta
  del modelo trae message.usage (input, output, cache read, cache write 5m/1h) y
  message.model; una misma respuesta se escribe en varias lineas con el mismo
  message.id, se cuenta una vez.
- Codex: ~/.codex/sessions/**/*.jsonl, eventos token_count (last_token_usage;
  input incluye lo cacheado), task_started (un turno) y el modelo de turn_context.

Incremental: ~/.cache/herdr-limits/usage-index.json guarda hasta donde leyo cada
archivo y los totales por dia, modelo y proyecto. Mira archivos tocados desde el 1
del mes (o los ultimos 8 dias, lo que sea antes) y guarda 70 dias de totales.

Costo estimado equivalente a API (USD por millon de tokens, tabla de Orca). Los
modelos sin precio (y todo Codex) cuentan tokens pero no costo.

Imprime {"claude": {...}, "codex": {...}} con today, week (7 dias), daily (7),
models y projects.
"""
import fcntl
import glob
import json
import os
import time
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")
INDEX = f"{HOME}/.cache/herdr-limits/usage-index.json"
SCAN_DAYS, KEEP_DAYS = 8, 70  # se lee desde el 1 del mes si es antes que 8 dias

PRICES = {  # input, output, cache read, cache write 5m, cache write 1h
    "claude-fable-5-1": (10, 50, .25, 12.5, 20), "claude-fable-5": (10, 50, 1, 12.5, 20),
    "claude-opus-5-5": (4, 20, .2, 5, 8), "claude-opus-5": (5, 25, .5, 6.25, 10),
    "claude-sonnet-5": (2, 10, .2, 2.5, 4),
    "claude-opus-4-8": (5, 25, .5, 6.25, 10), "claude-opus-4-7": (5, 25, .5, 6.25, 10),
    "claude-opus-4-6": (5, 25, .5, 6.25, 10), "claude-opus-4-5": (5, 25, .5, 6.25, 10),
    "claude-opus-4-1": (15, 75, 1.5, 18.75, 30), "claude-opus-4": (15, 75, 1.5, 18.75, 30),
    "claude-sonnet-4-6": (3, 15, .3, 3.75, 6), "claude-sonnet-4-5": (3, 15, .3, 3.75, 6),
    "claude-sonnet-4": (3, 15, .3, 3.75, 6), "claude-haiku-4-5": (1, 5, .1, 1.25, 2),
}


def price(model):
    m = (model or "").lower()
    # Exacto o con fecha (claude-opus-4-5-20251101); claude-sonnet-5-5 no es claude-sonnet-5.
    for k in PRICES:
        if m == k or m.startswith(k + "-20"):
            return PRICES[k]
    return None


def day_of(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except (AttributeError, ValueError):
        return None


def project_of(cwd):
    parts = [p for p in (cwd or "").split("/") if p]
    for mark in ("worktrees", "workspaces"):
        if mark in parts and parts.index(mark) + 1 < len(parts):
            return parts[parts.index(mark) + 1]
    return parts[-1] if parts else "?"


def bucket(idx, tool, day):
    return idx["days"].setdefault(day, {}).setdefault(tool, {"models": {}, "projects": {}, "sessions": [], "turns": 0})


def add(b, model, project, session, inp, out, cr, cw, cost):
    m = b["models"].setdefault(model or "?", [0, 0, 0, 0, 0.0, 0])  # in, out, cr, cw, cost, sin precio
    m[0] += inp; m[1] += out; m[2] += cr; m[3] += cw
    if cost is None:
        m[5] = 1
    else:
        m[4] += cost
    b["projects"][project] = b["projects"].get(project, 0) + inp + out + cr + cw
    if session and session not in b["sessions"]:
        b["sessions"].append(session)


def new_lines(idx, path):
    st = os.stat(path)
    f = idx["files"].get(path, {"off": 0})
    if st.st_size < f["off"]:
        f["off"] = 0
    if st.st_size == f["off"]:
        return []
    with open(path, "rb") as fh:
        fh.seek(f["off"])
        data = fh.read()
    cut = data.rfind(b"\n") + 1  # solo lineas completas
    f["off"] += cut
    idx["files"][path] = f
    return data[:cut].decode("utf-8", "replace").splitlines()


def scan_claude(idx, since):
    seen = idx.setdefault("seen", {})
    for path in glob.glob(f"{HOME}/.claude/projects/**/*.jsonl", recursive=True):
        if os.path.getmtime(path) < since:
            continue
        session = os.path.basename(os.path.dirname(os.path.dirname(path))) if "/subagents/" in path else os.path.basename(path)[:-6]
        for line in new_lines(idx, path):
            if '"usage"' not in line and '"type":"user"' not in line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            day = day_of(m.get("timestamp"))
            if not day:
                continue
            if m.get("type") == "user":
                c = (m.get("message") or {}).get("content")
                human = isinstance(c, str) or (isinstance(c, list) and not any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c))
                if human and not m.get("isMeta") and not m.get("isSidechain") and "/subagents/" not in path:
                    bucket(idx, "claude", day)["turns"] += 1
                continue
            msg = m.get("message") or {}
            u = msg.get("usage")
            if m.get("type") != "assistant" or not isinstance(u, dict):
                continue
            key = msg.get("id") or m.get("requestId") or m.get("uuid")
            if key in seen:
                continue
            seen[key] = day
            model = msg.get("model")
            if model == "<synthetic>":
                continue
            inp, out = u.get("input_tokens") or 0, u.get("output_tokens") or 0
            cr, cw = u.get("cache_read_input_tokens") or 0, u.get("cache_creation_input_tokens") or 0
            cc = u.get("cache_creation") or {}
            cw1h = cc.get("ephemeral_1h_input_tokens") or 0
            cw5m = cc.get("ephemeral_5m_input_tokens") or max(cw - cw1h, 0)
            p = price(model)
            cost = None if not p else (inp * p[0] + out * p[1] + cr * p[2] + cw5m * p[3] + cw1h * p[4]) / 1e6
            add(bucket(idx, "claude", day), model, project_of(m.get("cwd")), session, inp, out, cr, cw, cost)


def scan_codex(idx, since):
    ctx = idx.setdefault("codex_ctx", {})
    for path in glob.glob(f"{HOME}/.codex/sessions/**/*.jsonl", recursive=True):
        if os.path.getmtime(path) < since:
            continue
        state = ctx.setdefault(path, {"model": None, "cwd": None})
        session = os.path.basename(path)[:-6]
        for line in new_lines(idx, path):
            if '"turn_context"' not in line and '"token_count"' not in line and '"task_started"' not in line and '"session_meta"' not in line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            p = m.get("payload") or {}
            kind = m.get("type")
            if kind in ("turn_context", "session_meta"):
                state["model"] = p.get("model") or state["model"]
                state["cwd"] = p.get("cwd") or state["cwd"]
                continue
            day = day_of(m.get("timestamp"))
            if not day:
                continue
            if p.get("type") == "task_started":
                bucket(idx, "codex", day)["turns"] += 1
            elif p.get("type") == "token_count":
                u = (p.get("info") or {}).get("last_token_usage")
                if not u:
                    continue
                cached = u.get("cached_input_tokens") or 0
                inp = max((u.get("input_tokens") or 0) - cached, 0)
                add(bucket(idx, "codex", day), state["model"], project_of(state["cwd"]), session,
                    inp, u.get("output_tokens") or 0, cached, u.get("cache_write_input_tokens") or 0, None)


def summary(idx, tool, days):
    s = {"in": 0, "out": 0, "cr": 0, "cw": 0, "cost": 0.0, "unpriced": False, "turns": 0, "sessions": 0}
    models, projects, sessions = {}, {}, set()
    for d in days:
        b = idx["days"].get(d, {}).get(tool)
        if not b:
            continue
        s["turns"] += b["turns"]
        sessions.update(b["sessions"])
        for name, m in b["models"].items():
            s["in"] += m[0]; s["out"] += m[1]; s["cr"] += m[2]; s["cw"] += m[3]; s["cost"] += m[4]
            s["unpriced"] = s["unpriced"] or bool(m[5])
            acc = models.setdefault(name, {"model": name, "tokens": 0, "cost": 0.0})
            acc["tokens"] += sum(m[:4]); acc["cost"] += m[4]
        for name, n in b["projects"].items():
            projects[name] = projects.get(name, 0) + n
    s["sessions"] = len(sessions)
    s["total"] = s["in"] + s["out"] + s["cr"] + s["cw"]
    # Del prompt que mando al modelo, cuanto salio de la cache (lo demas se escribio o se mando entero).
    sent = s["in"] + s["cr"] + s["cw"]
    s["cache_rate"] = round(100 * s["cr"] / sent, 1) if sent else None
    s["cost"] = round(s["cost"], 2)
    s["models"] = sorted(models.values(), key=lambda x: -x["tokens"])[:4]
    s["projects"] = [{"name": k, "tokens": v} for k, v in sorted(projects.items(), key=lambda x: -x[1])[:4]]
    return s


def main():
    # La barra y el panel lo corren a la vez: uno por vez sobre el indice.
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    lock = open(INDEX + ".lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        idx = json.load(open(INDEX))
        if idx.get("version") != 2:
            raise ValueError
    except (OSError, ValueError):
        idx = {"version": 2, "files": {}, "days": {}, "seen": {}}
    month_start = datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    since = min(time.time() - SCAN_DAYS * 86400, month_start.timestamp())
    scan_claude(idx, since)
    scan_codex(idx, since)
    # Podar: dias viejos, ids vistos de esos dias y archivos que ya no se tocan.
    oldest = (datetime.now() - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    idx["days"] = {d: v for d, v in idx["days"].items() if d >= oldest}
    scan_from = (datetime.fromtimestamp(since) - timedelta(days=1)).strftime("%Y-%m-%d")
    idx["seen"] = {k: d for k, d in idx["seen"].items() if d >= scan_from}
    idx["files"] = {p: f for p, f in idx["files"].items() if os.path.exists(p) and os.path.getmtime(p) >= since - 86400}
    idx["codex_ctx"] = {p: c for p, c in idx.get("codex_ctx", {}).items() if p in idx["files"]}
    tmp = f"{INDEX}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(idx, f)
    os.replace(tmp, INDEX)

    week = [(datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
    # El mes en curso, del 1 a hoy, y cuantos dias tiene (para proyectar el cierre).
    today = datetime.now()
    month = [(month_start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(today.day)]
    month_len = ((month_start + timedelta(days=32)).replace(day=1) - month_start).days
    elapsed = today.day - 1 + (today.hour * 3600 + today.minute * 60) / 86400
    out = {}
    for tool in ("claude", "codex"):
        daily = [{"day": d, **{k: v for k, v in summary(idx, tool, [d]).items() if k in ("total", "cost", "out")}} for d in week]
        m = summary(idx, tool, month)
        m["projected_cost"] = round(m["cost"] * month_len / elapsed, 2) if elapsed > 0.5 else None
        m["projected_total"] = round(m["total"] * month_len / elapsed) if elapsed > 0.5 else None
        m["name"] = month_start.strftime("%m")
        m["days"] = today.day
        m["month_len"] = month_len
        out[tool] = {"today": summary(idx, tool, week[-1:]), "week": summary(idx, tool, week), "month": m, "daily": daily}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
