// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
// shortcut tips.
import { exec, home, notify, agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";
import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("agents");

const tip = (...items) => setShared("herdr-mod.tip", { items: items.map(([action, text]) => ({ action, text })), at: Date.now() });
const rowTip = (a) => (a.status === "blocked" || a.status === "done")
  ? tip(["herdr-mod.waiting", "see who's waiting on you"])
  : tip(["herdr-mod.buscar", "find an agent"], ["agent.next", "next agent"], ["herdr-mod.waiting", "see who's waiting on you"]);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
// Claude teammates' colors, in the theme's palette.
const MATE_COLOR = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", cyan: "ansi6", orange: "ansi9", pink: "ansi13" };
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("herdr-mod.agents.sort")) ?? SORTS[1];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    this.parents = JSON.parse(localStorage.getItem("parents") ?? "{}"); // agent -> agent that contains it (view only)
    cx.timer.every(30000, (cx) => cx.notify());
    // branch tree per project (branch.<b>.herdrBase / herdrPedido in git).
    this.chains = {};
    cx.timer.every(15000, (cx) => this.loadChains(cx));
    // Another mod (GitHub, the agent dialog) changed a chain: reload now.
    this.chainsAt = shared("herdr-mod.chains.at") ?? 0; // checked by the 1 s timer below
    this.loadChains(cx);
    // Claude agent-team teammates, per terminal.
    this.teams = {};
    cx.timer.every(5000, (cx) => this.loadTeams(cx));
    this.loadTeams(cx);
    // what each agent is doing (agentes.py, every 5 s; with an extension next to it, also
    // its stage) and my PRs
    // with new comments (every 2 min). Everything that needs attention goes to
    // shared("herdr-mod.alerts") for the bottom bar and ⌘J.
    this.lk = {};
    this.prs = null;
    // sleeping agents (2 h unused): they leave with /exit and come back with --resume.
    this.sleeping = JSON.parse(localStorage.getItem("sleeping") ?? "{}");
    cx.timer.every(60000, (cx) => this.sleepIdle(cx));
    cx.timer.after(30000, (cx) => this.sleepIdle(cx));
    // If herdr-core restarted (computer reboot, update), the agents that were running
    // were left as shells: they become sleeping and come back with --resume when opened.
    this.recovered = false;
    cx.timer.after(8000, (cx) => this.recoverAfterRestart(cx));
    this.reviewWarned = new Set();
    cx.timer.every(5000, (cx) => this.loadEstado(cx));
    this.loadEstado(cx);
    // /pr-review and /pr-fix (skills, if you have them): if they aren't installed, the PR buttons
    // send a plain request. shared("herdr-mod.skills") = { "pr-review": bool, "pr-fix": bool }.
    const skills = (cx) => cx.spawn(async () => {
      const r = await exec("sh", ["-c", 'for s in pr-review pr-fix; do [ -f "$HOME/.claude/skills/$s/SKILL.md" ] && echo $s; done']);
      const have = new Set((r.stdout ?? "").split("\n").filter(Boolean));
      setShared("herdr-mod.skills", { "pr-review": have.has("pr-review"), "pr-fix": have.has("pr-fix") });
    });
    skills(cx);
    cx.timer.every(600000, skills);
    cx.timer.every(120000, (cx) => this.loadReviews(cx));
    cx.timer.after(4000, (cx) => this.loadReviews(cx));
    cx.timer.after(25000, (cx) => this.loadReviews(cx)); // with the projects already loaded
    // ⌘J and the bar ask to dismiss a PR alert or refresh now.
    // The GitHub panel's ↻ asks to refresh now.
    // A single 1 s timer for everything the other mods ask for (each JS call costs).
    cx.timer.every(1000, (cx) => {
      const at = shared("herdr-mod.chains.at") ?? 0;
      if (at > this.chainsAt) { this.chainsAt = at; this.loadChains(cx); }
      const d = shared("herdr-mod.alerts.dismiss");
      if (d && d.at > (this.dismissAt ?? 0)) { this.dismissAt = d.at; this.dismissPr(d.key); this.publishAlerts(); cx.notify(); }
      const f = shared("herdr-mod.prs.refresh");
      if (f && f > (this.refreshAt ?? 0)) { this.refreshAt = f; this.loadReviews(cx); }
      // Looking at a sleeping agent wakes it.
      const pane = focused()?.pane;
      const z = pane && Object.values(this.sleeping).find((r) => r.pane === pane);
      if (z && !agents().some((a) => a.address === z.addr)) { this.wake(z.addr); cx.notify(); } // if it's still exiting, on the next tick
    });
  }

  // Notifications: a teammate that finishes its turn (with what it answered) and, when
  // they all finish, the whole team. Only changes, never at startup.
  announce(before, after) {
    for (const [lead, mates] of Object.entries(after)) {
      const was = new Map((before[lead] ?? []).map((m) => [m.name, m.status]));
      const done = mates.filter((m) => m.status === "idle" && was.get(m.name) === "working");
      if (!done.length) continue;
      const who = panes().find((p) => p.terminal === lead)?.branch?.replace(prefixRe(), "") || lead;
      const all = mates.every((m) => m.status === "idle");
      for (const m of done) {
        notify({ title: all && m === done.at(-1) ? `${who}'s team: all done` : `${m.name} finished (${who})`, body: m.said ?? "", level: "info", timeout: 8000 });
      }
    }
  }

  loadEstado(cx) {
    if (this.loadingLk) return;
    this.loadingLk = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${home()}/.config/herdr-app/mods/herdr-mod/scripts/agentes.py`]);
        const next = JSON.parse(r.stdout || "{}");
        // A cross-review running past 15 min: alert, once per process.
        for (const [addr, st] of Object.entries(next)) {
          const rv = st.review;
          if (rv && rv.secs >= 900 && !this.reviewWarned.has(rv.pid)) {
            this.reviewWarned.add(rv.pid);
            notify({ title: `${rv.tool} review of ${this.who(addr)} running for ${Math.floor(rv.secs / 60)} min`, body: "It may be stuck: stop it from the bottom bar or ⌘J.", level: "warning", timeout: 10000 });
          }
        }
        if (JSON.stringify(next) !== JSON.stringify(this.lk)) {
          this.lk = next;
          this.trackRunning();
          this.syncNames();
          setShared("herdr-mod.estado", next);
          this.publishAlerts();
          cx.notify();
        }
      } catch {}
      this.loadingLk = false;
    });
  }

  // The Claude session is named like the agent: if not (Claude made one up, or you
  // renamed it in Herdr), send it /rename. Only while the agent is idle and unfocused,
  // so it doesn't mix with what you're typing; one attempt every 2 min.
  syncNames() {
    const now = Date.now();
    this.renameSent ??= {};
    for (const a of agents()) {
      const st = this.lk?.[a.address], want = this.names?.[a.address];
      if (!st || st.agent !== "claude-code" || !st.session || !want || st.session_name === want) continue;
      if (a.focused || !["idle", "done"].includes(a.status)) continue;
      const sent = this.renameSent[a.address];
      if (sent && sent.name === want && now - sent.at < 120000) continue;
      this.renameSent[a.address] = { name: want, at: now };
      exec("hc", ["send", a.address, `/rename ${want}`]);
    }
  }

  // The agent's branch (without prefix), or its program.
  who(addr) {
    const p = panes().find((x) => x.terminal === addr);
    return this.names?.[addr] || p?.branch?.replace(prefixRe(), "") || terminals().find((k) => k.address === addr)?.program?.name || addr;
  }

  // GitHub, across all my repos (scripts/prs.py, every 2 min): my open PRs
  // (if it's my turn: unanswered threads, new comments, requested changes,
  // CI, conflicts) and the ones I was asked to review. Goes to shared("herdr-mod.prs") for
  // the GitHub panel, with repos = {"owner/repo": local checkout of some project}.
  // Notifies what's new (no notification the first time) and once a day what has been
  // waiting for more than a day.
  loadReviews(cx) {
    if (this.loadingReviews) return;
    this.loadingReviews = true;
    setShared("herdr-mod.prs.loading", true); // the GitHub panel's ↻ spins
    cx.spawn(async (cx) => {
      try {
        const repos = {};
        for (const sp of spaces()) {
          const c = this.chains[sp.id];
          if (!c?.cwd) continue;
          const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: c.cwd, on: c.on });
          if (common.code !== 0) continue;
          const main = common.stdout.trim().replace(/\/\.git$/, "");
          const url = await exec("git", ["remote", "get-url", "origin"], { cwd: main, on: c.on });
          const slug = (url.stdout ?? "").trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
          if (slug && !repos[slug]) repos[slug] = { main, on: c.on, space: sp.id };
        }
        const r = await exec("python3", [`${home()}/.config/herdr-app/mods/herdr-mod/scripts/prs.py`, ...cfg().projects]);
        const data = JSON.parse(r.stdout || "{}");
        if (data.error || !data.mine) {
          const at = Date.now();
          setShared("herdr-mod.prs", { ...(shared("herdr-mod.prs") ?? {}), error: data.error ?? "gh didn't respond", repos, at });
          setShared("herdr-mod.prs.at", at); // so the panel shows the ⚠
        } else {
          this.prs = data;
          // Repos not open in Herdr but cloned in ~/Projects.
          for (const [slug, main] of Object.entries(data.clones ?? {})) repos[slug] ??= { main, on: null, space: null };
          const at = Date.now();
          setShared("herdr-mod.prs", { ...data, clones: undefined, repos, at });
          setShared("herdr-mod.prs.at", at); // small: to see if it changed without fetching everything
          this.announcePrs(data);
        }
        this.publishAlerts();
        cx.notify();
      } catch {}
      this.loadingReviews = false;
      setShared("herdr-mod.prs.loading", false);
    });
  }

  announcePrs(data) {
    const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    const first = localStorage.getItem("prtalk") == null;
    const talk = JSON.parse(localStorage.getItem("prtalk") ?? "{}");
    const asked = JSON.parse(localStorage.getItem("prasked") ?? "{}");
    const short = (pr) => `${pr.repo.split("/")[1]} #${pr.number}`;
    const nextTalk = {}, nextAsked = {};
    for (const pr of data.mine) {
      const key = `${pr.repo}#${pr.number}`, n = pr.threads + pr.comments + (pr.changes ? 1 : 0);
      nextTalk[key] = n;
      if (!first && n > (talk[key] ?? 0)) {
        notify({ title: `${short(pr)}: ${pr.changes && !(talk[key] > 0) ? "changes requested" : "new comments"}`, body: `${pr.title}\nIn GitHub › My PRs: /pr-fix in one click.`, level: "info", timeout: 12000 });
      }
    }
    // Reviews that need something: requested, or already reviewed and answered ("reviewed" doesn't notify).
    const pending = data.reviews.filter((p) => p.status !== "reviewed");
    for (const pr of pending) {
      const key = `${pr.repo}#${pr.number}`;
      nextAsked[key] = pr.asked_at;
      if (!first && asked[key] !== pr.asked_at) {
        notify({ title: pr.status === "answered" ? `${pr.author} replied to your review: ${short(pr)}` : `${pr.author} requested your review${pr.again ? " again" : ""}: ${short(pr)}`,
          body: `${pr.title}${pr.why ? `\n${pr.why}` : ""}\nIn GitHub › Reviews.`, level: "info", timeout: 12000 });
      }
    }
    store("prtalk", nextTalk); store("prasked", nextAsked);
    // Once a day: what has been waiting on you for more than 24 h.
    const today = new Date().toDateString();
    if (localStorage.getItem("prnag") !== today) {
      const old = (iso) => iso && Date.now() - Date.parse(iso) > 86400000;
      const rr = pending.filter((p) => !p.draft && old(p.asked_at)).length;
      const ch = data.mine.filter((p) => p.changes && old(p.updated)).length;
      if (rr || ch) {
        localStorage.setItem("prnag", today);
        notify({ title: "People are waiting on you in GitHub", body: [rr && `${rr} review${rr > 1 ? "s" : ""} waiting on you for over a day`, ch && `${ch} PR${ch > 1 ? "s" : ""} of yours with changes requested`].filter(Boolean).join(" · "), level: "warning", timeout: 15000 });
      }
    }
  }

  // ✕ in ⌘J: mutes the alert until it changes (another comment, another request).
  dismissPr(key) {
    const sig = this.prSig(key);
    if (sig == null) return;
    const mute = JSON.parse(localStorage.getItem("prmute") ?? "{}");
    mute[key] = sig;
    localStorage.setItem("prmute", JSON.stringify(mute));
  }

  prSig(key) {
    const pr = this.prs?.mine.find((p) => `${p.repo}#${p.number}` === key);
    if (pr) return `${pr.threads}:${pr.comments}:${pr.changes}:${pr.mine_at}`;
    const rr = this.prs?.reviews.find((p) => `rr:${p.repo}#${p.number}` === key);
    return rr ? rr.asked_at : null;
  }

  // What needs attention: long reviews, agents waiting for go, and PRs with comments.
  publishAlerts() {
    const out = [];
    for (const [addr, st] of Object.entries(this.lk)) {
      if (st.review && st.review.secs >= 600) out.push({ kind: "review", addr, who: this.who(addr), secs: st.review.secs, pid: st.review.pid, stop: st.review.stop, tool: st.review.tool, rkind: st.review.kind, hung: st.review.secs >= 1200 });
      if (st.next) out.push({ kind: "go", addr, who: this.who(addr), next: st.next, stage: st.stage, size: st.size });
    }
    // My PRs with something to answer and the reviews requested from me (minus the muted ones).
    const mute = JSON.parse(localStorage.getItem("prmute") ?? "{}");
    const plural = (n, a) => `${n} ${a}${n > 1 ? "s" : ""}`;
    for (const pr of this.prs?.mine ?? []) {
      const key = `${pr.repo}#${pr.number}`;
      if (!pr.talk || mute[key] === this.prSig(key)) continue;
      const agent = panes().find((p) => p.branch === pr.branch && p.program?.agent);
      const what = [pr.changes && "changes requested", pr.threads && `${plural(pr.threads, "unanswered thread")}`, pr.comments && `${plural(pr.comments, "new comment")}`].filter(Boolean).join(" · ");
      out.push({ kind: "pr", key, repo: pr.repo, number: pr.number, branch: pr.branch, url: pr.url, n: pr.threads + pr.comments, changes: pr.changes, what,
        who: `${pr.repo.split("/")[1]} #${pr.number}`, title: pr.title, addr: agent?.terminal ?? null });
    }
    for (const pr of this.prs?.reviews ?? []) {
      const key = `rr:${pr.repo}#${pr.number}`;
      if (pr.draft || pr.status === "reviewed" || mute[key] === pr.asked_at) continue;
      const what = pr.status === "answered" ? `${pr.author} replied to your review: ${pr.why}` : `${pr.author} requested your review${pr.again ? " again" : ""} · +${pr.plus} −${pr.minus}`;
      out.push({ kind: "rr", key, repo: pr.repo, number: pr.number, url: pr.url, author: pr.author, asked_at: pr.asked_at, again: pr.again, status: pr.status,
        who: `${pr.repo.split("/")[1]} #${pr.number}`, title: pr.title, what, addr: null });
    }
    setShared("herdr-mod.alerts", out);
  }

  // Stage (from an extension) and running review, as chips on the agent's row.
  loopTags(t, a) {
    const st = this.lk?.[a.address];
    if (!st) return [];
    const out = [];
    if (st.stage) {
      const c = /^(design|spec|tickets|split)/.test(st.stage) ? t.ansi4 : /^(impl|fix|small|refactor)/.test(st.stage) ? t.ansi3 : /^pr/.test(st.stage) ? t.ansi2 : t.muted;
      out.push(div().id(`lk-${a.address}`).flex_none().px(5).rounded(4).text_size(10.5).font_semibold().bg(`${c}26`).text_color(c)
        .tooltip([`stage: /${st.stage}`, st.size ? `size ${st.size}${st.mode ? ` · mode ${st.mode}` : ""}` : null, st.activity, st.next ? `waiting for go on ${st.next}` : null].filter(Boolean).join("\n"))
        .child(`${st.size ? `${st.size} · ` : ""}${st.stage}`));
    }
    if (st.next) out.push(div().flex_none().px(5).rounded(4).text_size(10.5).font_semibold().bg(`${t.accent}26`).text_color(t.accent).child("go?"));
    // Codex (or Claude) reviewing for this agent: /codex:review, /codex:adversarial-review,
    // /codex:rescue or a cross-review. Shown from the first second; yellow at 10 min, red at 20.
    if (st.review) {
      const rv = st.review, m = Math.floor(rv.secs / 60), c = rv.secs >= 1200 ? t.blocked : rv.secs >= 600 ? t.ansi3 : rv.tool === "Codex" ? t.ansi4 : t.ansi3;
      out.push(h_flex().id(`rv-${a.address}`).flex_none().gap(4).items_center().px(5).rounded(4).text_size(10.5).font_semibold().bg(`${c}26`).text_color(c)
        .tooltip(`${rv.tool} ${rv.kind ?? "review"} running for ${m} min${rv.phase ? ` (${rv.phase})` : ""}`)
        .child(svg("mods/workspace-chrome/spinner.svg").size(9).text_color(c).spin(900))
        .child(`${rv.tool} ${rv.kind === "adversarial" ? "adv" : rv.kind ?? "review"}${m ? ` ${m}m` : ""}`));
    }
    return out;
  }

  // teams.py reads ~/.claude/teams and returns { "t1b": [{ name, color, model, status, task }] }.
  loadTeams(cx) {
    if (this.loadingTeams) return;
    this.loadingTeams = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${home()}/.config/herdr-app/mods/herdr-mod/scripts/teams.py`]);
        const next = JSON.parse(r.stdout || "{}");
        if (JSON.stringify(next) !== JSON.stringify(this.teams)) {
          if (this.teamsLoaded) this.announce(this.teams, next);
          this.teams = next;
          setShared("herdr-mod.teams", next);
          cx.notify();
        }
        this.teamsLoaded = true;
      } catch {}
      this.loadingTeams = false;
    });
  }

  loadChains(cx) {
    if (this.loadingChains) return;
    this.loadingChains = true;
    cx.spawn(async (cx) => {
      const next = {};
      this.prs ??= {};
      for (const sp of spaces()) {
        const tabs = new Set(sp.tabs.map((x) => x.id));
        const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? sp.folder;
        if (!cwd) continue;
        try {
          const on = sp.machine ?? null;
          const git = async (args) => { const r = await exec("git", args, { cwd, on }); return { ok: r.code === 0, out: (r.stdout ?? "").trim() }; };
          const heads = new Set((await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).out.split("\n"));
          const r = await git(["config", "--get-regexp", "^branch\\..*\\.herdr(pedido|base|from)$"]);
          const base = {}, from = {}, pedidos = new Set();
          for (const line of r.out.split("\n").filter(Boolean)) {
            const at = line.indexOf(" "), key = line.slice(0, at), val = line.slice(at + 1);
            const name = key.slice("branch.".length, key.lastIndexOf("."));
            if (!heads.has(name)) continue;
            if (key.endsWith(".herdrbase") && heads.has(val)) base[name] = val;
            if (key.endsWith(".herdrfrom")) from[name] = val;
            if (key.endsWith(".herdrpedido") && val === "true") pedidos.add(name);
          }
          // State of each epic branch: ✓ already in the epic, ● own commits
          // not merged, ○ no commits. Own ones: from..branch (herdrFrom;
          // without it, fork-point, else merge-base with its base).
          const pedidoOf = (b, seen = new Set()) => pedidos.has(b) ? b : base[b] && !seen.has(b) ? pedidoOf(base[b], seen.add(b)) : null;
          const state = {};
          for (const b of Object.keys(base)) {
            let start = from[b];
            if (!start) { const f = await git(["merge-base", "--fork-point", base[b], b]); start = f.ok && f.out ? f.out : (await git(["merge-base", base[b], b])).out; }
            const ahead = Number((await git(["rev-list", "--count", `${start}..${b}`])).out) || 0;
            const ped = pedidoOf(b);
            state[b] = { ahead, merged: ahead > 0 && Boolean(ped) && (await git(["merge-base", "--is-ancestor", b, ped])).ok };
          }
          // PRs per branch: gh is slow, every 2 minutes per repo.
          const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).out;
          const cache = this.prs[common];
          if ((pedidos.size || Object.keys(base).length) && (!cache || Date.now() - cache.at > 120000)) {
            const pr = await exec("gh", ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,headRefName,state,isDraft"], { cwd, on });
            this.prs[common] = { at: Date.now(), by: Object.fromEntries((pr.code === 0 ? JSON.parse(pr.stdout) : []).map((x) => [x.headRefName, x])) };
          }
          next[sp.id] = { base, pedidos, state, prs: this.prs[common]?.by ?? {}, cwd, on };
        } catch {}
      }
      this.chains = next;
      this.loadingChains = false;
      cx.notify();
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("herdr-mod.agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // Drag and drop in the tree (this.drag lives from mouse_down to mouse_up; leaving
  // the list cancels it). Targets: "a:<terminal>" (an agent), "b:<branch>" (a
  // branch without an agent, e.g. an epic) or null (the project title).
  // - An agent onto another agent: it goes inside that one, view only
  //   (localStorage "parents"; git untouched). Onto the title: back to its place.
  // - Onto a branch without an agent, or a branch without an agent onto anything: the branch
  //   now hangs from that one (branch.<branch>.herdrBase; code untouched). Onto the
  //   title: it's left without a base.
  targetBranch(target) {
    if (!target) return null;
    if (target.startsWith("b:")) return target.slice(2);
    return panes().find((p) => p.terminal === target.slice(2))?.branch ?? null;
  }

  canDrop(d, target) {
    if (!d || target === d.src) return false;
    const base = this.chains[d.space]?.base ?? {};
    if (target === null) return Boolean(d.addr && this.parents[d.addr]) || Boolean(d.b && base[d.b]);
    if (d.addr && target.startsWith("a:")) {
      const to = target.slice(2);
      if (this.parents[d.addr] === to) return false;
      const sp = agents().find((a) => a.address === to)?.space ?? this.sleeping[to]?.space;
      if (sp && sp !== d.space) return false; // only within the same project
      for (let x = to, seen = new Set(); x && !seen.has(x); x = this.parents[x]) { if (x === d.addr) return false; seen.add(x); }
      return true;
    }
    const tb = this.targetBranch(target);
    if (!d.b || !tb || tb === d.b) return false;
    for (let x = tb, seen = new Set(); x && !seen.has(x); x = base[x]) { if (x === d.b) return false; seen.add(x); }
    return base[d.b] !== tb;
  }

  dragOver(target, cx) {
    const d = this.drag;
    if (!d || d.over === target) return;
    d.over = target;
    if (target !== d.src) d.moving = true;
    cx.notify();
  }

  setParents(next) {
    this.parents = next;
    localStorage.setItem("parents", JSON.stringify(next));
  }

  dropOn(target, cx) {
    const d = this.drag;
    this.drag = null;
    cx.notify();
    if (!d?.moving || !this.canDrop(d, target)) return;
    const short = (b) => b.replace(prefixRe(), "");
    // The name you gave it (its tab), else the branch.
    const nameOf = (addr) => {
      const tab = agents().find((a) => a.address === addr)?.tab;
      const named = tab && spaces().flatMap((s) => s.tabs).find((x) => x.id === tab && x.named);
      return named?.name || this.who(addr);
    };
    // Agent inside another, or back to its place: view only.
    if (d.addr && (target === null ? this.parents[d.addr] : target.startsWith("a:"))) {
      const next = { ...this.parents };
      if (target === null) delete next[d.addr]; else next[d.addr] = target.slice(2);
      this.setParents(next);
      notify({ title: target === null ? `${nameOf(d.addr)} is back in its place` : `${nameOf(d.addr)} is now inside ${nameOf(target.slice(2))}`,
        body: "View only: neither the branch nor the code changes. Drop it on the project title to take it out.", level: "info", timeout: 5000 });
      return;
    }
    const c = this.chains[d.space];
    if (!c?.cwd) return;
    const tb = this.targetBranch(target);
    cx.spawn(async () => {
      const args = target === null ? ["config", "--unset", `branch.${d.b}.herdrBase`] : ["config", `branch.${d.b}.herdrBase`, tb];
      const r = await exec("git", args, { cwd: c.cwd, on: c.on });
      if (r.code !== 0) return notify({ title: `Couldn't move ${short(d.b)}`, body: (r.stderr || r.stdout || "").trim(), level: "error" });
      if (d.addr && this.parents[d.addr]) { const next = { ...this.parents }; delete next[d.addr]; this.setParents(next); }
      setShared("herdr-mod.chains.at", Date.now());
      notify({ title: target === null ? `${short(d.b)} has no base now` : `${short(d.b)} now hangs from ${short(tb)}`, body: "Tree only: the code wasn't touched.", level: "info", timeout: 5000 });
    });
  }

  // Drag-and-drop wiring for each tree row. src: {addr?, b?, space}; key: its target.
  draggable(el, t, src, key) {
    const d = this.drag;
    const target = d?.moving && d.over === key;
    return el
      .on_mouse_down("left", () => { this.drag = { ...src, src: key, over: key, moving: false }; })
      .on_mouse_move((_e, cx) => this.dragOver(key, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOn(key, cx))
      .when(Boolean(d?.moving) && d.src === key, (el) => el.opacity(0.45))
      .when(Boolean(target) && this.canDrop(d, key), (el) => el.bg(`${t.accent}33`).border(1).border_color(t.accent))
      .when(Boolean(target) && !this.canDrop(d, key) && d.src !== key, (el) => el.bg(`${t.blocked}22`));
  }

  // ✓ ● ○ of an epic branch and its PR. Nothing if the branch isn't in any chain.
  branchTags(t, spaceId, b) {
    const c = this.chains[spaceId];
    if (!b || !c) return [];
    const out = [];
    // The epic says so whether or not it has an agent.
    if (c.pedidos?.has(b)) out.push(div().flex_none().px(5).rounded(4).text_size(10.5).bg(`${t.accent}22`).text_color(t.accent).child("epic"));
    const st = c.state?.[b];
    if (st) {
      const [mark, color, tip] = st.merged ? ["✓", t.ansi2, "already in the epic"] : st.ahead > 0 ? ["●", t.accent, `${st.ahead} unmerged commit${st.ahead > 1 ? "s" : ""}`] : ["○", t.dim, "no commits"];
      out.push(div().id(`st-${b}`).flex_none().text_size(11).text_color(color).tooltip(tip).child(mark));
    }
    const pr = c.prs?.[b];
    if (pr) out.push(div().flex_none().px(4).rounded(4).text_size(10).bg(`${pr.state === "MERGED" ? t.ansi5 : t.ansi2}33`).text_color(pr.state === "MERGED" ? t.ansi5 : t.ansi2)
      .child(`#${pr.number}${pr.isDraft ? " draft" : pr.state === "MERGED" ? " ✓" : ""}`));
    return out;
  }

  // + : a new branch on top of `b`, with Claude or Codex (the dialog asks for issue and agent).
  plus(t, spaceId, b) {
    return div().id(`plus-${b}`).flex_none().px(4).rounded(4).text_size(13).font_semibold().text_color(t.accent).cursor_pointer()
      .tooltip(`new agent on a branch on top of ${b.replace(prefixRe(), "")}`)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "herdr-mod", kind: "dialog", width: 520, height: 250, props: { role: "worktree", space: spaceId, id: "claude", choose: true, base: b } });
      })
      .child("+");
  }

  // Sleep: a Claude or Codex agent unused for 2 h (idle or done, not viewed)
  // leaves with /exit (Codex: /quit) and frees its RAM; the terminal keeps its shell.
  // It stays in the list, grayed with "zz"; viewing it (click or going to its tab)
  // brings it back with `claude --resume <session>` (Codex: `codex resume`), with its flags;
  // if it never had a conversation, it starts from scratch.
  // Never put to sleep: a pinned one, one with live teammates or sub-agents,
  // one running a review, or one on another machine.
  sleepIdle(cx) {
    const SLEEP_MS = 2 * 3600 * 1000;
    const now = Date.now();
    const terms = new Map(terminals().map((k) => [k.address, k]));
    const listed = new Set(agents().map((a) => a.address));
    // No longer needed: the terminal is gone or someone reopened the agent.
    for (const [addr, r] of Object.entries(this.sleeping)) {
      if (terms.get(addr)?.state !== "live" || listed.has(addr)) delete this.sleeping[addr];
    }
    // "Inside of" links for agents that are gone.
    const gone = Object.entries(this.parents).filter(([k, v]) => !terms.has(k) || !terms.has(v));
    if (gone.length) { const next = { ...this.parents }; for (const [k] of gone) delete next[k]; this.setParents(next); }
    const me = focused()?.agent;
    const slept = [];
    for (const a of agents()) {
      const st = this.lk?.[a.address], k = terms.get(a.address);
      // No session (never chatted): it sleeps anyway and wakes from scratch, nothing lost.
      if (!st || !["claude-code", "codex"].includes(st.agent)) continue;
      if (!["idle", "done"].includes(a.status) || a.focused || a.address === me || a.address.includes("/")) continue;
      if (this.pins.includes(a.address) || st.review || (this.teams?.[a.address] ?? []).length) continue;
      if (terminals().some((x) => x.parent === a.address && x.state === "live")) continue;
      // Since when it's been like this: what track() records (survives restarts); terminals() doesn't have it.
      const since = this.since(a) || k?.status_ms;
      if (!since || now - since < SLEEP_MS) continue;
      this.sleeping[a.address] = {
        addr: a.address, pane: a.pane, space: a.space, space_name: a.space_name, program: a.program, seq: a.seq, title: a.title,
        kind: st.agent, session: st.session ?? null, argv: st.argv ?? [], at: now,
      };
      exec("hc", ["send", a.address, st.agent === "codex" ? "/quit" : "/exit"]);
      slept.push(this.who(a.address));
    }
    localStorage.setItem("sleeping", JSON.stringify(this.sleeping));
    if (slept.length) {
      notify({ title: `Put ${slept.length === 1 ? slept[0] : `${slept.length} agents`} to sleep`, body: `${slept.length > 1 ? slept.join(", ") + ": " : ""}unused for 2 h. Still in the list (zz); open them to pick up where they left off.`, level: "info", timeout: 8000 });
      cx.notify();
    }
  }

  // Which agent runs in each terminal (with its session and how it was launched), and on which herdr-core:
  // localStorage "running". If the core changes, recoverAfterRestart knows what was cut off.
  trackRunning() {
    if (!this.recovered || !this.corePid) return;
    const out = {};
    for (const a of agents()) {
      const st = this.lk?.[a.address];
      if (!st || !["claude-code", "codex"].includes(st.agent) || a.address.includes("/")) continue;
      out[a.address] = { addr: a.address, pane: a.pane, space: a.space, space_name: a.space_name, program: a.program,
        title: this.who(a.address), kind: st.agent, session: st.session ?? null, argv: st.argv ?? [] };
    }
    const json = JSON.stringify({ core: this.corePid, agents: out });
    if (json !== this.runningJson) { this.runningJson = json; localStorage.setItem("running", json); }
  }

  recoverAfterRestart(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hc", ["server", "status", "--json"]);
        this.corePid = JSON.parse(r.stdout || "{}").pid ?? null;
        const prev = JSON.parse(localStorage.getItem("running") ?? "null");
        if (this.corePid && prev?.core && prev.core !== this.corePid) {
          const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
          const now = new Set(agents().map((a) => a.address));
          const back = [];
          for (const [addr, rec] of Object.entries(prev.agents ?? {})) {
            if (!live.has(addr) || now.has(addr) || this.sleeping[addr]) continue;
            const pane = panes().find((p) => p.terminal === addr)?.pane ?? rec.pane;
            this.sleeping[addr] = { ...rec, pane, seq: 0, at: Date.now(), restarted: true };
            back.push(rec.title || addr);
          }
          if (back.length) {
            localStorage.setItem("sleeping", JSON.stringify(this.sleeping));
            notify({ title: `${back.length === 1 ? back[0] : `${back.length} agents`} cut off by the restart`,
              body: `${back.length > 1 ? back.join(", ") + ". " : ""}Still in the list (zz): open them to resume their session.`, level: "info", timeout: 12000 });
          }
        }
      } catch {}
      this.recovered = true;
      this.trackRunning();
      cx.notify();
    });
  }

  // The command that brings it back: its same flags, without the old session or the prompt.
  resumeCmd(r) {
    const q = (x) => /^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`;
    if (r.kind === "codex") {
      // With the same flags it had (yolo mode, sandbox, model…).
      const CVAL = new Set(["-C", "--cd", "-i", "--image", "--local-provider", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile", "-c", "--config", "--add-dir", "--enable", "--disable"]);
      const out = ["codex"];
      if (r.session) out.push("resume");
      const argv = (r.argv ?? []).slice(1);
      for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (CVAL.has(x)) { out.push(x, argv[i + 1] ?? ""); i++; continue; }
        if (x.startsWith("-") && !["--last", "--all"].includes(x) && !out.includes(x)) out.push(x);
      }
      return [...out, ...(r.session ? [r.session] : [])].map(q).join(" ");
    }
    const VAL = new Set(["-n", "--name", "--teammate-mode", "--model", "--permission-mode", "--setting-sources", "--add-dir", "--agent", "--settings", "--mcp-config", "--fallback-model", "--append-system-prompt", "--system-prompt", "--effort"]);
    const SKIP_VAL = new Set(["--resume", "-r", "--session-id"]);
    const out = ["claude"];
    const argv = r.argv ?? [];
    for (let i = 1; i < argv.length; i++) {
      const x = argv[i];
      if (SKIP_VAL.has(x)) { i++; continue; }
      if (x === "--continue" || x === "-c") continue;
      if (VAL.has(x)) { out.push(x, argv[i + 1] ?? ""); i++; continue; }
      if (x.startsWith("-") && !out.includes(x)) out.push(x);
    }
    return [...out, ...(r.session ? ["--resume", r.session] : [])].map(q).join(" ");
  }

  wake(addr) {
    const r = this.sleeping[addr];
    if (!r) return;
    delete this.sleeping[addr];
    localStorage.setItem("sleeping", JSON.stringify(this.sleeping));
    // If the session left no conversation (never chatted), --resume can't find it: start from scratch.
    const check = r.kind === "claude-code" && r.session
      ? exec("sh", ["-c", `ls "$HOME"/.claude/projects/*/${r.session}.jsonl >/dev/null 2>&1`]).then((x) => x.code === 0)
      : Promise.resolve(true);
    check.then((ok) => exec("hc", ["send", addr, this.resumeCmd(ok ? r : { ...r, session: null })]));
  }

  // Sleeping agents as list rows, next to their project's.
  withSleeping(list) {
    const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
    const ps = new Set(panes().map((p) => p.pane));
    const out = [...list];
    for (const r of Object.values(this.sleeping)) {
      if (out.some((a) => a.address === r.addr) || !live.has(r.addr) || !ps.has(r.pane)) continue;
      const a = { address: r.addr, pane: r.pane, space: r.space, space_name: spaces().find((x) => x.id === r.space)?.name ?? r.space_name,
        program: r.program, seq: r.seq ?? 0, title: r.title, status: "sleep", focused: false, sleeping: true };
      let at = -1;
      out.forEach((x, i) => { if (x.space === a.space) at = i; });
      out.splice(at < 0 ? out.length : at + 1, 0, a);
    }
    return out;
  }

  // ✕ on an epic: it stops being an epic. Its branches now hang from the epic's base
  // (or are left without one) and the branch is deleted if it has no worktree and no
  // unmerged commits of its own (git branch -d, which loses nothing); otherwise it stays
  // as a plain branch. Asks for a second click to confirm.
  closeBtn(t, spaceId, b) {
    const sure = this.closing === b;
    return div().id(`close-${b}`).flex_none().px(5).h(18).rounded(4).flex().items_center().text_size(sure ? 10.5 : 12).font_semibold()
      .text_color(sure ? t.blocked : t.dim).when(sure, (el) => el.bg(`${t.blocked}22`)).cursor_pointer()
      .tooltip(sure ? "click again to close the epic" : "close the epic")
      .hover((s) => s.bg(`${t.blocked}33`).text_color(t.blocked))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!sure) { this.closing = b; cx.notify(); return; }
        this.closing = null;
        cx.spawn(async (cx) => this.closePedido(spaceId, b, cx));
      })
      .child(sure ? "close?" : "✕");
  }

  async closePedido(spaceId, b, cx) {
    const c = this.chains[spaceId];
    if (!c) return;
    const git = async (args) => { const r = await exec("git", args, { cwd: c.cwd, on: c.on }); return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() }; };
    const short = b.replace(prefixRe(), "");
    try {
      await git(["config", "--unset", `branch.${b}.herdrPedido`]);
      const up = c.base[b];
      for (const [k, v] of Object.entries(c.base)) {
        if (v !== b) continue;
        await git(up ? ["config", `branch.${k}.herdrBase`, up] : ["config", "--unset", `branch.${k}.herdrBase`]);
      }
      await git(["config", "--unset", `branch.${b}.herdrBase`]);
      await git(["config", "--unset", `branch.${b}.herdrFrom`]);
      const wt = (await git(["worktree", "list", "--porcelain"])).out.split("\n").includes(`branch refs/heads/${b}`);
      let note = "";
      if (wt) note = "The branch stays: it has a worktree.";
      else {
        const del = await git(["branch", "-d", b]);
        note = del.ok ? "The branch was deleted (nothing unmerged)." : "The branch stays: it has unmerged commits.";
      }
      notify({ title: `Request ${short} closed`, body: note, level: "info", timeout: 8000 });
    } catch (e) {
      notify({ title: `Couldn't close epic ${short}`, body: String(e), level: "error" });
    }
    setShared("herdr-mod.chains.at", Date.now());
    cx.notify();
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  // After the hc ones, its Claude teammates. They aren't
  // terminals: they live inside the agent's (shift+down arrow to see them).
  tree(all, addr, lead = []) {
    const program = all.find((x) => x.address === addr)?.program;
    const mates = (this.teams?.[addr] ?? []).map((m) => ({ address: `${addr}~${m.name}`, name: m.name, status: m.status, program, mate: m, lead: addr }));
    const kids = [...all.filter((k) => k.parent === addr && k.state === "live"), ...mates];
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...(k.mate ? [] : this.tree(all, k.address, [...lead, last ? "" : "│"])),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(k.mate), (el) => el.tooltip([k.mate.model, k.mate.task, ...(k.mate.recent ?? []).slice(0, 4).map((r) => `· ${r.text}`)].filter(Boolean).join("\n")))
      .on_click(() => {
        if (!k.mate) return this.peek(k.address);
        run("pane.focus", { terminal: k.lead });
        setShared("herdr-mod.tip", { items: [{ key: "⇧↓", text: "in Claude, switch between teammates" }], at: Date.now() });
      })
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().when(!k.mate, (el) => el.flex_1()).when(Boolean(k.mate), (el) => el.flex_none().mr(7)).truncate().text_color(k.mate ? (t[MATE_COLOR[k.mate.color]] ?? t.muted) : on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .when(Boolean(k.mate?.activity), (el) => el.child(div().flex_1().min_w(0).mr(6).truncate().text_size(10.5).text_color(k.mate.status === "working" ? t.muted : t.dim).child(k.mate.activity)))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "sleep") return div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child("zz");
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const PANES = panes(); // once per render: each call copies every pane
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = this.withSleeping(agents());
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.filter((a) => !a.sleeping).map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    // the worktree (the pane's live branch); the logo already says which agent it is.
    // If you named it (its tab's name: double-click or ✎), that one.
    const tabById = new Map(tabs.map((x) => [x.id, x]));
    const custom = (a) => (tabById.get(a.tab)?.named ? tabById.get(a.tab).name : null);
    // Otherwise the worktree's name (~/.herdr/worktrees/<repo>/<name>: the one you typed when
    // creating it), which doesn't change even if the agent moves to another branch (e.g. /pr creates feat/...).
    // Outside a worktree, the branch.
    const wtName = (a) => (PANES.find(p => p.pane === a.pane)?.cwd ?? "").match(/\/\.herdr\/worktrees\/[^/]+\/([^/]+)/)?.[1] ?? null;
    // If the branch is the worktree's (with / instead of -, like rv/PR-12), the branch, which reads better.
    const label = (a) => {
      const br = PANES.find(p => p.pane === a.pane)?.branch?.replace(prefixRe(), "");
      const wt = wtName(a);
      // The one you gave the Claude session with /rename (not one Claude made up) comes
      // before the worktree's.
      const st = this.lk?.[a.address];
      const sess = st?.name_source && st.name_source !== "derived" ? st.session_name : null;
      return custom(a) || sess || (wt && br && br.replace(/\//g, "-") === wt ? br : wt) || br || a.program?.name || a.title || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const branchOf = (a) => PANES.find((p) => p.pane === a.pane)?.branch;
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => { run("pane.focus", { pane: a.pane }); rowTip(a); })
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? `${a.space_name} \u00b7 ${label(a)}` : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click((e, cx) => {
          if (e.click_count === 2) return run("tab.rename", { id: a.tab }); // double-click: rename it
          if (a.sleeping) { this.wake(a.address); cx.notify(); }
          run("pane.focus", { pane: a.pane }); rowTip(a);
        })
        .when(a.sleeping, el => el.tooltip("Asleep (unused for 2 h). Click to wake it where it left off."))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(a.sleeping ? t.dim : idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`)))
          // If the name isn't the branch (you named it, or the agent switched branches), the branch next to it, small.
          .when(!full && Boolean(branchOf(a)) && ![branchOf(a).replace(prefixRe(), ""), branchOf(a).replace(prefixRe(), "").replace(/\//g, "-")].includes(label(a)), el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(branchOf(a).replace(prefixRe(), "")))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(!full && this.hovered === a.address && Boolean(branchOf(a)), el => el.child(this.plus(t, a.space, branchOf(a))))
        .when(!full && Boolean(branchOf(a)) && this.chains[a.space]?.pedidos?.has(branchOf(a)) && (this.hovered === a.address || this.closing === branchOf(a)),
          el => el.child(this.closeBtn(t, a.space, branchOf(a))))
        .children(this.loopTags(t, a))
        .when(!full, el => el.children(this.branchTags(t, a.space, branchOf(a))))
        .when(!full && !collapsed, el => this.draggable(el, t, { addr: a.address, b: branchOf(a), space: a.space }, `a:${a.address}`))
        .when(this.hovered === a.address && !a.sleeping, el => el.child(div().id(`rename-${a.address}`).flex_none().px(3).rounded(4).text_size(12).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Rename (or double-click). Empty: back to the branch name.")
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.rename", { id: a.tab }); }).child("✎")))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // in the per-project view, agents as a branch tree. Each
    // branch hangs from its base; a base without an agent (the epic) is grayed.
    const SHORT = (b) => (b ?? "").replace(prefixRe(), "");
    const issueN = (b) => Number((b.match(/IS-(\d+)/) ?? [])[1]) || 1e9;
    const treeOf = (g) => {
      const spaceId = g.id.slice(3), chain = this.chains[spaceId] ?? { base: {}, pedidos: new Set() };
      const nodes = new Map(), order = [];
      const node = (key, branch) => {
        if (!nodes.has(key)) { nodes.set(key, { key, branch, agents: [], kids: [] }); order.push(key); }
        return nodes.get(key);
      };
      // Requests first, even if nothing hangs from them yet.
      for (const p of [...chain.pedidos].sort((x, y) => issueN(x) - issueN(y))) node(`b:${p}`, p);
      for (const a of g.members) {
        const br = PANES.find((p) => p.pane === a.pane)?.branch;
        let n = node(br ? `b:${br}` : `a:${a.address}`, br);
        n.agents.push(a);
        // Walk up the bases so the tree isn't cut off.
        for (let b = br, seen = new Set(); b && chain.base[b] && !seen.has(b); b = chain.base[b]) { seen.add(b); node(`b:${chain.base[b]}`, chain.base[b]); }
      }
      for (const n of nodes.values()) {
        const parent = n.branch && chain.base[n.branch] && nodes.get(`b:${chain.base[n.branch]}`);
        if (parent) { n.parent = parent; parent.kids.push(n); }
      }
      for (const n of nodes.values()) n.kids.sort((x, y) => issueN(x.branch) - issueN(y.branch) || SHORT(x.branch).localeCompare(SHORT(y.branch)));
      const roots = order.map((k) => nodes.get(k)).filter((n) => !n.parent);
      const out = [];
      const walk = (n, prefix, last, depth) => {
        const own = depth === 0 ? [] : [last ? "elbow" : "tee"];
        const cont = depth === 0 ? [] : [last ? "blank" : "pipe"];
        const kidsCont = n.kids.length ? "pipe" : "blank";
        if (n.agents.length === 0) out.push({ ghost: n.branch, pedido: chain.pedidos.has(n.branch), prefix: [...prefix, ...own] });
        // sub: the indent for its sub-agents (hc run): one level deeper, and the
        // line continues if the branch has children below.
        n.agents.forEach((a, i) => out.push({ a, prefix: i === 0 ? [...prefix, ...own] : [...prefix, ...cont], sub: [...prefix, ...cont, kidsCont] }));
        n.kids.forEach((k, i) => walk(k, [...prefix, ...cont], i === n.kids.length - 1, depth + 1));
      };
      roots.forEach((r) => walk(r, [], true, 0));
      // Agents placed by hand inside another (view only): they go under it, one level in.
      const at = new Map(out.filter((e) => e.a).map((e) => [e.a.address, e]));
      const parentOf = (e) => {
        const p = e.a && this.parents[e.a.address];
        if (!p || !at.has(p)) return null;
        for (let x = p, seen = new Set([e.a.address]); x; x = this.parents[x]) { if (seen.has(x)) return null; seen.add(x); if (!at.has(x)) break; }
        return p;
      };
      if (!out.some(parentOf)) return out;
      const kidsOf = new Map();
      for (const e of out) { const p = parentOf(e); if (p) (kidsOf.get(p) ?? kidsOf.set(p, []).get(p)).push(e); }
      const res = [];
      const put = (e) => {
        res.push(e);
        const kids = e.a ? kidsOf.get(e.a.address) ?? [] : [];
        // If the branch has children below, its line continues: the child goes one column further in.
        if (!kids.length) return;
        const lane = e.sub.at(-1) === "blank" ? e.sub.slice(0, -1) : e.sub;
        kids.forEach((k, i) => {
          const last = i === kids.length - 1;
          put({ ...k, prefix: [...lane, last ? "elbow" : "tee"], sub: [...lane, last ? "blank" : "pipe", "blank"] });
        });
      };
      for (const e of out) if (!parentOf(e)) put(e);
      return res;
    };
    const LINE = t.dim;
    const connector = (kind, i) => {
      const box = div().w(14).h(30).flex_none().relative();
      if (kind === "blank") return box;
      const vert = div().absolute().left(6).top(0).w(1).h(kind === "elbow" ? 15 : 30).bg(LINE);
      const horiz = div().absolute().left(6).top(15).w(8).h(1).bg(LINE);
      return kind === "pipe" ? box.child(vert) : box.child(vert).child(horiz);
    };
    const prefixed = (prefix, el) => prefix.length === 0 ? el
      : h_flex().pl(8).flex_none().items_center().children(prefix.map(connector)).child(el.flex_1().min_w(0));
    const ghostRow = (e, spaceId) => h_flex().id(`ghost-${e.ghost}`).h(30).px(8).gap(7).flex_none().items_center().rounded(8)
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hovered = `b:${e.ghost}`; else { if (this.hovered === `b:${e.ghost}`) this.hovered = null; if (this.closing === e.ghost) this.closing = null; } cx.notify(); })
      .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim))
      .child(div().truncate().text_color(t.dim).child(SHORT(e.ghost)))
      .child(div().flex_1())
      .when(this.hovered === `b:${e.ghost}`, (el) => el.child(this.plus(t, spaceId, e.ghost)))
      .when(e.pedido && (this.hovered === `b:${e.ghost}` || this.closing === e.ghost), (el) => el.child(this.closeBtn(t, spaceId, e.ghost)))
      .children(this.branchTags(t, spaceId, e.ghost))
      .when(true, (el) => this.draggable(el, t, { b: e.ghost, space: spaceId }, `b:${e.ghost}`));

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      // a line above each project (except the first) to see where it starts.
      const first = groups[0]?.id === g.id;
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        // the project name clearly visible.
        .text_size(12.5)
        .font_semibold()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .when(g.id.startsWith("sp-"), (el) => el
          .on_mouse_move((_e, cx) => this.dragOver(null, cx))
          .on_mouse_up("left", (_e, cx) => this.dropOn(null, cx))
          .when(Boolean(this.drag?.moving) && this.drag.over === null && this.drag.space === g.id.slice(3) && this.canDrop(this.drag, null),
            (el) => el.rounded(6).bg(`${t.accent}33`).child(div().text_size(10.5).text_color(t.accent)
              .child(this.drag.addr && this.parents[this.drag.addr] ? "drop: take it out" : "drop: no base"))))
        .when(!first, (el) => el.mt(8).border_t(1).border_color(t.border).pt(14).h(38))
        .child(div().truncate().text_color(t[g.status] ?? (byPriority ? t.muted : t.foreground)).child(g.label))
        .when(g.id.startsWith("sp-") && g.members.some((a) => !a.sleeping) && g.members.filter((a) => !a.sleeping).every((a) => this.lk?.[a.address]?.missing),
          (el) => el.child(div().id(`nolk-${g.id}`).flex_none().px(5).rounded(4).text_size(10).font_medium().bg(t.raised).text_color(t.muted)
            .tooltip("Reported by an agentes.py extension").child(this.lk?.[g.members.find((a) => !a.sleeping)?.address]?.missing ?? "")))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const asTree = (g) => !byPriority && g.id.startsWith("sp-");
    const trees = new Map(groups.filter(asTree).map((g) => [g.id, treeOf(g)]));
    // ⌘] / ⌘[ follow the tree order.
    // Each agent's name, so the footer, ⌘J, ⌘K and Team say the same.
    const names = Object.fromEntries(list.map((a) => [a.address, label(a)]));
    const namesJson = JSON.stringify(names);
    if (namesJson !== this.namesJson) { this.namesJson = namesJson; this.names = names; setShared("herdr-mod.names", names); }
    if (!byPriority && !collapsed) setAgentOrder(groups.flatMap((g) => trees.has(g.id) ? trees.get(g.id).filter((e) => e.a && !e.a.sleeping).map((e) => e.a.address) : g.members.map((a) => a.address)));
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : trees.has(g.id)
          ? trees.get(g.id).flatMap((e, i) => e.a ? withKids(e.a, i).map((r, j) => j === 0 ? prefixed(e.prefix, r) : prefixed(e.sub, r.pl(10))) : [prefixed(e.prefix, ghostRow(e, g.id.slice(3)))])
          : g.members.flatMap(withKids))]);

    return v_flex()
      .id("agents-root")
      // Dropping outside a branch, or leaving the list, cancels the drag.
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_hover((on, cx) => { if (!on && this.drag) { this.drag = null; cx.notify(); } })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "herdr-mod", kind: "popup", width: 200, height: 140, props: { role: "agents", sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .child(
        h_flex()
          .h(28)
          .px(12)
          .items_center()
          .justify_end()
          .when(collapsed, (el) => el.justify_center().px(0))
          .child(
            div()
              .id("collapse")
              .text_size(13)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click(toggleSidebar)
              .child(collapsed ? "»" : ""),
          ),
      );
  }
}
