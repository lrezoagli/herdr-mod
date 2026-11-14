// GitHub panel (next to Files and Changes): the project's open issues
// (the active space's repo; from a worktree, its main checkout's).
// All / Mine (assigned to me) filter, persisted. Click opens the issue in the
// browser; the Claude and Codex buttons open the agent in the <prefix>IS-<n> worktree (folder
// ~/.herdr/worktrees/<repo>/IS-<n>) as a project tab. Uses `gh` with the logged-in account; refreshes on project change,
// every 2 minutes and with the ↻ button.
// My PRs and Reviews: across all my repos (not just the project's). The agents role
// fetches them with prs.py every 2 min into shared("herdr-mod.prs"). What needs
// you goes on top. /pr-fix and /pr-review open Claude in that PR's worktree (or
// message the agent already there); the repo must be open as a project in Herdr.
// Epic: marks the issue as a big request (branch <prefix>IS-<n> from the main
// checkout's HEAD, no agent, with branch.<branch>.herdrPedido = true). It shows
// in the agent tree and you hang branches off it with each branch's +.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, exec, theme, run, notify, home, shared, setShared } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("github");

// /pr-review and /pr-fix are skills (if you have them). Without them (shared "herdr-mod.skills",
// checked by the agents role), the agent gets a plain request that does the same by hand.
const hasSkill = (s) => Boolean(shared("herdr-mod.skills")?.[s]);
const prAsk = (kind, n, repo) => kind === "fix"
  ? (hasSkill("pr-fix") ? `/pr-fix ${n}` : `Address the review comments on PR #${n}${repo ? ` in ${repo}` : ""}: read them with gh, check each one against the code, propose the change and the reply, and wait for my ok before committing, pushing or replying on GitHub.`)
  : (hasSkill("pr-review") ? `/pr-review ${n}` : `Review PR #${n}${repo ? ` in ${repo}` : ""}: summary, issues (file:line, severity, how to fix) and the comments you would leave. Don't publish anything on GitHub without my ok.`);
const prLabel = (kind) => kind === "fix" ? (hasSkill("pr-fix") ? "/pr-fix" : "fix") : (hasSkill("pr-review") ? "/pr-review" : "review");

const REFRESH_MS = 120000;
const FIELDS = "number,title,labels,assignees,updatedAt,url";
const AGENTS = [
  { id: "claude", label: "Claude", argv: ["claude"], app: "claude-code", icon: "icons/claude.svg", color: "ansi3" },
  { id: "codex", label: "Codex", argv: ["codex"], app: "codex", icon: "icons/codex.svg", color: "ansi4" },
];

const ago = (iso) => {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : m < 86400 ? `${Math.floor(m / 1440)}d` : `${Math.floor(m / 43200)}mo`;
};

// Where the active project is now: the focused pane if it belongs to this space,
// else its first terminal, else the folder it was created with.
function placeOf(space) {
  return placesOf(space)[0] ?? null;
}

// The space's candidate folders: the focused terminal, the others, the project's.
function placesOf(space) {
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const mine = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  const f = mine.find((p) => p.focused);
  return [...new Set([f?.cwd, ...mine.map((p) => p.cwd), space?.folder].filter(Boolean))];
}

export default class GitHub extends View {
  init(_props, cx) {
    this.goAt = shared("herdr-mod.github.section")?.at ?? 0;
    this.filter = localStorage.getItem("filter") ?? "mine"; // "mine" | "all"
    this.section = localStorage.getItem("section") ?? "issues"; // "issues" | "prs" | "reviews"
    this.lastPrs = "";
    let tick = 0;
    cx.timer.every(1000, (cx) => {
      // New data, the ↻ starting or stopping, and every 30 s the "Xm ago".
      const now = `${shared("herdr-mod.prs.at") ?? 0}:${Boolean(shared("herdr-mod.prs.loading"))}`;
      if (now !== this.lastPrs || ++tick % 30 === 0) { this.lastPrs = now; cx.notify(); }
      // Switched project (or folder): the panel follows that repo. render alone isn't enough,
      // it doesn't always run on a space change.
      const space = spaces().find((x) => x.active);
      if (space?.id !== this.spaceId || placeOf(space) !== this.folder) { this.load(cx, true); cx.notify(); }
      // ⌘J asks to show a section ("prs" | "reviews").
      const go = shared("herdr-mod.github.section");
      if (go && go.at > (this.goAt ?? 0)) { this.goAt = go.at; this.setSection(go.id, cx); }
    });
    this.cache = new Map(); // `${repo}\0${filter}` -> { issues, at, error }
    this.repo = null; // { main, slug }
    this.loading = false;
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx, true));
    this.load(cx);
  }

  key() { return this.repo ? `${this.repo.main}\0${this.filter}` : null; }

  load(cx, force = false) {
    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    const folder = placeOf(space);
    this.spaceId = space?.id; this.folder = folder;
    cx.spawn(async (cx) => {
      if (!folder) { this.repo = null; this.error = "This project has no folder."; return cx.notify(); }
      // The first folder that exists and is a repo: a terminal may be left in a deleted
      // worktree (exec fails there) or outside the repo.
      let common = null;
      for (const cwd of placesOf(space)) {
        try {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
          if (r.code === 0) { common = r; break; }
        } catch {}
      }
      if (!common) { this.repo = null; this.error = "This project is not a git repo."; return cx.notify(); }
      const main = common.stdout.trim().replace(/\/\.git$/, "");
      if (this.repo?.main !== main) {
        const view = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: main, on });
        this.repo = { main, slug: view.code === 0 ? view.stdout.trim() : null };
      }
      this.error = this.repo.slug ? null : "The repo has no GitHub remote (or gh can't find it).";
      if (this.error) return cx.notify();
      const k = this.key(), hit = this.cache.get(k);
      if (hit && !force && Date.now() - hit.at < REFRESH_MS) return cx.notify();
      this.loading = true; cx.notify();
      const ped = await exec("git", ["config", "--get-regexp", "^branch\\..*\\.herdrpedido$"], { cwd: main, on });
      this.pedidos = new Set((ped.stdout ?? "").split("\n").filter((l) => l.endsWith(" true")).map((l) => (l.match(/IS-(\d+)\.herdrpedido/i) ?? [])[1]).filter(Boolean).map(Number));
      const args = ["issue", "list", "--state", "open", "--limit", "200", "--json", FIELDS];
      if (this.filter === "mine") args.push("--assignee", "@me");
      const r = await exec("gh", args, { cwd: main, on });
      let entry;
      try { entry = r.code === 0 ? { issues: JSON.parse(r.stdout), at: Date.now() } : { issues: [], at: Date.now(), error: (r.stderr || r.stdout).trim() }; }
      catch (e) { entry = { issues: [], at: Date.now(), error: String(e) }; }
      this.cache.set(k, entry);
      this.loading = false;
      cx.notify();
    });
  }

  setFilter(f, cx) {
    if (f === this.filter) return;
    this.filter = f; localStorage.setItem("filter", f);
    this.load(cx);
  }

  // Claude or Codex in the issue's worktree. If there's already a tab of that agent
  // on that branch, focus it;
  // if the worktree exists, open another tab in it; otherwise create it from the
  // main checkout's HEAD (or from the branch, if it already exists).
  async agentFor(issue, agent) {
    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    const branch = `${cfg().branchPrefix}IS-${issue.number}`;
    const fail = (body) => notify({ title: `Couldn't open ${agent.label} for ${branch}`, body, level: "error" });
    try {
      const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
      const there = panes().find((p) => tabs.has(p.tab) && p.branch === branch && p.app === agent.app);
      if (there) return run("pane.focus", { pane: there.pane });
      const git = async (args) => {
        const r = await exec("git", args, { cwd: this.repo.main, on });
        return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
      };
      const list = await git(["worktree", "list", "--porcelain"]);
      const block = list.out.split(/\n\n+/).find((b) => b.split("\n").includes(`branch refs/heads/${branch}`));
      let path = block?.split("\n").find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path) {
        let userHome = home();
        if (on) userHome = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on })).stdout.trim();
        path = `${userHome}/.herdr/worktrees/${this.repo.main.split("/").pop()}/IS-${issue.number}`;
        const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
        const add = await git(exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
        if (!add.ok) return fail(add.err || "git worktree add failed.");
      }
      // Named IS-<n> (the tab and, in Claude, the session).
      const name = `IS-${issue.number}`;
      run("tab.new", { space: space.id, name, folder: path, argv: agent.argv[0] === "claude" ? [...agent.argv, "-n", name] : agent.argv });
    } catch (e) { fail(String(e)); }
  }

  // The issue becomes an epic: its branch (created if missing) marked in git.
  async makePedido(issue, cx) {
    const on = spaces().find((s) => s.active)?.machine ?? null;
    const branch = `${cfg().branchPrefix}IS-${issue.number}`;
    const git = async (args) => {
      const r = await exec("git", args, { cwd: this.repo.main, on });
      return { ok: r.code === 0, err: (r.stderr || r.stdout || "").trim() };
    };
    try {
      if (!(await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) {
        const b = await git(["branch", branch, "HEAD"]);
        if (!b.ok) return notify({ title: `Couldn't create ${branch}`, body: b.err, level: "error" });
      }
      await git(["config", `branch.${branch}.herdrPedido`, "true"]);
      (this.pedidos ??= new Set()).add(issue.number);
      setShared("herdr-mod.chains.at", Date.now());
      notify({ title: `IS-${issue.number} is an epic`, body: "It's in the agent tree. Hover the branch and use + to hang another one off it with its agent.", level: "info", timeout: 8000 });
      cx.notify();
    } catch (e) { notify({ title: `Couldn't mark IS-${issue.number} as an epic`, body: String(e), level: "error" }); }
  }

  setSection(id, cx) {
    this.section = id; localStorage.setItem("section", id);
    cx.notify();
  }

  // /pr-fix (my PR, on its branch) or /pr-review (someone else's: worktree rv-PR-<n>, branch rv/PR-<n>
  // with the PR's latest, without its agent config): if an agent is already there, message
  // it; otherwise open Claude (or Codex, for review) in that worktree, as a tab of the
  // repo's project, with the command. Review starts in skip mode (cc / cx).
  // The worktree comes from the repo's checkout (open in Herdr or cloned in ~/Projects).
  async agentForPr(pr, cmd, who = "claude") {
    const fail = (body) => notify({ title: `Couldn't open ${cmd} for ${pr.repo.split("/")[1]} #${pr.number}`, body, level: "error" });
    try {
      const local = shared("herdr-mod.prs")?.repos?.[pr.repo];
      if (!local) return fail("Can't find that repo: not open in Herdr nor cloned in ~/Projects.");
      const { main, on, space } = local;
      const git = async (args, cwd = main) => {
        const r = await exec("git", args, { cwd, on });
        return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
      };
      // Fetch via origin (SSH); if that fails (e.g. the SSH agent doesn't respond),
      // retry over HTTPS with gh's credentials.
      const fetch = async (src, dst) => {
        const a = await git(["fetch", "origin", dst ? `+${src}:${dst}` : src]);
        if (a.ok) return a;
        const b = await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
          "fetch", `https://github.com/${pr.repo}.git`, dst ? `+${src}:${dst}` : src]);
        return b.ok ? b : { ...b, err: `${a.err}\n${b.err}` };
      };
      const own = cmd === "/pr-fix";
      const list = (await git(["worktree", "list", "--porcelain"])).out.split(/\n\n+/).map((b) => ({
        path: b.split("\n").find((l) => l.startsWith("worktree "))?.slice(9),
        branch: b.split("\n").find((l) => l.startsWith("branch "))?.slice(18),
      }));
      let userHome = home();
      if (on) userHome = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on })).stdout.trim();
      const base = `${userHome}/.herdr/worktrees/${main.split("/").pop()}`;
      // Review: branch rv/PR-<n> (older ones were named rv-PR-<n>: if one exists, use it).
      const names = own ? [pr.branch] : [`rv/PR-${pr.number}`, `rv-PR-${pr.number}`];
      const old = list.find((w) => names.includes(w.branch));
      const branch = old?.branch ?? names[0];
      let path = old?.path;
      // An agent already on that branch: message it.
      // Only in this repo's checkouts: another repo can have a PR with the same number.
      const roots = list.map((w) => w.path).filter(Boolean);
      const there = panes().find((p) => p.program?.agent && p.terminal && names.includes(p.branch)
        && p.cwd && roots.some((r) => p.cwd === r || p.cwd.startsWith(`${r}/`)));
      if (there) {
        await exec("hc", ["send", there.terminal, prAsk(own ? "fix" : "review", pr.number, pr.repo)]);
        return run("pane.focus", { pane: there.pane });
      }
      if (own && !path) {
        path = `${base}/${pr.branch.replace(prefixRe(), "").replace(/\//g, "-")}`;
        await fetch(`refs/heads/${pr.branch}`, `refs/remotes/origin/${pr.branch}`);
        const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${pr.branch}`])).ok;
        const add = await git(exists ? ["worktree", "add", path, pr.branch] : ["worktree", "add", "--track", "-b", pr.branch, path, `origin/${pr.branch}`]);
        if (!add.ok) return fail(add.err || "git worktree add failed.");
      } else if (!own) {
        // Someone else's PR: untrusted code. The worktree is checked out without the agent
        // config the PR brings (.claude/ with hooks and skills, .mcp.json, .codex/,
        // .agents/, in any folder; sparse-checkout) and Claude starts without the
        // project config and asking for permission (below). No reset --hard: if the
        // PR was rewritten, delete it by hand.
        const f = await fetch(`pull/${pr.number}/head`);
        if (!f.ok) return fail(f.err || "git fetch of the PR failed.");
        const head = (await git(["rev-parse", "FETCH_HEAD"])).out; // FETCH_HEAD is per worktree: take the sha
        const fresh = !path;
        if (fresh) {
          path = `${base}/rv-PR-${pr.number}`; // folder without a slash; the branch is rv/PR-<n>
          const add = await git(["worktree", "add", "--no-checkout", "-B", branch, path, head]);
          if (!add.ok) return fail(add.err || "git worktree add failed.");
        }
        // The base CLAUDE.md / AGENTS.md I wrote last time: out, so the
        // sparse-checkout and the merge see a clean worktree.
        const DOC = /(^|\/)(CLAUDE|AGENTS)\.md$/;
        // The PR controls the worktree: one of its folders may be a symlink elsewhere
        // (docs -> ~/.claude). Before writing or deleting a doc: no path segment is
        // a symlink, the real folder is inside the worktree and the file isn't a link.
        const SAFE = 'set -f; wt="$1"; rel="$2"; root=$(cd "$wt" && pwd -P) || exit 3; '
          + 'dir=${rel%/*}; [ "$dir" = "$rel" ] && dir=""; cur="$wt"; IFS=/; for c in $dir; do cur="$cur/$c"; [ -L "$cur" ] && exit 3; done; unset IFS; '
          + 'dest="$wt/$rel"; [ -L "$dest" ] && exit 3; ';
        const inside = 'real=$(cd "$(dirname "$dest")" && pwd -P) || exit 3; case "$real/" in "$root"/*) ;; *) exit 3;; esac; ';
        if (!fresh) {
          // What I wrote last time (marked assume-unchanged: "h" in ls-files -v) goes back
          // to how the PR left it: docs are deleted (they're outside the sparse set) and
          // imported files are restored.
          const marked = (await git(["ls-files", "-v"], path)).out.split("\n").filter((l) => /^[a-z] /.test(l)).map((l) => l.slice(2));
          if (marked.length) {
            await git(["update-index", "--no-assume-unchanged", "--", ...marked], path);
            for (const f of marked.filter((f) => DOC.test(f))) await exec("sh", ["-c", SAFE + '[ -e "$dest" ] || exit 0; ' + inside + 'rm -f -- "$dest"', "sh", path, f], { on });
            const back = marked.filter((f) => !DOC.test(f));
            if (back.length) await git(["checkout", "--", ...back], path);
          }
        }
        // Without a trailing slash it also catches files and symlinks (a .claude pointing elsewhere).
        // Not the PR's CLAUDE.md / AGENTS.md either: the agent would load them as instructions
        // (and it runs in skip mode). The base branch's ones are read with git show (see task).
        const sparse = await git(["sparse-checkout", "set", "--no-cone", "/*", "!.claude/", "!.claude", "!.mcp.json", "!.codex/", "!.codex", "!.agents/", "!.agents",
          "!CLAUDE.md", "!CLAUDE.local.md", "!AGENTS.md", "!AGENTS.override.md"], path);
        if (!sparse.ok) return fail(`Couldn't exclude the PR's agent config: ${sparse.err}`);
        if (fresh) {
          const co = await git(["read-tree", "-mu", "HEAD"], path);
          if (!co.ok) return fail(co.err || "git read-tree failed.");
        } else if (!(await git(["merge", "--ff-only", head], path)).ok) {
          notify({ title: `${branch} is not up to date with the PR`, body: "The PR was rewritten (force push) or the worktree has changes. Opening the existing one; to fetch it again, delete the worktree.", level: "warning", timeout: 12000 });
        }
        // Final check: if any of that is left in the folder (not marked S), don't launch Claude.
        const shown = (await git(["ls-files", "-t"], path)).out.split("\n").filter((l) => l && !l.startsWith("S "))
          .map((l) => l.slice(2)).filter((f) => /(^|\/)(\.claude|\.mcp\.json|\.codex|\.agents|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|AGENTS\.override\.md)(\/|$)/.test(f));
        if (shown.length) return fail(`The PR has agent config I couldn't exclude (${shown.slice(0, 3).join(", ")}). Not launching the agent there.`);
        // The CLAUDE.md / AGENTS.md that do go in: the repo's main branch ones (origin/HEAD,
        // else main or master), never the PR's nor its base's (whoever opens the PR picks
        // the base). git ignores them and the agent loads them as in any repo.
        const head0 = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out.replace(/^origin\//, "");
        let def = head0;
        if (!def) for (const b of ["main", "master"]) if ((await git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`])).ok) { def = b; break; }
        if (def) await fetch(`refs/heads/${def}`, `refs/remotes/origin/${def}`);
        const ref = def ? `origin/${def}` : null;
        const inRef = new Set(ref ? (await git(["ls-tree", "-r", "--name-only", ref])).out.split("\n").filter(Boolean) : []);
        const docs = [...inRef].filter((f) => DOC.test(f));
        // What a doc imports with @path would be looked up in the worktree, i.e. in the PR. Instead
        // of touching those files, the doc is written with the imports inlined (also from the
        // main branch, up to 5 levels, like Claude) and without the @: Claude looks up nothing in
        // the PR and the PR's files stay as they are.
        const norm = (base, rel) => {
          const out = [];
          for (const c of `${base ? `${base}/` : ""}${rel}`.split("/")) {
            if (c === "" || c === ".") continue;
            if (c === "..") { if (!out.length) return null; out.pop(); } else out.push(c);
          }
          return out.join("/");
        };
        // Like Claude: @ at the start or after a space, up to the next space. The @ is stripped
        // from all of them (resolved or not), except ~/ and absolute paths, which aren't the PR's.
        const IMPORT = /(^|\s)@([^\s`'"()<>]+)/g;
        const LEFT = /(^|\s)@(?![~/])\S/;
        const expand = async (f, depth, seen) => {
          let text = (await git(["show", `${ref}:${f}`])).out;
          const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
          const parts = [];
          const targets = [];
          text = text.replace(IMPORT, (m, pre, raw) => {
            if (raw.startsWith("~") || raw.startsWith("/")) return m;
            const rel = raw.replace(/[.,;:!?]+$/, "");
            const target = norm(dir, rel);
            if (target && inRef.has(target) && !seen.has(target) && depth < 5) { seen.add(target); targets.push(target); }
            return `${pre}${raw}`;
          });
          for (const t of targets) parts.push(`\n\n<!-- ${t} (imported, from the main branch) -->\n${await expand(t, depth + 1, seen)}`);
          return text + parts.join("");
        };
        // Written to a fresh temp file (mktemp) and moved over. $3: the content.
        const write = (f, content) => exec("sh", ["-c", SAFE + 'mkdir -p "$(dirname "$dest")" || exit 3; ' + inside
          + 'tmp=$(mktemp "$(dirname "$dest")/.herdr.XXXXXX") || exit 3; printf "%s\\n" "$3" > "$tmp" && mv -f "$tmp" "$dest" || { rm -f "$tmp"; exit 3; }',
          "sh", path, f, content], { on });
        let broken = null;
        for (const f of docs) {
          const content = await expand(f, 0, new Set([f]));
          // Check: no @ left that Claude would look up in the worktree.
          if (LEFT.test(content)) { broken = f; break; }
          const w = await write(f, content);
          if (w.code !== 0) { broken = f; break; }
        }
        // Keep git from showing them as changes (with sparse-checkout, --skip-worktree doesn't
        // stick), so next time they get cleaned up, even if this run failed.
        const tracked = new Set((await git(["ls-files"], path)).out.split("\n"));
        const mark = docs.filter((f) => tracked.has(f));
        if (mark.length) await git(["update-index", "--assume-unchanged", "--", ...mark], path);
        // If it couldn't (a PR symlink in the path, for example), don't launch the agent.
        if (broken) return fail(`Couldn't prepare ${broken} from the main branch in the worktree. Not launching the agent there.`);
      }
      // In its project; if the repo isn't open in Herdr, a new project for it.
      // All in skip mode, like cc / cx. Claude without project settings (they were left
      // out anyway). Codex doesn't have the skill: pass it Claude's SKILL.md to follow.
      const codex = !own && who === "codex";
      const argv = own ? ["claude", "--dangerously-skip-permissions"]
        : codex ? ["codex", "--dangerously-bypass-approvals-and-sandbox"]
        : ["claude", "--setting-sources", "user", "--dangerously-skip-permissions"];
      const task = own ? prAsk("fix", pr.number, pr.repo)
        : codex && hasSkill("pr-review") ? `Follow the pr-review skill (${userHome}/.claude/skills/pr-review/SKILL.md) for PR #${pr.number} in ${pr.repo}. Argument: ${pr.number}.`
        : prAsk("review", pr.number, pr.repo);
      // Named after its branch (rv/PR-<n> or my PR's): the tab and, in Claude, the session.
      const name = branch.replace(prefixRe(), "");
      if (argv[0] === "claude") argv.push("-n", name);
      if (space) run("tab.new", { space, name, folder: path, argv, task });
      else run("space.new", { name: pr.repo.split("/")[1], folder: path, argv, task });
    } catch (e) { fail(String(e)); }
  }

  render(cx) {
    const t = theme();
    // Project (or folder) change: reload. render runs on every spaces/panes change.
    const space = spaces().find((s) => s.active);
    // Show the cached data and refresh anyway: the cache can be up to 2 minutes old.
    if (space?.id !== this.spaceId || placeOf(space) !== this.folder) this.load(cx, true);

    const entry = this.cache.get(this.key());
    const issues = entry?.issues ?? [];
    const pill = (id, label) => {
      const on = this.filter === id;
      return div().id(`f-${id}`).px(9).py(3).rounded(6).text_size(12.75).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setFilter(id, cx)).child(label);
    };
    const label = (l) => div().px(6).rounded(4).text_size(11.25).flex_none()
      .bg(`#${l.color}33`).text_color(`#${l.color}`).child(l.name);
    const agentButton = (i, a) => {
      const c = t[a.color];
      return h_flex().id(`${a.id}-${i.number}`).flex_none().h(21).px(6).gap(4).items_center().rounded(5).cursor_pointer()
        .text_size(11.75).font_semibold().text_color(c).bg(`${c}22`).border(1).border_color(`${c}55`)
        .hover((s) => s.bg(`${c}44`).border_color(c))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async () => this.agentFor(i, a)); })
        .child(image(a.icon).size(11.75)).child(a.label);
    };
    const pedidoButton = (i) => {
      const done = this.pedidos?.has(i.number);
      const c = t.accent;
      return h_flex().id(`pedido-${i.number}`).flex_none().h(21).px(6).gap(4).items_center().rounded(5)
        .text_size(11.75).font_semibold().text_color(done ? t.dim : c).border(1).border_color(done ? t.border : `${c}55`)
        .when(!done, (el) => el.cursor_pointer().bg(`${c}22`).hover((s) => s.bg(`${c}44`).border_color(c))
          .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => this.makePedido(i, cx)); }))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .tooltip(done ? "already an epic: it's in the agent tree" : "epic branch, no agent: hang others off it from the tree")
        .child(svg("mods/workspace-chrome/branch.svg").size(11.75)).child(done ? "Epic ✓" : "Epic");
    };
    const row = (i) => v_flex().id(`is-${i.number}`).px(12).py(7).gap(4).cursor_pointer().border_b(1).border_color(t.border)
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("open", [i.url]))
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().text_color(t.dim).text_size(12.75).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).text_color(t.foreground).text_size(13.5).child(i.title))
        .child(div().flex_none().text_size(11.75).text_color(t.dim).child(ago(i.updatedAt)))
        .child(v_flex().flex_none().gap(3).children(AGENTS.map((a) => agentButton(i, a))).child(pedidoButton(i))))
      .when(i.labels.length > 0 || i.assignees.length > 0, (el) => el.child(h_flex().pl(35).gap(4).flex_wrap()
        .children(i.labels.map(label))
        .when(this.filter === "all" && i.assignees.length > 0, (el) => el.child(div().text_size(11.25).text_color(t.muted).child(i.assignees.map((a) => `@${a.login}`).join(" "))))));

    // --- My PRs and Reviews (all repos) ---
    const data = shared("herdr-mod.prs") ?? {};
    // The repos of the current project: the focused terminal's and the ones the
    // agent list tied to this space (even if the terminal is in another folder).
    const activeId = spaces().find((x) => x.active)?.id;
    const hereSet = new Set([this.repo?.slug, ...Object.entries(data.repos ?? {}).filter(([, r]) => r.space && r.space === activeId).map(([slug]) => slug)].filter(Boolean));
    const here = this.repo?.slug;
    const isHere = (r) => hereSet.has(r);
    const byHere = (a, b) => isHere(b.repo) - isHere(a.repo);
    const mine = [...(data.mine ?? [])].sort((a, b) => b.needs - a.needs || byHere(a, b) || Date.parse(b.updated) - Date.parse(a.updated));
    const reviews = [...(data.reviews ?? [])].sort((a, b) => a.draft - b.draft || byHere(a, b) || Date.parse(a.asked_at) - Date.parse(b.asked_at));
    const needCount = mine.filter((p) => p.needs).length;
    // Need something: requested, or replied to after my review. Already-reviewed ones with nothing new show but don't count.
    const rrPending = (p) => !p.draft && p.status !== "reviewed";
    const rrCount = reviews.filter(rrPending).length;
    const chip = (text, color, strong = false) => div().flex_none().px(6).h(18).rounded(4).flex().items_center().text_size(11.25)
      .when(strong, (el) => el.font_semibold()).bg(`${color}26`).text_color(color).child(text);
    const plural = (n, a) => `${n} ${a}${n > 1 ? "s" : ""}`;
    const action = (id, label, color, fn, tip) => {
      const ok = Boolean(fn);
      return div().id(id).flex_none().h(21).px(7).rounded(5).flex().items_center().text_size(11.75).font_semibold()
        .text_color(ok ? color : t.dim).border(1).border_color(ok ? `${color}55` : t.border)
        .when(ok, (el) => el.cursor_pointer().bg(`${color}22`).hover((s) => s.bg(`${color}44`).border_color(color))
          .on_click((_e, cx) => { cx.stop_propagation(); fn(); }))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(Boolean(tip), (el) => el.tooltip(tip)).child(label);
    };
    const repoName = (r) => r.split("/")[1];
    const head = (pr, when, grouped = false) => h_flex().gap(8).items_start()
      .child(div().flex_1().min_w(0).text_size(13.5).text_color(t.foreground)
        .child(div().text_size(11.75).text_color(isHere(pr.repo) ? t.accent : t.dim).child(grouped ? `#${pr.number}` : `${repoName(pr.repo)} #${pr.number}`))
        .child(div().child(pr.title)))
      .child(div().flex_none().text_size(11.75).text_color(t.dim).child(when));
    // Color strip on the left: what needs you (red if blocked or older than a day).
    const strip = (c) => div().absolute().left(0).top(0).bottom(0).w(3).bg(c);
    const known = (r) => Boolean(data.repos?.[r]);
    const noRepo = "can't find that repo: not open in Herdr nor cloned in ~/Projects";

    const prRow = (pr) => {
      const chips = [];
      if (pr.changes) chips.push(chip("changes requested", t.blocked, true));
      if (pr.threads) chips.push(chip(plural(pr.threads, "unanswered thread"), t.ansi3, true));
      if (pr.comments) chips.push(chip(plural(pr.comments, "new comment"), t.ansi3, true));
      if (pr.ci === "fail") chips.push(chip("CI ✗", t.blocked, true));
      if (pr.conflict) chips.push(chip("conflict", t.blocked, true));
      if (pr.decision === "APPROVED") chips.push(chip("approved", t.ansi2));
      if (!pr.needs && pr.decision !== "APPROVED") chips.push(chip(pr.reviewers.length ? `waiting on ${pr.reviewers.join(", ")}` : pr.reviewed_by.length ? `reviewed by ${pr.reviewed_by.join(", ")}` : "no reviewer", t.muted));
      if (pr.ci === "pending") chips.push(chip("CI …", t.muted));
      if (pr.draft) chips.push(chip("draft", t.dim));
      if (pr.bots) chips.push(chip(`bots ${pr.bots}`, t.dim).id(`bots-${pr.repo}-${pr.number}`).tooltip("unanswered bot comments (not counted as pending)"));
      return v_flex().id(`pr-${pr.repo}-${pr.number}`).relative().px(12).py(8).gap(5).cursor_pointer().border_b(1).border_color(t.border)
        .when(pr.needs, (el) => el.child(strip(pr.changes || pr.ci === "fail" || pr.conflict ? t.blocked : t.ansi3)))
        .hover((s) => s.bg(t.hover))
        .on_click(() => exec("open", [pr.url]))
        .tooltip(pr.talk ? "click: open the latest comment" : "click: open the PR")
        .child(head(pr, ago(pr.updated), true))
        .child(h_flex().gap(4).flex_wrap().items_center().children(chips)
          .child(div().flex_1())
          .when(pr.talk, (el) => el.child(action(`fix-${pr.repo}-${pr.number}`, prLabel("fix"), t.ansi5,
            known(pr.repo) ? () => this.agentForPr(pr, "/pr-fix") : null,
            known(pr.repo) ? "Claude on the PR branch addresses the comments (if an agent is already there, it messages it)" : noRepo))));
    };
    const MY_STATE = { COMMENTED: ["you commented", t.muted], APPROVED: ["you approved", t.ansi2], CHANGES_REQUESTED: ["you requested changes", t.ansi3], DISMISSED: ["your review was dismissed", t.dim] };
    const rrRow = (pr) => v_flex().id(`rr-${pr.repo}-${pr.number}`).relative().px(12).py(8).gap(5).cursor_pointer().border_b(1).border_color(t.border)
      .when(rrPending(pr), (el) => el.child(strip(Date.now() - Date.parse(pr.asked_at) > 86400000 ? t.blocked : t.ansi5)))
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("open", [pr.url]))
      .tooltip(pr.status === "answered" ? "click: open the latest reply to you" : "click: open the PR")
      .child(head(pr, ago(pr.status === "reviewed" ? pr.reviewed_at : pr.asked_at)))
      .child(h_flex().gap(4).flex_wrap().items_center()
        .child(chip(`@${pr.author}`, t.muted))
        .when(Boolean(MY_STATE[pr.my_state]), (el) => el.child(chip(MY_STATE[pr.my_state][0], MY_STATE[pr.my_state][1])))
        .when(pr.status === "answered", (el) => el.child(chip(`replied: ${pr.why}`, t.accent, true)))
        .child(chip(`+${pr.plus} −${pr.minus}`, pr.plus + pr.minus > 1000 ? t.ansi3 : t.muted))
        .when(pr.again, (el) => el.child(chip("re-requested", t.accent, true)))
        .when(pr.draft, (el) => el.child(chip("draft", t.dim)))
        .child(div().flex_1())
        .child(action(`review-${pr.repo}-${pr.number}`, `${prLabel("review")} cc`, t.ansi5,
          known(pr.repo) ? () => this.agentForPr(pr, "/pr-review", "claude") : null,
          known(pr.repo) ? `Claude in skip mode, on the project's rv/PR-${pr.number} branch, does the review (publishes only with your go)` : noRepo))
        .child(action(`review-cx-${pr.repo}-${pr.number}`, "cx", t.ansi4,
          known(pr.repo) ? () => this.agentForPr(pr, "/pr-review", "codex") : null,
          known(pr.repo) ? `Codex in yolo mode, on the project's rv/PR-${pr.number} branch, follows the pr-review skill (publishes only with your go)` : noRepo)));
    const group = (title, items, fn, color = t.muted) => items.length === 0 ? [] : [
      div().px(12).pt(10).pb(5).text_size(11).font_semibold().text_color(color).child(`${title.toUpperCase()} · ${items.length}`),
      ...items.map(fn)];
    const prsBody = () => {
      if (!data.at) return [div().p(12).text_color(data.error ? t.blocked : t.dim).child(data.error ?? "Looking for your PRs on GitHub…")];
      if (this.section === "prs") {
        if (!mine.length) return [div().p(12).text_color(t.dim).child("You have no open PRs.")];
        // Grouped by repo; within each, what needs me first (mine already comes sorted that way).
        // Repos with something that needs me first, then by latest activity.
        const byRepo = (list) => {
          const m = new Map();
          for (const p of list) (m.get(p.repo) ?? m.set(p.repo, []).get(p.repo)).push(p);
          const last = (ps) => Math.max(...ps.map((p) => Date.parse(p.updated)));
          return [...m.entries()].sort(([, a], [, b]) => b.some((p) => p.needs) - a.some((p) => p.needs) || last(b) - last(a));
        };
        const repoHead = (repo, ps, color) => {
          const n = ps.filter((p) => p.needs).length;
          return h_flex().px(12).pt(12).pb(5).gap(6).items_center()
            .child(div().flex_none().text_size(11).font_semibold().text_color(color).child(`${repoName(repo).toUpperCase()} · ${ps.length}`))
            .when(n > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi3).child(`your turn: ${n}`)));
        };
        const section = (list, color) => byRepo(list).flatMap(([repo, ps]) => [repoHead(repo, ps, color), ...ps.map(prRow)]);
        const mineHere = mine.filter((p) => isHere(p.repo)), others = mine.filter((p) => !isHere(p.repo));
        // The current project in its own box, well apart from the rest.
        const box = mineHere.length ? [
          v_flex().id("prs-here").mx(8).mt(8).rounded(8).overflow_hidden().border(1).border_color(`${t.accent}88`).bg(`${t.accent}14`)
            .child(div().px(12).pt(8).text_size(10.5).font_semibold().text_color(t.accent).child("THIS PROJECT"))
            .children(section(mineHere, t.accent))] : [];
        const sep = mineHere.length && others.length ? [h_flex().px(12).pt(26).pb(2).gap(8).items_center()
          .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child("OTHER PROJECTS"))
          .child(div().flex_1().h(1).bg(t.border))] : [];
        return [...box, ...sep, ...section(others, t.muted)];
      }
      if (!reviews.length) return [div().p(12).text_color(t.dim).child("You have no open reviews. 🎉")];
      return [...group("Review requested", reviews.filter((p) => !p.draft && p.status === "asked"), rrRow),
        ...group("They answered", reviews.filter((p) => !p.draft && p.status === "answered"), rrRow),
        ...group("Already reviewed", reviews.filter((p) => !p.draft && p.status === "reviewed").sort((a, b) => byHere(a, b) || Date.parse(b.reviewed_at) - Date.parse(a.reviewed_at)), rrRow),
        ...group("Drafts", reviews.filter((p) => p.draft), rrRow)];
    };
    const updated = data.at ? `${data.error ? "⚠ " : ""}${Date.now() - data.at < 60000 ? "just now" : `${ago(new Date(data.at).toISOString())} ago`}` : "";

    const segment = (id, label, n, hot) => {
      const on = this.section === id;
      return h_flex().id(`sec-${id}`).flex_1().h(26).gap(5).justify_center().items_center().rounded(6).text_size(12.75).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setSection(id, cx)).child(label)
        .when(n > 0, (el) => el.child(div().px(5).rounded(8).text_size(10.5).font_semibold().bg(`${hot}33`).text_color(hot).child(String(n))));
    };
    const issuesSection = this.section === "issues";

    return v_flex().size_full().bg(t.chrome).text_color(t.foreground).text_size(12.75)
      .child(h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).flex_none()
        .child(svg("mods/herdr-mod/assets/github.svg").size(15).text_color(t.muted))
        .child(h_flex().id("repo-link").flex_1().min_w(0).gap(5).items_center()
          .when(Boolean(this.repo?.slug), (el) => el.cursor_pointer().hover((s) => s.text_color(t.accent))
            .on_click(() => exec("open", [`https://github.com/${this.repo.slug}`])))
          .child(div().min_w(0).truncate().text_size(13.5).font_semibold().child(this.repo?.slug ?? "GitHub"))
          .when(Boolean(this.repo?.slug), (el) => el.child(div().flex_none().text_size(11.75).text_color(t.dim).child("↗"))))
        .child(div().id("refresh").px(6).rounded(5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.load(cx, true); setShared("herdr-mod.prs.refresh", Date.now()); setShared("herdr-mod.prs.loading", true); cx.notify(); })
          .tooltip("Refresh issues, PRs and reviews")
          .child(this.loading || shared("herdr-mod.prs.loading")
            ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.accent).spin(900)
            : div().child("↻"))))
      .child(h_flex().px(8).pt(8).gap(4).flex_none()
        .child(segment("issues", "Issues", 0, t.muted))
        .child(segment("prs", "My PRs", needCount, t.ansi3))
        .child(segment("reviews", "Reviews", rrCount, t.ansi5)))
      .child(h_flex().px(12).py(8).gap(6).items_center().flex_none()
        .when(issuesSection, (el) => el.child(pill("mine", "Mine")).child(pill("all", "All")))
        .when(!issuesSection, (el) => el.child(div().text_size(11.75).text_color(t.dim).child("all your repos")))
        .child(div().flex_1())
        .child(div().text_size(11.75).text_color(t.dim).child(issuesSection ? (entry && !entry.error ? `${issues.length} open` : "") : updated)))
      .when(!issuesSection, (el) => el.child(v_flex().id("prs").flex_1().min_h(0).overflow_y_scrollbar().children(prsBody())))
      .when(issuesSection, (el) => el.child(v_flex().id("issues").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().p(12).text_color(t.muted).child(this.error)))
        .when(!this.error && Boolean(entry?.error), (el) => el.child(div().p(12).text_color(t.blocked).child(entry.error)))
        .when(!this.error && !entry, (el) => el.child(div().p(12).text_color(t.dim).child("Loading issues…")))
        .when(!this.error && entry && !entry.error && issues.length === 0, (el) => el.child(div().p(12).text_color(t.dim)
          .child(this.filter === "mine" ? "No issues assigned to you." : "No open issues.")))
        .children(this.error ? [] : issues.map(row))));
  }
}
