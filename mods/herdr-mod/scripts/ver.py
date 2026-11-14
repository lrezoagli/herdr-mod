#!/usr/bin/env python3
"""What a sub-agent is doing, for the "watch" dialog (role ver).

  ver.py claude <transcript.jsonl>   a Claude sub-agent or teammate
  ver.py log <file.log>              a Codex plugin job (review, adversarial, rescue)

Prints {"events": [{"kind": "ask"|"say"|"tool"|"result"|"info", "text", "at"}], "done": bool},
newest last, at most the last 80.
"""
import json
import os
import re
import sys

MAX = 80


def tail(path, size=512 * 1024):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        end = f.tell()
        f.seek(max(0, end - size))
        lines = f.read().decode("utf-8", "replace").splitlines()
    return lines[1:] if end > size else lines


def clip(s, n=600):
    s = str(s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def tool_text(name, inp):
    inp = inp or {}
    if name == "Bash":
        return f"$ {inp.get('command', '')}" + (f"   # {inp['description']}" if inp.get("description") else "")
    for k in ("file_path", "notebook_path", "pattern", "url", "query", "description", "skill", "prompt"):
        if inp.get(k):
            return f"{name} {inp[k]}"
    return name


def claude(path):
    ev, done = [], False
    for line in tail(path):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        at = m.get("timestamp", "")
        msg = m.get("message") or {}
        c = msg.get("content")
        if m.get("type") == "user":
            if isinstance(c, str):
                ev.append({"kind": "ask", "text": clip(c, 1500), "at": at})
            for x in c if isinstance(c, list) else []:
                if x.get("type") == "text" and x.get("text", "").strip():
                    ev.append({"kind": "ask", "text": clip(x["text"], 1500), "at": at})
                elif x.get("type") == "tool_result":
                    r = x.get("content")
                    r = r if isinstance(r, str) else " ".join(y.get("text", "") for y in (r or []) if isinstance(y, dict))
                    ev.append({"kind": "result", "text": clip(r, 300), "at": at, "error": bool(x.get("is_error"))})
            done = False
        elif m.get("type") == "assistant":
            for x in c if isinstance(c, list) else []:
                if x.get("type") == "text" and x.get("text", "").strip():
                    ev.append({"kind": "say", "text": clip(x["text"], 3000), "at": at})
                elif x.get("type") == "tool_use":
                    ev.append({"kind": "tool", "text": clip(tool_text(x.get("name", ""), x.get("input")), 400), "at": at})
            done = msg.get("stop_reason") == "end_turn"
    return ev, done


LOG = re.compile(r"^\[([0-9T:.\-]+Z)\]\s*(.*)$")


def codex(path):
    ev, done, cur = [], False, None
    for line in tail(path):
        m = LOG.match(line)
        if not m:
            if cur is not None:  # continuation of a multi-line message
                cur["text"] = clip(f"{cur['text']}\n{line}", 3000)
            continue
        at, text = m.groups()
        cur = None
        if text.startswith("Assistant message captured"):
            continue  # the full message comes right after
        if text == "Assistant message":
            cur = {"kind": "say", "text": "", "at": at}
            ev.append(cur)
        elif text.startswith("Running command:"):
            ev.append({"kind": "tool", "text": "$ " + text.split(":", 1)[1].strip(), "at": at})
        elif text.startswith("Command completed:"):
            continue
        else:
            ev.append({"kind": "info", "text": clip(text, 400), "at": at})
            if re.search(r"(completed|finished|Cancelled|failed)", text, re.I) and "Command" not in text:
                done = True
    for e in ev:
        e["text"] = e["text"].strip()
    return [e for e in ev if e["text"]], done


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("claude", "log"):
        sys.exit(__doc__)
    try:
        ev, done = (claude if sys.argv[1] == "claude" else codex)(sys.argv[2])
    except OSError as e:
        print(json.dumps({"events": [], "done": True, "error": str(e)}))
        return
    print(json.dumps({"events": ev[-MAX:], "done": done}, ensure_ascii=False))


if __name__ == "__main__":
    main()
