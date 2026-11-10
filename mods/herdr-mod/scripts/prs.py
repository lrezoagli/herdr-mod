#!/usr/bin/env python3
"""Mis PRs abiertos y los que me pidieron revisar, en todos los repos, con una
sola consulta a GitHub (gh api graphql). Para el panel GitHub, ⌘J y la barra.

Mis PRs: si "te toca" (needs) y por qué:
- changes: me pidieron cambios (reviewDecision).
- threads: hilos sin resolver cuyo último comentario es de otra persona (humana).
  Si el último es mío, le toca al otro: no cuenta. Se apaga solo al responder.
- comments: comentarios generales de personas después de lo último mío (comentario,
  review o commit).
- ci: falló un check. conflict: tiene conflictos.
- bots: lo mismo de bots (CodeRabbit, Copilot...), aparte: no cuenta para "te toca".

Reviews: los PRs con review pedida a mí (o a un equipo mío), desde cuándo, y si
me la volvieron a pedir después de una review mía (status "asked"). Y todos los
abiertos que ya revisé sin que me la vuelvan a pedir: "answered" si después de mi
review hubo commits nuevos (si no lo había aprobado), comentarios o respuestas en mis
hilos de otra persona; "reviewed" si no. my_state: lo último que dejé (COMMENTED,
APPROVED, CHANGES_REQUESTED). Solo asked y answered piden algo (avisos, contadores).

clones: los repos clonados en las carpetas que recibe (config projects; ~/Projects si no), hasta 3 niveles, {"dueño/repo": carpeta},
para abrir el agente aunque el repo no esté abierto como proyecto en Herdr.

Imprime {"me", "mine": [...], "reviews": [...], "clones": {...}} o {"error": "..."}.
"""
import configparser
import json
import os
import re
import subprocess
import sys

QUERY = """
query {
  viewer { login }
  mine: search(query: "is:open is:pr archived:false author:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number state title url isDraft createdAt updatedAt headRefName
      reviewDecision mergeable additions deletions
      repository { nameWithOwner }
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
      reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
      latestReviews(first: 20) { nodes { author { __typename login } state submittedAt } }
      reviewThreads(first: 100) { nodes { isResolved isOutdated
        comments(last: 1) { nodes { author { __typename login } createdAt url } } } }
      comments(last: 30) { nodes { author { __typename login } createdAt url } }
    } }
  }
  reviews: search(query: "is:open is:pr archived:false review-requested:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number state title url isDraft createdAt updatedAt headRefName baseRefName additions deletions
      repository { nameWithOwner } author { login }
      latestReviews(first: 20) { nodes { author { login } state submittedAt } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent {
        createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } } } }
    } }
  }
  followup: search(query: "is:open is:pr archived:false reviewed-by:@me -author:@me -review-requested:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number state title url isDraft headRefName baseRefName additions deletions
      repository { nameWithOwner } author { login }
      commits(last: 1) { nodes { commit { committedDate } } }
      latestReviews(first: 20) { nodes { author { login } state submittedAt } }
      reviewThreads(first: 100) { nodes { isResolved
        comments(last: 1) { nodes { author { __typename login } createdAt url } } } }
      comments(last: 20) { nodes { author { __typename login } createdAt url } }
    } }
  }
}
"""

BOTS = ("coderabbit", "copilot", "github-actions", "dependabot", "renovate", "sonarcloud", "codecov", "vercel", "netlify", "sourcery", "gemini-code-assist")


def is_bot(author):
    if not author:
        return True  # cuenta borrada ("ghost")
    login = (author.get("login") or "").lower()
    return author.get("__typename") == "Bot" or login.endswith("[bot]") or any(b in login for b in BOTS)


def clones(roots):
    out = {}
    for root in roots:
        out.update({k: v for k, v in clones_in(os.path.expanduser(root).rstrip("/")).items() if k not in out})
    return out


def clones_in(root):
    out = {}
    for dirpath, dirnames, _ in os.walk(root):
        depth = dirpath[len(root):].count(os.sep)
        if ".git" in dirnames and os.path.isdir(os.path.join(dirpath, ".git")):
            cfg = configparser.ConfigParser(strict=False)
            try:
                cfg.read(os.path.join(dirpath, ".git", "config"))
                url = cfg.get('remote "origin"', "url", fallback="")
            except configparser.Error:
                url = ""
            m = re.search(r"github\.com[:/](.+?)(?:\.git)?/?$", url)
            if m:
                out.setdefault(m.group(1), dirpath)
            dirnames[:] = []  # no busca repos adentro de otro
            continue
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"] if depth < 2 else []
    return out


def main():
    r = subprocess.run(["gh", "api", "graphql", "-f", f"query={QUERY}"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(json.dumps({"error": (r.stderr or r.stdout).strip()[:300]}))
        return
    d = json.loads(r.stdout).get("data") or {}
    me = (d.get("viewer") or {}).get("login", "")

    mine = []
    for pr in (d.get("mine") or {}).get("nodes") or []:
        if not pr or pr.get("state") != "OPEN":  # el buscador tarda en enterarse de un merge
            continue
        commit = ((pr.get("commits") or {}).get("nodes") or [{}])[-1].get("commit") or {}
        reviews = (pr.get("latestReviews") or {}).get("nodes") or []
        comments = (pr.get("comments") or {}).get("nodes") or []
        # Lo último que hice yo: commit, comentario o review.
        mine_at = max([commit.get("committedDate") or "", pr.get("createdAt") or ""]
                      + [c["createdAt"] for c in comments if (c.get("author") or {}).get("login") == me]
                      + [x["submittedAt"] or "" for x in reviews if (x.get("author") or {}).get("login") == me])
        threads = bot_threads = 0
        last_url = None
        for th in (pr.get("reviewThreads") or {}).get("nodes") or []:
            if th.get("isResolved"):
                continue
            last = ((th.get("comments") or {}).get("nodes") or [{}])[-1]
            who = last.get("author")
            if (who or {}).get("login") == me:
                continue
            if is_bot(who):
                bot_threads += 1
            else:
                threads += 1
                last_url = last.get("url") or last_url
        new_comments = bot_comments = 0
        for c in comments:
            who = c.get("author")
            if (who or {}).get("login") == me or c["createdAt"] <= mine_at:
                continue
            if is_bot(who):
                bot_comments += 1
            else:
                new_comments += 1
                last_url = c.get("url") or last_url
        # Reviews de personas con comentario nuevo después de lo mío (sin hilo).
        human_reviews = [x for x in reviews if not is_bot(x.get("author")) and (x.get("author") or {}).get("login") != me]
        waiting = [n.get("requestedReviewer") or {} for n in (pr.get("reviewRequests") or {}).get("nodes") or []]
        ci = (commit.get("statusCheckRollup") or {}).get("state")
        changes = pr.get("reviewDecision") == "CHANGES_REQUESTED"
        conflict = pr.get("mergeable") == "CONFLICTING"
        item = {
            "repo": pr["repository"]["nameWithOwner"],
            "number": pr["number"], "title": pr["title"], "url": last_url or pr["url"], "pr_url": pr["url"],
            "branch": pr.get("headRefName"), "draft": pr.get("isDraft", False),
            "updated": pr.get("updatedAt"), "plus": pr.get("additions", 0), "minus": pr.get("deletions", 0),
            "decision": pr.get("reviewDecision"),  # APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | None
            "changes": changes, "threads": threads, "comments": new_comments,
            "bots": bot_threads + bot_comments,
            "ci": "fail" if ci in ("FAILURE", "ERROR") else "pending" if ci in ("PENDING", "EXPECTED") else "ok" if ci == "SUCCESS" else None,
            "conflict": conflict,
            "reviewers": [x.get("login") or x.get("slug") for x in waiting if x],
            "reviewed_by": sorted({(x.get("author") or {}).get("login") for x in human_reviews} - {None}),
            "mine_at": mine_at,
        }
        # Lo que pide que hagas algo con los comentarios (para avisos) y lo que te toca en general.
        item["talk"] = changes or threads > 0 or new_comments > 0
        item["needs"] = item["talk"] or item["ci"] == "fail" or conflict
        mine.append(item)

    out_reviews = []
    for pr in (d.get("reviews") or {}).get("nodes") or []:
        if not pr or pr.get("state") != "OPEN":  # el buscador tarda en enterarse de un merge
            continue
        events = (pr.get("timelineItems") or {}).get("nodes") or []
        asked = [e["createdAt"] for e in events if ((e.get("requestedReviewer") or {}).get("login") in (me, None))]
        asked_at = max(asked) if asked else (max(e["createdAt"] for e in events) if events else pr.get("createdAt"))
        my_reviews = [x["submittedAt"] for x in (pr.get("latestReviews") or {}).get("nodes") or [] if (x.get("author") or {}).get("login") == me and x.get("submittedAt")]
        out_reviews.append({
            "repo": pr["repository"]["nameWithOwner"],
            "number": pr["number"], "title": pr["title"], "url": pr["url"],
            "branch": pr.get("headRefName"), "base": pr.get("baseRefName"), "draft": pr.get("isDraft", False),
            "author": (pr.get("author") or {}).get("login"),
            "plus": pr.get("additions", 0), "minus": pr.get("deletions", 0),
            "asked_at": asked_at, "again": bool(my_reviews and max(my_reviews) < (asked_at or "")), "status": "asked",
            "my_state": max(((x["submittedAt"], x["state"]) for x in (pr.get("latestReviews") or {}).get("nodes") or [] if (x.get("author") or {}).get("login") == me and x.get("submittedAt")), default=(None, None))[1],
        })
    for pr in (d.get("followup") or {}).get("nodes") or []:
        if not pr or pr.get("state") != "OPEN":  # el buscador tarda en enterarse de un merge
            continue
        mine_rv = [x for x in (pr.get("latestReviews") or {}).get("nodes") or [] if (x.get("author") or {}).get("login") == me and x.get("submittedAt")]
        if not mine_rv:
            continue
        last_rv = max(mine_rv, key=lambda x: x["submittedAt"])
        at = last_rv["submittedAt"]
        commit_at = (((pr.get("commits") or {}).get("nodes") or [{}])[-1].get("commit") or {}).get("committedDate") or ""
        new_commits = last_rv.get("state") != "APPROVED" and commit_at > at
        comments = [c for c in (pr.get("comments") or {}).get("nodes") or []
                    if c["createdAt"] > at and (c.get("author") or {}).get("login") != me and not is_bot(c.get("author"))]
        replies = []
        for th in (pr.get("reviewThreads") or {}).get("nodes") or []:
            last = ((th.get("comments") or {}).get("nodes") or [{}])[-1]
            if not th.get("isResolved") and last.get("createdAt", "") > at and (last.get("author") or {}).get("login") != me and not is_bot(last.get("author")):
                replies.append(last)
        why = []
        if replies:
            why.append(f"{len(replies)} respuesta{'s' if len(replies) > 1 else ''} en tus hilos")
        if comments:
            why.append(f"{len(comments)} comentario{'s' if len(comments) > 1 else ''}")
        if new_commits:
            why.append("commits nuevos")
        latest = max(comments + replies, key=lambda c: c["createdAt"], default=None)
        out_reviews.append({
            "repo": pr["repository"]["nameWithOwner"],
            "number": pr["number"], "title": pr["title"], "url": (latest or {}).get("url") or pr["url"],
            "branch": pr.get("headRefName"), "base": pr.get("baseRefName"), "draft": pr.get("isDraft", False),
            "author": (pr.get("author") or {}).get("login"),
            "plus": pr.get("additions", 0), "minus": pr.get("deletions", 0),
            "asked_at": max([commit_at if new_commits else ""] + [c["createdAt"] for c in comments + replies]) or at,
            "again": False, "status": "answered" if why else "reviewed", "why": ", ".join(why),
            "reviewed_at": at, "my_state": last_rv.get("state"),
        })
    print(json.dumps({"me": me, "mine": mine, "reviews": out_reviews, "clones": clones(sys.argv[1:] or ["~/Projects"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
