#!/usr/bin/env python3
"""Worktrees huérfanos: los que ningún agente ni terminal usa.

  limpiar.py list <carpeta>...           JSON con cada worktree de esas carpetas (<carpeta>/<repo>/<nombre>)
  limpiar.py remove <worktree>...         borra los que sigan siendo seguros (git worktree remove, sin --force)

En uso: una terminal de herdr-core parada ahí (vivas y terminadas) o un agente dormido del mod
(su sesión de Claude o Codex dice en qué carpeta estaba).
Seguro: sin uso, sin cambios y sin commits que falten en el remoto o en la rama principal.
Las ramas no se tocan: el worktree se puede volver a abrir.
"""
import glob, json, os, subprocess as sp, sys

H = os.path.expanduser
ENV = {k: v for k, v in os.environ.items() if k not in ("HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET")}


def run(*a, cwd=None):
    try:
        r = sp.run(a, cwd=cwd, capture_output=True, text=True, env=ENV, timeout=60)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def first_cwd(path, pick):
    try:
        with open(path) as f:
            for line in f:
                try:
                    cwd = pick(json.loads(line))
                except Exception:
                    continue
                if cwd:
                    return cwd
    except OSError:
        pass


def users():
    """carpeta real -> quién la usa"""
    used = {}
    add = lambda cwd, who: cwd and used.setdefault(os.path.realpath(cwd), []).append(who)
    c, out, _ = run("hc", "ls", "--all", "--json")
    if c != 0:
        sys.exit("no pude listar las terminales de herdr-core (hc ls): no borro nada")
    for t in json.loads(out).get("terminals", []):
        add(t.get("cwd"), t.get("where") or t.get("address"))
    # Dormidos: en todas las copias del store (también restos viejos).
    for f in glob.glob(H("~/.config/herdr-app/data/herdr-mod/store*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for k, v in d.items():
            if not k.endswith("sleeping"):
                continue
            recs = json.loads(v) if isinstance(v, str) else v
            for r in (recs or {}).values():
                sid, who = r.get("session"), f"dormido: {r.get('title') or r.get('addr')}"
                if not sid:
                    continue
                cwd = None
                for p in glob.glob(H(f"~/.claude/projects/*/{sid}.jsonl")):
                    cwd = first_cwd(p, lambda j: j.get("cwd"))
                if not cwd:
                    for p in glob.glob(H(f"~/.codex/sessions/**/*{sid}*.jsonl"), recursive=True):
                        cwd = first_cwd(p, lambda j: (j.get("payload") or {}).get("cwd"))
                if cwd:
                    add(cwd, who)
                else:
                    # Sin saber dónde estaba: mejor no borrar nada que se le parezca.
                    used.setdefault("?", []).append(who)
    return used


def default_branch(p):
    c, out, _ = run("git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD", cwd=p)
    refs = [out] if c == 0 and out else []
    for b in ("main", "master", "origin/main", "origin/master"):
        if run("git", "rev-parse", "-q", "--verify", b, cwd=p)[0] == 0:
            refs.append(b)
    return refs


def check(p, used):
    name = os.path.basename(p)
    repo = os.path.basename(os.path.dirname(p))
    row = {"path": p, "repo": repo, "name": name, "branch": "", "state": "safe", "why": ""}
    by = [w for k, ws in used.items() if k == p or k.startswith(p + "/") for w in ws]
    if by:
        return {**row, "state": "inuse", "why": ", ".join(dict.fromkeys(by))}
    if run("git", "rev-parse", "--is-inside-work-tree", cwd=p)[0] != 0:
        return {**row, "state": "broken", "why": "git no la reconoce (el repo de origen ya no está)"}
    c, top, _ = run("git", "rev-parse", "--show-toplevel", cwd=p)
    if os.path.realpath(top) != p:
        return {**row, "state": "review", "why": "no es la raíz de un worktree"}
    c, gd, _ = run("git", "rev-parse", "--git-dir", cwd=p)
    if "/worktrees/" not in gd:
        return {**row, "state": "review", "why": "es un checkout principal, no un worktree"}
    row["branch"] = run("git", "branch", "--show-current", cwd=p)[1] or "(sin rama)"
    why = []
    _, dirty, _ = run("git", "status", "--porcelain", cwd=p)
    if dirty:
        why.append(f"{len(dirty.splitlines())} cambios sin commitear")
    if run("git", "rev-parse", "-q", "--verify", "HEAD", cwd=p)[0] == 0:
        _, a, _ = run("git", "rev-list", "--count", "HEAD", "--not", "--remotes", cwd=p)
        refs = default_branch(p)
        _, b, _ = run("git", "rev-list", "--count", "HEAD", "--not", *refs, cwd=p) if refs else (0, a, "")
        if a not in ("", "0") and b not in ("", "0"):
            why.append(f"{min(int(a), int(b))} commits que no están en el remoto ni en main")
    if why:
        return {**row, "state": "review", "why": ", ".join(why)}
    return row


def listing(roots):
    used = users()
    rows = []
    for root in roots:
        root = os.path.realpath(H(root))
        for p in sorted(glob.glob(os.path.join(root, "*", "*"))):
            if os.path.isdir(p) and not os.path.islink(p):
                rows.append(check(os.path.realpath(p), used))
    return rows, used


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("list", "remove"):
        sys.exit(__doc__)
    if sys.argv[1] == "list":
        rows, used = listing(sys.argv[2:])
        print(json.dumps({"rows": rows, "unknown": used.get("?", [])}, ensure_ascii=False))
        return
    used = users()
    out = []
    for p in sys.argv[2:]:
        p = os.path.realpath(p)
        r = check(p, used)
        if r["state"] != "safe":
            out.append({"path": p, "ok": False, "why": r["why"] or r["state"]})
            continue
        c, _, err = run("git", "worktree", "remove", p, cwd=p)
        out.append({"path": p, "ok": c == 0, "why": err if c else ""})
    print(json.dumps(out, ensure_ascii=False))


main()
