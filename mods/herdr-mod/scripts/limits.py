#!/usr/bin/env python3
"""Limites de uso de Claude Code y de Codex, para el panel Uso de Herdr.

- Claude Code: ~/.claude/statusline.sh guarda en ~/.cache/herdr-limits/claude.json
  los rate_limits que Claude le pasa a la barra de estado (five_hour, seven_day:
  used_percentage, resets_at) y cuando ("at"). Solo se actualiza con un Claude abierto.
- Codex: cada sesion de ~/.codex/sessions anota rate_limits en sus eventos
  (primary/secondary: used_percent, window_minutes, resets_at; plan_type). Se toma
  el ultimo de las sesiones mas nuevas.

Imprime {"claude": {"at", "windows": [{"label", "used", "resets_at"}]},
         "codex": {"at", "plan", "windows": [...]}}; un lado falta si no hay datos.
"""
import base64
import glob
import json
import os
from datetime import datetime

HOME = os.path.expanduser("~")


def label(minutes):
    if not minutes:
        return "?"
    if minutes >= 10080 - 60:
        return "semana"
    if minutes % 60 == 0:
        return f"{minutes // 60} h"
    return f"{minutes} min"


def claude():
    try:
        d = json.load(open(f"{HOME}/.cache/herdr-limits/claude.json"))
    except (OSError, ValueError):
        return None
    rl = d.get("rate_limits") or {}
    names = {"five_hour": "5 h", "seven_day": "semana", "seven_day_opus": "semana Opus", "seven_day_sonnet": "semana Sonnet"}
    minutes = {"five_hour": 300}
    windows = [{"label": names.get(k, k.replace("_", " ")), "used": v.get("used_percentage"), "resets_at": v.get("resets_at"),
                "minutes": minutes.get(k, 10080 if k.startswith("seven_day") else None)}
               for k, v in rl.items() if isinstance(v, dict) and v.get("used_percentage") is not None]
    order = list(names)
    windows.sort(key=lambda w: order.index(next((k for k, n in names.items() if n == w["label"]), "zz")) if w["label"] in names.values() else 99)
    return {"at": int(d.get("at", 0) * 1000), "windows": windows}


def tail(path, size=512 * 1024):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        end = f.tell()
        f.seek(max(0, end - size))
        return f.read().decode("utf-8", "replace").splitlines()


def find(o):
    if isinstance(o, dict):
        if isinstance(o.get("rate_limits"), dict):
            return o["rate_limits"]
        for v in o.values():
            r = find(v)
            if r is not None:
                return r
    return None


def codex():
    files = glob.glob(f"{HOME}/.codex/sessions/*/*/*/*.jsonl")
    for path in sorted(files, key=os.path.getmtime, reverse=True)[:40]:
        for line in reversed(tail(path)):
            if '"rate_limits"' not in line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            rl = find(m)
            if not rl:
                continue
            windows = [{"label": label(w.get("window_minutes")), "used": w.get("used_percent"), "resets_at": w.get("resets_at"), "minutes": w.get("window_minutes")}
                       for w in (rl.get("primary"), rl.get("secondary")) if isinstance(w, dict) and w.get("used_percent") is not None]
            if not windows:
                continue
            try:
                at = int(datetime.fromisoformat(m.get("timestamp", "").replace("Z", "+00:00")).timestamp() * 1000)
            except ValueError:
                at = int(os.path.getmtime(path) * 1000)
            windows.sort(key=lambda w: w["label"] == "semana")
            return {"at": at, "plan": rl.get("plan_type"), "windows": windows}
    return None


# La cuenta de cada uno: solo campos que no son secretos (nunca los tokens).
def claude_account():
    oa = json.load(open(f"{HOME}/.claude.json")).get("oauthAccount") or {}
    return {"email": oa.get("emailAddress"), "plan": oa.get("planDisplayName"), "extra": oa.get("hasExtraUsageEnabled")}


def codex_account():
    a = json.load(open(f"{HOME}/.codex/auth.json"))
    t = ((a.get("tokens") or {}).get("id_token") or "").split(".")
    if len(t) < 2:
        return {"mode": a.get("auth_mode")}
    p = json.loads(base64.urlsafe_b64decode(t[1] + "=" * (-len(t[1]) % 4)))
    au = p.get("https://api.openai.com/auth") or {}
    return {"email": p.get("email"), "plan": au.get("chatgpt_plan_type"), "until": au.get("chatgpt_subscription_active_until")}


out = {}
for name, fn in (("claude", claude), ("codex", codex)):
    try:
        r = fn()
    except Exception:  # noqa: BLE001 - un lado roto no tapa al otro
        r = None
    if r:
        out[name] = r
for name, fn in (("claude", claude_account), ("codex", codex_account)):
    try:
        out.setdefault(name, {})["account"] = fn()
    except Exception:  # noqa: BLE001
        pass
print(json.dumps(out))
