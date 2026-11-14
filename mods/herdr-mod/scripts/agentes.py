#!/usr/bin/env python3
"""What each herdr-core agent (Claude Code or Codex) is doing, read from what the
agents already write themselves. For Herdr: agent tree, bottom bar, ⌘J and sleep/wake.

For each hc terminal running Claude Code or Codex:
- pid, argv, cwd, agent: the agent's process and how it was launched.
- session: its session (to put it to sleep and wake it with --resume / codex resume).
- activity: what it is doing, in a few words (the last tool, "thinking",
  "finished").
- review: Codex (or Claude) working for it right now: /codex:review,
  /codex:adversarial-review and /codex:rescue from the Codex plugin for Claude Code (its
  jobs in ~/.claude/plugins/data/*/state/*/jobs, tied to the agent by session), or a
  `codex exec` / `claude -p` launched under it. {pid, secs, tool, kind, phase?, stop?,
  others?: [the rest, if several run at once]}.
- subagents: Claude's own sub-agents (Agent tool) still running: {id, name, type,
  activity, secs, bg, path (its transcript)}. Codex jobs also carry `log`.

Claude: ~/.claude/sessions/<pid>.json gives the session; the transcript is at
~/.claude/projects/*/<session>.jsonl. Codex: the newest rollout with that cwd.

Optional extensions: any other .py next to this one with start(ctx) -> enrich(st, info)
receives each agent and adds its own fields. Without extensions, only the above.

Runs every 5 s, so it caches the expensive parts in ~/.cache/herdr-limits/agentes-cache.json:
the pid of each terminal (while that process lives, no `hc get`), what was read from each
transcript (while its size and mtime don't change) and the cwd of each Codex rollout.

Prints {"t1b": {...}, ...}. Never fails because of one agent: that one just has no data.
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
TEXT_MAX = 2000  # the last thing the agent said, for extensions


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError):
        return False


def cached(path, fn):
    """fn(path) only if the file changed since last time."""
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
        return f"reading {base(inp.get('file_path'))}"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"editing {base(inp.get('file_path') or inp.get('notebook_path'))}"
    if name == "Write":
        return f"writing {base(inp.get('file_path'))}"
    if name == "Bash":
        cmd = inp.get("command", "")
        if re.search(r"codex exec|claude -p", cmd):
            return "cross-review (Codex)"
        return short(inp.get("description") or f"$ {cmd}", 60)
    if name in ("Grep", "Glob"):
        return f"searching {short(inp.get('pattern'), 40)}"
    if name in ("WebFetch", "WebSearch"):
        return "searching the web"
    if name == "Skill":
        return f"/{inp.get('skill', '?')}"
    if name in ("Agent", "Task"):
        return f"launching {short(inp.get('description') or inp.get('name'), 40)}"
    if name == "SendMessage":
        return f"messaging {inp.get('to', '?')}"
    if name == "AskUserQuestion":
        return "asking you something"
    if name.startswith("mcp__"):
        return f"using {name.split('__')[-1].replace('_', ' ')}"
    return name


# Codex working for an agent. The Codex plugin for Claude Code keeps one JSON per job,
# with the Claude session that started it; its review runs through an app-server that
# isn't a child of the agent, so ps alone doesn't see it. ps covers the rest: a
# `codex exec` / `claude -p` under the agent (loopkit's cross-reviews, scripts).
PLUGIN_JOBS = f"{HOME}/.claude/plugins/data/*/state/*/jobs/*.json"
KINDS = {"review": "review", "adversarial-review": "adversarial", "task": "rescue"}


def iso_secs(s):
    try:
        from datetime import datetime
        return max(0, int(time.time() - datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()))
    except (TypeError, ValueError):
        return 0


def first_file(*patterns):
    for pat in patterns:
        hits = sorted(glob.glob(pat), key=os.path.getmtime)
        if hits:
            return hits[-1]


def plugin_jobs():
    """Claude session -> its running Codex plugin job."""
    out = {}
    node = first_file("/opt/homebrew/bin/node", "/usr/local/bin/node", f"{HOME}/.volta/bin/node", f"{HOME}/.nvm/versions/node/*/bin/node")
    script = first_file(f"{HOME}/.claude/plugins/cache/*/codex/*/scripts/codex-companion.mjs")
    for path in glob.glob(PLUGIN_JOBS):
        try:
            # Only the job's start and phase changes rewrite the file: a long one can go hours
            # untouched, so the week is just to skip the old ones cheaply.
            if os.path.getmtime(path) < time.time() - 7 * 86400:
                continue
            j = json.load(open(path))
        except (OSError, ValueError):
            continue
        if j.get("status") not in ("queued", "running") or not j.get("sessionId") or not alive(j.get("pid")):
            continue
        rv = {"pid": j["pid"], "secs": iso_secs(j.get("startedAt") or j.get("createdAt")), "tool": "Codex",
              "kind": KINDS.get(j.get("kind"), j.get("kind") or "review"), "phase": j.get("phase"), "log": j.get("logFile")}
        if node and script and j.get("workspaceRoot"):
            data = path.split("/state/")[0]
            rv["stop"] = ["env", f"CLAUDE_PLUGIN_DATA={data}", node, script, "cancel", j["id"], "--cwd", j["workspaceRoot"]]
        out.setdefault(j["sessionId"], []).append(rv)
    # Several at once (a review and an adversarial in parallel): the oldest leads, the
    # rest go in "others".
    for sid, jobs in out.items():
        jobs.sort(key=lambda r: -r["secs"])
        out[sid] = {**jobs[0], "others": [{k: r[k] for k in ("kind", "secs", "stop", "pid", "phase", "log") if k in r} for r in jobs[1:]]} if len(jobs) > 1 else jobs[0]
    return out


# Claude's own sub-agents (Agent tool), running right now: each one leaves
# <session>/subagents/agent-<id>.jsonl and a .meta.json with what it was asked and, in recent
# versions, "finished". Teammates (agent teams) are left out: teams.py shows those.
def subagents(sid):
    out = []
    for meta_path in glob.glob(f"{HOME}/.claude/projects/*/{sid}/subagents/*.meta.json"):
        try:
            meta = json.load(open(meta_path))
            path = meta_path[: -len(".meta.json")] + ".jsonl"
            fst = os.stat(path)
        except (OSError, ValueError):
            continue
        if meta.get("finished") or meta.get("taskKind") == "in_process_teammate":
            continue
        if fst.st_mtime < time.time() - 1800:  # no sign of life in 30 min: Claude died with it
            continue
        st = cached(path, claude_transcript)
        if meta.get("finished") is None and st.get("done"):
            continue
        born = getattr(fst, "st_birthtime", fst.st_ctime)
        out.append({"id": os.path.basename(path)[6:-6], "name": meta.get("description") or meta.get("agentType") or "sub-agent",
                    "type": meta.get("agentType"), "activity": st.get("activity"), "secs": int(time.time() - born),
                    "bg": meta.get("requestShape") == "background", "path": path})
    return sorted(out, key=lambda s: -s["secs"])


def etime_secs(etime):
    d, _, rest = etime.strip().rpartition("-")
    parts = [int(x) for x in rest.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return (int(d) if d else 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def child_reviews():
    """agent pid -> the oldest review process under it."""
    procs, kids = {}, {}
    for line in sh("ps", "-A", "-o", "pid=,ppid=,etime=,command=").splitlines():
        f = line.split(None, 3)
        if len(f) != 4 or not f[0].isdigit() or not f[1].isdigit():
            continue  # an odd ps line (a command spanning lines) must not take the list down
        procs[int(f[0])] = (int(f[1]), f[2], f[3])
        kids.setdefault(int(f[1]), []).append(int(f[0]))

    def find(root):
        stack, out = list(kids.get(root, [])), []
        while stack:
            p = stack.pop()
            cmd = procs[p][2]
            m = re.search(r"codex-companion\.mjs\S*\s+(review|adversarial-review|task)\b", cmd)
            if m or re.search(r"(^|/)codex(\s+\S+)*\s+exec\b", cmd) or re.search(r"(^|/)claude\s+-p\b", cmd):
                tool = "Claude" if re.search(r"(^|/)claude\s", cmd) else "Codex"
                try:
                    secs = etime_secs(procs[p][1])
                except ValueError:
                    secs = 0
                out.append({"pid": p, "secs": secs, "tool": tool, "kind": KINDS[m.group(1)] if m else "review"})
                continue
            stack.extend(kids.get(p, []))
        return max(out, key=lambda r: r["secs"]) if out else None
    return find


# What both transcript readers extract, for the agent and its extensions:
# activity, done (finished its turn), text (the last thing it said, trimmed),
# commands (the /commands and $skills you asked for), skills (the ones it launched) and
# invoked (both together, in the order they happened).

def claude_state(pid):
    try:
        sess = json.load(open(f"{HOME}/.claude/sessions/{pid}.json"))
    except (OSError, ValueError):
        return {}
    sid = sess.get("sessionId")
    files = glob.glob(f"{HOME}/.claude/projects/*/{sid}.jsonl")
    if not files:
        return {}  # session with no conversation yet: nothing to resume
    st = cached(files[0], claude_transcript)
    st["session"] = sid
    # The session name (/rename or -n) and where it came from ("derived": Claude made it up).
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
        st["activity"] = "finished"
    elif last_kind in ("tool_result", "user"):
        st["activity"] = "thinking"
    st["text"] = last_text[-TEXT_MAX:]
    st["commands"], st["skills"], st["invoked"] = st["commands"][-20:], st["skills"][-20:], st["invoked"][-20:]
    return st


# Codex doesn't keep its rollout open: take the newest one from the last few days with that cwd.
# For each rollout, cache its cwd and session (the first line never changes).
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
            st["activity"] = "cross-review (Claude)" if re.search(r"claude -p", cmd) else short(f"$ {cmd}" if cmd else p.get("name", ""), 60)
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
        st["activity"] = "finished"
    st["text"] = last_text[-TEXT_MAX:]
    st["commands"], st["skills"], st["invoked"] = st["commands"][-20:], st["skills"][-20:], st["invoked"][-20:]
    return st


# Extensions: any other .py next to this one with start(ctx) -> enrich(st, info).
CORE = {"agentes", "teams", "prs", "usage", "limits", "limpiar", "ver"}


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
        except Exception:  # noqa: BLE001 - a broken extension does not take the list down
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
    # Neither may take the agent list down: without them there are just no reviews.
    try:
        jobs = plugin_jobs()
    except Exception:  # noqa: BLE001
        jobs = {}
    try:
        under = child_reviews()
    except Exception:  # noqa: BLE001
        under = lambda _pid: None
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
            rv = jobs.get(st.get("session")) or under(pid)
            if rv:
                st["review"] = rv
            if t["agent"] == "claude-code" and st.get("session"):
                subs = subagents(st["session"])
                if subs:
                    st["subagents"] = subs
            for enrich in exts:
                try:
                    enrich(st, info)
                except Exception:  # noqa: BLE001
                    pass
            for k in ("done", "text", "commands", "skills", "invoked"):
                st.pop(k, None)
            st.update(info)
            out[addr] = st
        except Exception:  # noqa: BLE001 - one odd agent does not hide the others
            continue
    # Drop what is gone: terminals that left, files that were not read.
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
