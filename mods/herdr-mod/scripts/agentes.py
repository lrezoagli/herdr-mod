#!/usr/bin/env python3
"""Qué está haciendo cada agente (Claude Code o Codex) de herdr-core, leído de lo que
ya escriben ellos. Para Herdr: árbol de agentes, barra de abajo, ⌘J y dormir/despertar.

Por cada terminal de hc con Claude Code o Codex:
- pid, argv, cwd, agent: el proceso del agente y cómo se lanzó.
- session: su sesión (para dormirlo y despertarlo con --resume / codex resume).
- activity: qué está haciendo, en pocas palabras (la última herramienta, "pensando",
  "terminó").

Claude: ~/.claude/sessions/<pid>.json da la sesión; el transcript está en
~/.claude/projects/*/<sesión>.jsonl. Codex: el rollout más nuevo con ese cwd.

Extensiones opcionales: cualquier otro .py al lado con start(ctx) -> enrich(st, info)
recibe cada agente y le agrega lo suyo. Sin extensiones, solo lo de arriba.

Corre cada 5 s, así que guarda lo caro en ~/.cache/herdr-limits/agentes-cache.json:
el pid de cada terminal (mientras ese proceso viva, sin `hc get`), lo leído de cada
transcript (mientras no cambie de tamaño ni de fecha) y el cwd de cada rollout de Codex.

Imprime {"t1b": {...}, ...}. Nunca falla por un agente: ese queda sin datos.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CACHE = f"{HOME}/.cache/herdr-limits/agentes-cache.json"
cache = {"pids": {}, "files": {}, "rollouts": {}}
TEXT_MAX = 2000  # lo último que dijo el agente, para las extensiones


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError):
        return False


def cached(path, fn):
    """fn(path) solo si el archivo cambió desde la última vez."""
    try:
        st = os.stat(path)
    except OSError:
        return {}
    sig = [st.st_size, st.st_mtime]
    hit = cache["files"].get(path)
    if hit and hit[0] == sig:
        cache["used"].add(path)
        return json.loads(json.dumps(hit[1]))
    val = fn(path)
    cache["files"][path] = [sig, val]
    cache["used"].add(path)
    return json.loads(json.dumps(val))


def sh(*argv, cwd=None):
    try:
        r = subprocess.run(list(argv), capture_output=True, text=True, timeout=10, cwd=cwd)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def tail(path, size=384 * 1024):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        end = f.tell()
        f.seek(max(0, end - size))
        lines = f.read().decode("utf-8", "replace").splitlines()
    return lines[1:] if end > size else lines


def short(s, n=70):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def base(p):
    return os.path.basename(str(p or "").rstrip("/")) or str(p or "")


def describe(name, inp):
    inp = inp or {}
    if name == "Read":
        return f"leyendo {base(inp.get('file_path'))}"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"editando {base(inp.get('file_path') or inp.get('notebook_path'))}"
    if name == "Write":
        return f"escribiendo {base(inp.get('file_path'))}"
    if name == "Bash":
        cmd = inp.get("command", "")
        if re.search(r"codex exec|claude -p", cmd):
            return "revisión cruzada (Codex)"
        return short(inp.get("description") or f"$ {cmd}", 60)
    if name in ("Grep", "Glob"):
        return f"buscando {short(inp.get('pattern'), 40)}"
    if name in ("WebFetch", "WebSearch"):
        return "buscando en la web"
    if name == "Skill":
        return f"/{inp.get('skill', '?')}"
    if name in ("Agent", "Task"):
        return f"lanzando {short(inp.get('description') or inp.get('name'), 40)}"
    if name == "SendMessage":
        return f"escribiéndole a {inp.get('to', '?')}"
    if name == "AskUserQuestion":
        return "preguntándote algo"
    if name.startswith("mcp__"):
        return f"usando {name.split('__')[-1].replace('_', ' ')}"
    return name


# Lo que leen las dos lecturas de transcript, para el agente y sus extensiones:
# activity, done (terminó su turno), text (lo último que dijo, recortado),
# commands (los /comandos y $skills que le pediste), skills (las que lanzó él) e
# invoked (las dos cosas juntas, en el orden en que pasaron).

def claude_state(pid):
    try:
        sess = json.load(open(f"{HOME}/.claude/sessions/{pid}.json"))
    except (OSError, ValueError):
        return {}
    sid = sess.get("sessionId")
    files = glob.glob(f"{HOME}/.claude/projects/*/{sid}.jsonl")
    if not files:
        return {}  # sesión sin conversación todavía: no hay nada que retomar
    st = cached(files[0], claude_transcript)
    st["session"] = sid
    # El nombre de la sesión (/rename o -n) y de dónde salió ("derived": Claude lo inventó).
    st["session_name"], st["name_source"] = sess.get("name"), sess.get("nameSource")
    return st


def claude_transcript(path):
    st = {"commands": [], "skills": [], "invoked": []}
    last_kind, last_text = None, ""
    for line in tail(path):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        kind = m.get("type")
        msg = m.get("message") or {}
        c = msg.get("content")
        if kind == "user":
            texts = c if isinstance(c, str) else " ".join(x.get("text", "") for x in (c or []) if isinstance(x, dict) and x.get("type") == "text")
            found = re.findall(r"<command-name>/?([\w:-]+)</command-name>", texts or "")
            st["commands"] += found
            st["invoked"] += found
            if isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
                last_kind = "tool_result"
            elif texts and not m.get("isMeta"):
                last_kind = "user"
            continue
        if kind != "assistant":
            continue
        for x in c if isinstance(c, list) else []:
            if x.get("type") == "tool_use":
                inp = x.get("input") or {}
                if x.get("name") == "Skill" and inp.get("skill"):
                    st["skills"].append(inp["skill"])
                    st["invoked"].append(inp["skill"])
                st["activity"] = describe(x.get("name", ""), inp)
            elif x.get("type") == "text" and x.get("text", "").strip():
                last_text = x["text"]
        last_kind = "end" if msg.get("stop_reason") == "end_turn" else "assistant"
    st["done"] = last_kind == "end"
    if st["done"]:
        st["activity"] = "terminó"
    elif last_kind in ("tool_result", "user"):
        st["activity"] = "pensando"
    st["text"] = last_text[-TEXT_MAX:]
    st["commands"], st["skills"], st["invoked"] = st["commands"][-20:], st["skills"][-20:], st["invoked"][-20:]
    return st


# Codex no deja abierto su rollout: el más nuevo de los últimos días con ese cwd.
# De cada rollout guarda su cwd y su sesión (la primera línea no cambia).
def codex_rollout(cwd):
    best = None
    for path in glob.glob(f"{HOME}/.codex/sessions/*/*/*/*.jsonl"):
        mt = os.path.getmtime(path)
        if mt < time.time() - 3 * 86400 or (best and mt <= best[0]):
            continue
        meta = cache["rollouts"].get(path)
        if meta is None:
            try:
                with open(path, errors="replace") as f:
                    p = json.loads(f.readline()).get("payload") or {}
                meta = [p.get("cwd"), p.get("id")]
            except (OSError, ValueError):
                meta = [None, None]
            cache["rollouts"][path] = meta
        if meta[0] == cwd:
            best = (mt, path, meta[1])
    return (best[1], best[2]) if best else (None, None)


def codex_state(pid, cwd):
    path, sid = codex_rollout(cwd)
    if not path:
        return {}
    st = cached(path, codex_transcript)
    if sid:
        st["session"] = sid
    return st


def codex_transcript(path):
    st = {"commands": [], "skills": [], "invoked": []}
    last_kind, last_text = None, ""
    for line in tail(path):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        p = m.get("payload") or {}
        t = p.get("type")
        if t == "user_message" or (t == "message" and p.get("role") == "user"):
            text = p.get("message") or " ".join(x.get("text", "") for x in (p.get("content") or []) if isinstance(x, dict))
            found = re.findall(r"(?:^|\s)[$/]([\w:-]+)", text or "")
            st["commands"] += found
            st["invoked"] += found
            last_kind = "user"
        elif t in ("function_call", "custom_tool_call"):
            args = p.get("arguments") or p.get("input") or ""
            cmd = ""
            try:
                a = json.loads(args) if isinstance(args, str) else args
                cmd = " ".join(a.get("command")) if isinstance(a.get("command"), list) else a.get("command") or a.get("cmd") or ""
            except (ValueError, AttributeError):
                cmd = str(args)
            st["activity"] = "revisión cruzada (Claude)" if re.search(r"claude -p", cmd) else short(f"$ {cmd}" if cmd else p.get("name", ""), 60)
            last_kind = "tool"
        elif t in ("agent_message",) or (t == "message" and p.get("role") == "assistant"):
            text = p.get("message") or " ".join(x.get("text", "") for x in (p.get("content") or []) if isinstance(x, dict))
            if text:
                last_text = text
            last_kind = "assistant"
        elif t == "task_complete":
            last_kind = "end"
    st["done"] = last_kind == "end"
    if st["done"]:
        st["activity"] = "terminó"
    st["text"] = last_text[-TEXT_MAX:]
    st["commands"], st["skills"], st["invoked"] = st["commands"][-20:], st["skills"][-20:], st["invoked"][-20:]
    return st


# Extensiones: cualquier otro .py al lado con start(ctx) -> enrich(st, info).
CORE = {"agentes", "teams", "prs", "usage", "limits"}


def extensions(ctx):
    here = os.path.dirname(os.path.abspath(__file__))
    out = []
    sys.path.insert(0, here)
    for f in sorted(os.listdir(here)):
        name, ext = os.path.splitext(f)
        if ext != ".py" or name in CORE or name.startswith("_"):
            continue
        try:
            mod = __import__(name)
            if hasattr(mod, "start"):
                out.append(mod.start(ctx))
        except Exception:  # noqa: BLE001 - una extensión rota no apaga la lista
            pass
    return out


def main():
    global cache
    try:
        cache = json.load(open(CACHE))
    except (OSError, ValueError):
        pass
    for k in ("pids", "files", "rollouts"):
        cache.setdefault(k, {})
    cache["used"] = set()
    out = {}
    term = json.loads(sh("hc", "ls", "--json") or "{}").get("terminals", [])
    exts = extensions({"sh": sh, "cache": cache})
    live = set()
    for t in term:
        if t.get("state") != "live" or t.get("agent") not in ("claude-code", "codex"):
            continue
        try:
            addr = t["address"]
            live.add(addr)
            hit = cache["pids"].get(addr)
            if hit and hit[3] == t.get("agent") and alive(hit[0]):
                pid, argv, cwd = hit[0], hit[1], hit[2]
            else:
                g = json.loads(sh("hc", "get", addr, "--json") or "{}")
                fg = g.get("foreground") or {}
                pid, argv, cwd = fg.get("pid"), fg.get("argv"), fg.get("cwd") or t.get("cwd")
                if not pid:
                    continue
                cache["pids"][addr] = [pid, argv, cwd, t.get("agent")]
            st = claude_state(pid) if t["agent"] == "claude-code" else codex_state(pid, cwd)
            info = {"pid": pid, "argv": argv, "cwd": cwd, "agent": t.get("agent")}
            for enrich in exts:
                try:
                    enrich(st, info)
                except Exception:  # noqa: BLE001
                    pass
            for k in ("done", "text", "commands", "skills", "invoked"):
                st.pop(k, None)
            st.update(info)
            out[addr] = st
        except Exception:  # noqa: BLE001 - un agente raro no tapa a los demás
            continue
    # Sin lo que ya no está: terminales que se fueron, archivos que no se leyeron.
    cache["pids"] = {k: v for k, v in cache["pids"].items() if k in live}
    cache["files"] = {k: v for k, v in cache["files"].items() if k in cache["used"]}
    cache["rollouts"] = {k: v for k, v in cache["rollouts"].items() if os.path.exists(k) and os.path.getmtime(k) > time.time() - 4 * 86400}
    cache.pop("used")
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = f"{CACHE}.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(cache, f)
        os.replace(tmp, CACHE)
    except OSError:
        pass
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
