#!/usr/bin/env python3
"""Compañeros de los equipos de Claude Code (agent teams), por terminal de hc.

Claude guarda cada equipo en ~/.claude/teams/<equipo>/config.json: el pid del
agente principal (leadProcess.pid) y los compañeros vivos (members; al cerrarse
uno, sale de la lista). El pid es el del programa que hc tiene en primer plano
en esa terminal (`hc get <t>` -> foreground.pid).

Lo demas sale del transcript de cada compañero
(~/.claude/projects/*/<sesion del lead>/subagents/agent-a<nombre>-*.jsonl):
- status: si lo ultimo que escribio el modelo cerro el turno (end_turn) y no le
  llego nada despues, esta libre ("idle"); si no, trabajando ("working").
- activity: que esta haciendo ahora, en pocas palabras ("leyendo main.js").
- recent: sus ultimas acciones, la mas nueva primero, con su hora (ms).
- result: lo ultimo que contesto (el texto de su ultimo turno); said, su
  primera frase (sin tablas ni titulos), para avisos y resumenes.

Imprime {"t1b": [{"name", "color", "model", "status", "activity", "recent",
"result", "task", "since", "turn_at"}], ...}.
"""
import glob
import json
import os
import socket
import subprocess
from datetime import datetime
from urllib.parse import urlparse

HOME = os.path.expanduser("~")
RECENT = 5


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError):
        return False


def tail_lines(path, size=256 * 1024):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        end = f.tell()
        f.seek(max(0, end - size))
        data = f.read().decode("utf-8", "replace")
    lines = data.splitlines()
    return lines[1:] if end > size else lines


def ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return 0


def short(s, n=60):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def base(p):
    return os.path.basename(str(p or "").rstrip("/")) or str(p or "")


# Una accion del modelo, contada como la contaria una persona.
def describe(name, inp):
    inp = inp or {}
    if name == "Read":
        return f"leyendo {base(inp.get('file_path'))}"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"editando {base(inp.get('file_path') or inp.get('notebook_path'))}"
    if name == "Write":
        return f"escribiendo {base(inp.get('file_path'))}"
    if name == "Bash":
        return short(inp.get("description") or f"$ {inp.get('command', '')}", 70)
    if name == "Grep":
        return f"buscando “{short(inp.get('pattern'), 40)}”"
    if name == "Glob":
        return f"buscando {short(inp.get('pattern'), 40)}"
    if name == "WebFetch":
        return f"leyendo {urlparse(inp.get('url', '')).netloc or 'una página'}"
    if name == "WebSearch":
        return f"buscando en la web “{short(inp.get('query'), 40)}”"
    if name == "SendMessage":
        return f"escribiéndole a {inp.get('to', '?')}"
    if name in ("Agent", "Task"):
        return f"lanzando {short(inp.get('description') or inp.get('name'), 40)}"
    if name in ("TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"):
        return "ordenando sus tareas"
    if name.startswith("mcp__"):
        return f"usando {name.split('__')[-1].replace('_', ' ')}"
    return name


# La primera frase de una respuesta: sin tablas, titulos ni bloques de codigo.
def first_said(text):
    lines = [l.strip() for l in text.splitlines()]
    prose = [l for l in lines if l and not l.startswith(("|", "#", "```", "---", ":--"))]
    line = (prose or [l for l in lines if l] or [""])[0]
    return short(line.lstrip("-*• ").replace("**", "").replace("`", ""), 160)


def read_transcript(session, name):
    out = {"status": "working", "activity": "arrancando", "recent": [], "result": "", "said": "", "turn_at": 0}
    files = glob.glob(f"{HOME}/.claude/projects/*/{session}/subagents/agent-a{name}-*.jsonl")
    if not files:
        return out
    path = max(files, key=os.path.getmtime)
    entries = []
    for line in tail_lines(path):
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    last_kind = None
    for m in entries:
        kind = m.get("type")
        if kind not in ("assistant", "user"):
            continue
        msg = m.get("message") or {}
        content = msg.get("content")
        if kind == "user":
            # Un resultado de herramienta no es un mensaje nuevo: sigue el mismo turno.
            if isinstance(content, list) and all(c.get("type") == "tool_result" for c in content if isinstance(c, dict)):
                last_kind = "tool_result"
                continue
            last_kind = "user"
            out["turn_at"] = ms(m.get("timestamp"))
            out["result"] = ""
            continue
        last_kind = "assistant_end" if msg.get("stop_reason") == "end_turn" else "assistant"
        for c in content if isinstance(content, list) else []:
            if c.get("type") == "tool_use":
                out["recent"].append({"text": describe(c.get("name", ""), c.get("input")), "at": ms(m.get("timestamp"))})
            elif c.get("type") == "text" and c.get("text", "").strip():
                out["result"] = c["text"].strip()
    out["recent"] = out["recent"][-RECENT:][::-1]
    if last_kind == "assistant_end":
        out["status"], out["activity"] = "idle", "terminó"
    else:
        out["status"] = "working"
        out["result"] = ""
        if last_kind == "assistant" and out["recent"]:
            out["activity"] = out["recent"][0]["text"]
        elif out["recent"]:
            out["activity"] = "pensando"
    out["said"] = first_said(out["result"])
    out["result"] = out["result"][:1200]
    return out


def hc(*args):
    out = subprocess.run(["hc", *args, "--json"], capture_output=True, text=True, timeout=10)
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


def main():
    host = socket.gethostname()
    by_pid = {}
    for cfg in glob.glob(f"{HOME}/.claude/teams/*/config.json"):
        try:
            d = json.load(open(cfg))
        except (OSError, ValueError):
            continue
        lp = d.get("leadProcess") or {}
        pid = lp.get("pid")
        if lp.get("pidSpace") not in (None, host) or not alive(pid):
            continue
        mates = [m for m in d.get("members", []) if m.get("agentType") != "team-lead"]
        if not mates:
            continue
        session = d.get("leadSessionId", "")
        by_pid[pid] = [{
            "name": m["name"],
            "color": m.get("color"),
            "model": m.get("model"),
            "task": short(m.get("prompt"), 400),
            "since": m.get("joinedAt") or 0,
            **read_transcript(session, m["name"]),
        } for m in mates]
    if not by_pid:
        print("{}")
        return
    out = {}
    for t in (hc("ls") or {}).get("terminals", []):
        if t.get("agent") != "claude-code" or t.get("state") != "live":
            continue
        g = hc("get", t["address"]) or {}
        pid = (g.get("foreground") or {}).get("pid")
        if pid in by_pid:
            out[t["address"]] = by_pid[pid]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
