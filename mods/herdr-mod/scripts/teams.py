#!/usr/bin/env python3
"""Teammates of Claude Code teams (agent teams), per hc terminal.

Claude stores each team in ~/.claude/teams/<team>/config.json: the pid of the
lead agent (leadProcess.pid) and the live teammates (members; when one closes,
it drops off the list). The pid is that of the program hc has in the foreground
in that terminal (`hc get <t>` -> foreground.pid).

Everything else comes from each teammate's transcript
(~/.claude/projects/*/<lead session>/subagents/agent-a<name>-*.jsonl):
- status: if the last thing the model wrote ended the turn (end_turn) and nothing
  arrived after it, it is free ("idle"); otherwise working ("working").
- activity: what it is doing now, in a few words ("reading main.js").
- recent: its last actions, newest first, with their time (ms).
- result: the last thing it answered (the text of its last turn); said, its
  first sentence (no tables or headings), for notifications and summaries.

Prints {"t1b": [{"name", "color", "model", "status", "activity", "recent",
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


# A model action, described the way a person would.
def describe(name, inp):
    inp = inp or {}
    if name == "Read":
        return f"reading {base(inp.get('file_path'))}"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"editing {base(inp.get('file_path') or inp.get('notebook_path'))}"
    if name == "Write":
        return f"writing {base(inp.get('file_path'))}"
    if name == "Bash":
        return short(inp.get("description") or f"$ {inp.get('command', '')}", 70)
    if name == "Grep":
        return f"searching “{short(inp.get('pattern'), 40)}”"
    if name == "Glob":
        return f"searching {short(inp.get('pattern'), 40)}"
    if name == "WebFetch":
        return f"reading {urlparse(inp.get('url', '')).netloc or 'a web page'}"
    if name == "WebSearch":
        return f"searching the web “{short(inp.get('query'), 40)}”"
    if name == "SendMessage":
        return f"messaging {inp.get('to', '?')}"
    if name in ("Agent", "Task"):
        return f"launching {short(inp.get('description') or inp.get('name'), 40)}"
    if name in ("TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"):
        return "organizing its tasks"
    if name.startswith("mcp__"):
        return f"using {name.split('__')[-1].replace('_', ' ')}"
    return name


# The first sentence of an answer: no tables, headings or code blocks.
def first_said(text):
    lines = [l.strip() for l in text.splitlines()]
    prose = [l for l in lines if l and not l.startswith(("|", "#", "```", "---", ":--"))]
    line = (prose or [l for l in lines if l] or [""])[0]
    return short(line.lstrip("-*• ").replace("**", "").replace("`", ""), 160)


def read_transcript(session, name):
    out = {"status": "working", "activity": "starting", "recent": [], "result": "", "said": "", "turn_at": 0}
    files = glob.glob(f"{HOME}/.claude/projects/*/{session}/subagents/agent-a{name}-*.jsonl")
    if not files:
        return out
    path = max(files, key=os.path.getmtime)
    out["path"] = path
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
            # A tool result is not a new message: the same turn continues.
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
        out["status"], out["activity"] = "idle", "finished"
    else:
        out["status"] = "working"
        out["result"] = ""
        if last_kind == "assistant" and out["recent"]:
            out["activity"] = out["recent"][0]["text"]
        elif out["recent"]:
            out["activity"] = "thinking"
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
