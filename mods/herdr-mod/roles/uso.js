// Usage. Two forms:
// - props.bar: the whole bottom bar (replaces workspace-status). On the left, the
//   focused project › agent; then the agents that need an answer from you (asking for
//   permission or a question, or waiting for your go); on the right,
//   how much Claude and Codex have left, CPU and RAM. Click on those opens the full panel.
// - the full panel, as a centered dialog (openOverlay with props.tab). Two tabs:
// - Accounts: for Claude Code and Codex, the account (email, plan), how much is left
//   in each window (5 h, week), when it resets and how fast it's going; plus today's
//   and 7-day usage (tokens, estimated cost, cache, turns, sessions, per day, per
//   model, per project). Ideas from Orca. limits.py (every 30 s) reads what
//   ~/.claude/statusline.sh, ~/.codex and the accounts store; usage.py (every 60 s)
//   reads both tools' local logs.
// - System: CPU, RAM, disk, load, battery, GPU and top consumers, for this Mac and
//   each remote Herdr machine (machines()): stats.sh runs there via
//   exec(..., { on }). Every 5 s, only while the tab is visible.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, machines, theme, props, openOverlay, run, window, shared, setShared, spaces, panes, focused, terminals, agents } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
// Stop a running review: a Codex plugin job is cancelled with its own /codex:cancel
// (interrupts the Codex turn too); anything else gets a kill.
const stopReview = (rv) => rv.stop ? exec(rv.stop[0], rv.stop.slice(1)) : exec("kill", [String(rv.pid)]);
const localStorage = scoped("uso");

// /pr-review and /pr-fix are skills (if you have them). Without them (shared "herdr-mod.skills",
// checked by the agents role), the agent gets a plain request that does the same by hand.
const hasSkill = (s) => Boolean(shared("herdr-mod.skills")?.[s]);
const prAsk = (kind, n, repo) => kind === "fix"
  ? (hasSkill("pr-fix") ? `/pr-fix ${n}` : `Address the review comments on PR #${n}${repo ? ` in ${repo}` : ""}: read them with gh, validate each one against the code, propose the change and the reply, and wait for my ok before committing, pushing or replying on GitHub.`)
  : (hasSkill("pr-review") ? `/pr-review ${n}` : `Review PR #${n}${repo ? ` in ${repo}` : ""}: summary, issues (file:line, severity, how to fix) and the comments you'd leave. Don't post anything on GitHub without my ok.`);
const prLabel = (kind) => kind === "fix" ? (hasSkill("pr-fix") ? "/pr-fix" : "fix") : (hasSkill("pr-review") ? "/pr-review" : "review");

// Font size: small in the bar; larger in the panel (dialog) for comfortable reading.
let SCALE = 1;
const fs = (x) => Math.round(x * SCALE * 10) / 10;
const DIR = () => `${home()}/.config/herdr-app/mods/herdr-mod/scripts`;
const GB = (b) => `${(b / 1073741824).toFixed(b >= 107374182400 ? 0 : 1)} GB`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// When it resets: time if today, otherwise day and time.
function when(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}
const ago = (ms) => {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};
const uptime = (s) => s >= 86400 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 3600)}h`;
// Time left: "4d 2h", "3h 10m", "25m".
const left = (sec) => {
  const s = Math.max(0, sec - Date.now() / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
// Short token counts: 940, 12k, 161M, 2.2B.
const tok = (n) => {
  const f = (x, u) => `${(x >= 100 ? Math.round(x) : x.toFixed(1)).toString()}${u}`;
  return n >= 1e9 ? f(n / 1e9, "B") : n >= 1e6 ? f(n / 1e6, "M") : n >= 1e3 ? f(n / 1e3, "k") : String(n);
};
const usd = (n) => `$${n >= 100 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : n.toFixed(2)}`;
// Claude limits from Anthropic's usage API (like Orca): the 5 h window, the week,
// per-model weeks (Fable) and extra usage, which Claude's status line doesn't pass.
// Only the bottom bar queries it (every 5 min) and leaves the result, without
// credentials, in shared("herdr-mod.claude-usage").
// The login comes from the Keychain ("Claude Code-credentials") and lives only in this
// mod's memory: it's re-read only if it expired or the API rejects it. Never on disk.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const secOf = (v) => (typeof v === "number" ? (v > 1e12 ? v / 1000 : v) : v ? Date.parse(v) / 1000 : null);
function claudeWindows(r) {
  const w = (label, x, minutes) => {
    const used = typeof x?.utilization === "number" ? x.utilization : typeof x?.used_percentage === "number" ? x.used_percentage : typeof x?.percent === "number" ? x.percent : null;
    return used == null ? null : { label, used: Math.min(100, Math.max(0, used)), resets_at: secOf(x.resets_at), minutes };
  };
  const scoped = (Array.isArray(r.limits) ? r.limits : [])
    .filter((l) => l?.kind === "weekly_scoped" && Number.isFinite(l.percent) && l.scope?.model?.display_name)
    .map((l) => w(l.scope.model.display_name, l, 10080));
  return [w("5 h", r.five_hour, 300), w("week", r.seven_day, 10080), ...scoped].filter(Boolean);
}
function extraOf(r) {
  const e = r.extra_usage;
  if (!e) return null;
  const k = 10 ** (e.decimal_places ?? 2);
  const spent = e.used_credits != null ? e.used_credits / k : null, limit = e.monthly_limit != null ? e.monthly_limit / k : null;
  return { enabled: e.is_enabled === true, spent, limit, currency: e.currency || "USD", pct: typeof e.utilization === "number" ? e.utilization : spent != null && limit ? (100 * spent) / limit : null };
}

// Fable within a Claude summary: its tokens, its cost and its share of Claude's cost.
function fableOf(s) {
  const ms = (s?.models ?? []).filter((m) => /fable/i.test(m.model));
  if (!ms.length) return null;
  const tokens = ms.reduce((a, m) => a + m.tokens, 0), cost = ms.reduce((a, m) => a + m.cost, 0);
  return { tokens, cost, share: s.cost ? Math.round((100 * cost) / s.cost) : null };
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => { const d = new Date(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
// Pace: given usage so far in the window, will it last or run out before it resets?
function pace(w) {
  if (!w.minutes || !w.resets_at || w.used == null) return null;
  const now = Date.now() / 1000, len = w.minutes * 60, elapsed = len - (w.resets_at - now);
  if (w.used >= 99.5) return { bad: true, text: `exhausted until ${when(w.resets_at)}` };
  if (elapsed < len * 0.03 || w.used <= 0) return null;
  const rate = w.used / elapsed, projected = w.used + rate * (w.resets_at - now);
  if (projected >= 100) return { bad: true, text: `at this pace it runs out ${when(now + (100 - w.used) / rate)}` };
  return { bad: false, text: `at this pace you'll reach ${Math.round(projected)}%` };
}

export default class Uso extends View {
  init(_props, cx) {
    this.tab = props()?.tab ?? localStorage.getItem("tab") ?? "limites"; // "limites" (Accounts) | "sistema" (System)
    this.limits = null;
    this.usage = null;
    this.stats = {};
    this.script = null;
    this.loadLimits(cx);
    if (props()?.bar) {
      // The bar: limits every 30 s and this Mac every 10 s (stats.sh takes ~2 s).
      cx.timer.every(30000, (cx) => this.loadLimits(cx));
      this.loadUsage(cx);
      cx.timer.every(60000, (cx) => this.loadUsage(cx));
      this.loadClaudeApi(cx);
      cx.timer.every(300000, (cx) => this.loadClaudeApi(cx));
      this.loadStats(cx, true);
      cx.timer.every(10000, (cx) => this.loadStats(cx, true));
      // Agent state and alerts change in shared: re-render as soon as they do.
      cx.timer.every(1500, (cx) => {
        const now = JSON.stringify([shared("herdr-mod.estado"), shared("herdr-mod.alerts"), focused()?.agent, agents().map((a) => [a.address, a.status])]);
        if (now !== this.lastLoop) { this.lastLoop = now; cx.notify(); }
      });
      return;
    }
    this.more = new Set(JSON.parse(localStorage.getItem("more") ?? "[]")); // services with details expanded
    if (this.tab === "sistema") this.loadStats(cx);
    this.loadUsage(cx);
    cx.timer.every(60000, (cx) => this.loadUsage(cx));
    // this.stats: machine ("" = this one) -> { data, error, at }
    cx.timer.every(30000, (cx) => this.loadLimits(cx));
    cx.timer.every(5000, (cx) => { if (this.tab === "sistema") this.loadStats(cx); });
  }

  loadLimits(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${DIR()}/limits.py`]);
        this.limits = JSON.parse(r.stdout || "{}");
      } catch { this.limits = {}; }
      cx.notify();
    });
  }

  async claudeToken(force) {
    if (!force && this.token && (!this.tokenExp || Date.now() < this.tokenExp - 60000)) return this.token;
    this.token = null;
    const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    if (r.code !== 0) return null;
    try {
      const o = JSON.parse(r.stdout).claudeAiOauth ?? {};
      this.token = o.accessToken ?? null;
      this.tokenExp = o.expiresAt ?? null;
    } catch { this.token = null; }
    return this.token;
  }

  loadClaudeApi(cx) {
    if (this.loadingApi) return;
    this.loadingApi = true;
    cx.spawn(async (cx) => {
      let error = null;
      try {
        for (const force of [false, true]) {
          const token = await this.claudeToken(force);
          if (!token) { error = "couldn't read the Claude login from the Keychain"; break; }
          const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" } });
          if (res.status === 401 || res.status === 403) { this.token = null; error = "the login expired"; continue; }
          if (!res.ok) { error = `the API returned ${res.status}`; break; }
          const r = await res.json();
          setShared("herdr-mod.claude-usage", { at: Date.now(), windows: claudeWindows(r), extra: extraOf(r) });
          error = null;
          break;
        }
      } catch { error = "can't reach the API"; }
      if (error) setShared("herdr-mod.claude-usage", { ...(shared("herdr-mod.claude-usage") ?? {}), error, errorAt: Date.now() });
      this.loadingApi = false;
      cx.notify();
    });
  }

  // Claude: API data if recent (≤ 15 min); otherwise what the status line saved.
  claude() {
    const base = this.limits?.claude ?? {};
    const api = shared("herdr-mod.claude-usage");
    if (api?.windows?.length && Date.now() - api.at < 900000) return { ...base, at: api.at, windows: api.windows, extra: api.extra, apiError: null };
    return { ...base, apiError: api?.error ?? null };
  }

  loadUsage(cx) {
    if (this.loadingUsage) return;
    this.loadingUsage = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${DIR()}/usage.py`]);
        if (r.code === 0) this.usage = JSON.parse(r.stdout || "{}");
      } catch {}
      this.loadingUsage = false;
      cx.notify();
    });
  }

  loadStats(cx, onlyHere = false) {
    if (this.loadingStats) return;
    this.loadingStats = true;
    cx.spawn(async (cx) => {
      try {
        this.script ??= (await exec("cat", [`${DIR()}/stats.sh`])).stdout;
        const list = onlyHere ? [null] : [null, ...machines().map((m) => m.name).filter(Boolean)];
        await Promise.all(list.map(async (name) => {
          const key = name ?? "";
          try {
            const r = await exec("sh", ["-c", this.script], name ? { on: name } : {});
            this.stats[key] = r.code === 0 ? { data: JSON.parse(r.stdout), at: Date.now() } : { ...this.stats[key], error: (r.stderr || "failed").trim() };
          } catch (e) { this.stats[key] = { ...this.stats[key], error: String(e).slice(0, 120) }; }
        }));
        for (const k of Object.keys(this.stats)) if (k && !list.includes(k)) delete this.stats[k];
      } catch {}
      this.loadingStats = false;
      cx.notify();
    });
  }

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("tab", tab);
    if (tab === "sistema") this.loadStats(cx);
    cx.notify();
  }

  // The bottom bar: logo and % free for each (red if it runs out at this pace), CPU and RAM.
  renderBar(t) {
    const level = (p) => (p >= 80 ? t.blocked : p >= 50 ? t.ansi3 : t.ansi2);
    const open = (tab) => () => openOverlay({ mod: "herdr-mod", kind: "dialog", width: 1280, height: 900, props: { role: "uso", tab } });
    const acct = (id, icon) => {
      const ws = (id === "claude" ? this.claude().windows : this.limits?.[id]?.windows ?? [])?.filter((w) => !/fable/i.test(w.label)) ?? [];
      if (!ws.length) return null;
      const worst = ws.reduce((m, w) => (w.used > m.used ? w : m));
      const bad = ws.map(pace).find((p) => p?.bad);
      const tip = ws.map((w) => `${w.label}: ${Math.round(100 - w.used)}% free, resets ${when(w.resets_at)}${pace(w) ? ` (${pace(w).text})` : ""}`).join("\n");
      return h_flex().id(`bar-${id}`).gap(4).items_center().tooltip(tip)
        .child(image(icon).size(12))
        .child(div().font_semibold().text_color(level(worst.used)).child(`${Math.round(100 - worst.used)}%`))
        .when(Boolean(bad), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
    };
    // Fable: share of this week's Claude cost spent on Fable (it has no limit of its own).
    const fableBar = () => {
      const fw = this.claude().windows?.find((w) => /fable/i.test(w.label));
      if (fw) {
        const p = pace(fw);
        return h_flex().id("bar-fable").gap(4).items_center()
          .tooltip(`Fable, week: ${Math.round(100 - fw.used)}% free, resets ${when(fw.resets_at)}${p ? ` (${p.text})` : ""}`)
          .child(div().text_color(t.ansi5).font_semibold().child("Fable"))
          .child(div().font_semibold().text_color(level(fw.used)).child(`${Math.round(100 - fw.used)}%`))
          .when(Boolean(p?.bad), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
      }
      const f = fableOf(this.usage?.claude?.week), ft = fableOf(this.usage?.claude?.today);
      if (!f) return null;
      return h_flex().id("bar-fable").gap(4).items_center()
        .tooltip(`Fable, 7 days: ${tok(f.tokens)} tok · ${usd(f.cost)}${f.share != null ? ` · ${f.share}% of Claude's cost` : ""}${ft ? `\ntoday: ${tok(ft.tokens)} tok · ${usd(ft.cost)}` : ""}\nClaude doesn't report a separate Fable limit.`)
        .child(div().text_color(t.ansi5).font_semibold().child("Fable"))
        .child(div().text_color(t.foreground).child(f.share != null ? `${f.share}%` : tok(f.tokens)));
    };
    const here = this.stats[""]?.data;
    // In the middle: which project and agent I'm talking to, highlighted.
    const f = focused();
    const space = spaces().find((x) => x.id === f?.space) ?? spaces().find((x) => x.active);
    const pane = panes().find((p) => p.pane === f?.pane) ?? panes().find((p) => p.focused);
    const prog = terminals().find((k) => k.address === (f?.agent ?? pane?.terminal))?.program ?? pane?.program;
    const where = shared("herdr-mod.names")?.[f?.agent ?? pane?.terminal] || pane?.branch?.replace(prefixRe(), "");
    const fg = t.accent_foreground ?? t.background;
    const here_ = h_flex().gap(8).items_center().px(14).h(26).rounded(8).bg(t.accent)
      .when(Boolean(prog?.icon), (el) => el.child(div().size(18).rounded(5).bg(t.background).flex().items_center().justify_center()
        .child(prog.tint ? svg(prog.icon).size(12).text_color(t.foreground) : image(prog.icon).size(12))))
      .child(div().text_size(14.5).font_bold().text_color(fg).child(space?.name ?? ""))
      .when(Boolean(where), (el) => el.child(div().text_size(14.5).text_color(fg).opacity(0.7).child("›")).child(div().text_size(14.5).font_semibold().text_color(fg).child(where)));
    // Right of the project: the focused agent's stage and what needs attention.
    const loop = this.loopFeedback(t, f?.agent ?? pane?.terminal);
    const waiting = this.waitingBar(t, f?.agent ?? pane?.terminal);
    // Each block in its own box, so the bar doesn't read as one flat line.
    const box = (el) => el.h(26).px(10).rounded(7).bg(t.raised ?? t.hover).border_1().border_color(t.border);
    const sep = () => div().w(1).h(18).flex_none().bg(t.border);
    const usage = h_flex().flex_none().gap(8).items_center()
      .child(box(h_flex().id("bar-cuentas").gap(10).items_center()).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_up("left", (e) => open("limites")(e))
        .children([acct("claude", "icons/claude.svg"), fableBar(), acct("codex", "icons/codex.svg")].filter(Boolean))
        .when(!this.limits?.claude?.windows?.length && !this.limits?.codex?.windows?.length, (el) => el.child("accounts")))
      .child(box(h_flex().id("bar-sistema").gap(8).items_center()).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_up("left", (e) => open("sistema")(e))
        .child(div().text_color(t.muted).child("CPU"))
        .child(div().text_color(here ? level(here.cpu) : t.dim).child(here ? `${Math.round(here.cpu)}%` : "…"))
        .child(div().text_color(t.muted).child("RAM"))
        .child(div().text_color(here ? level((100 * here.mem_used) / here.mem_total) : t.dim)
          .child(here ? `${Math.round((100 * here.mem_used) / here.mem_total)}%` : "…")));
    return h_flex().size_full().px(10).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(fs(11.5)).text_color(t.muted)
      .child(h_flex().flex_none().max_w(700).gap(10).items_center().child(here_).children(loop))
      .child(sep())
      .child(h_flex().id("bar-waiting").flex_1().min_w(0).gap(6).items_center().justify_center().overflow_x_hidden()
        .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).mr(2).child(waiting.length ? "WAITING ON YOU" : "No one is waiting on you"))
        .children(waiting))
      .child(sep())
      .child(usage);
  }

  // Agents that need an answer from you, one chip each: asking for permission or a
  // question ("Needs you"), or done with a stage and waiting for your go (an extension's
  // "next"). Just finishing a turn doesn't count. Oldest first; the focused one is left out.
  waitingBar(t, focusedAddr) {
    const lk = shared("herdr-mod.estado") ?? {};
    const names = shared("herdr-mod.names") ?? {};
    const since = new Map(terminals().map((k) => [k.address, k.status_ms ?? 0]));
    const list = agents().filter((a) => a.address !== focusedAddr && (a.status === "blocked" || (a.status !== "working" && lk[a.address]?.next)))
      .sort((x, y) => (x.status === "blocked" ? 0 : 1) - (y.status === "blocked" ? 0 : 1) || (since.get(x.address) ?? 0) - (since.get(y.address) ?? 0));
    return list.map((a) => {
      const blocked = a.status === "blocked", c = blocked ? t.blocked : t.accent;
      const pane = panes().find((p) => p.pane === a.pane);
      const space = spaces().find((s) => s.id === a.space);
      const name = names[a.address] || pane?.branch?.replace(prefixRe(), "") || a.address;
      const prog = terminals().find((k) => k.address === a.address)?.program;
      const m = since.get(a.address) ? Math.floor((Date.now() - since.get(a.address)) / 60000) : 0;
      return h_flex().id(`wait-${a.address}`).flex_none().h(24).px(8).gap(5).rounded(6).items_center().cursor_pointer()
        .bg(`${c}22`).border_1().border_color(`${c}66`).hover((s) => s.bg(`${c}44`))
        .tooltip([`${space?.name ?? ""} › ${name}`, blocked ? "asking you something" : `waiting for your go on ${lk[a.address].next}`, m ? `for ${m} min` : null].filter(Boolean).join("\n"))
        .on_click(() => run("agent.focus", { terminal: a.address }))
        .when(Boolean(prog?.icon), (el) => el.child(prog.tint ? svg(prog.icon).size(12).text_color(t.foreground) : image(prog.icon).size(12)))
        .child(div().max_w(160).truncate().font_semibold().text_color(t.foreground).child(name))
        .child(div().font_bold().text_color(c).child(blocked ? "!" : "go?"));
    });
  }

  // Agent state in the bar: stage and activity of the focused agent, a running
  // review (stop it), whether it's waiting for go (send it), and how many alerts the
  // others have (opens ⌘J). If an extension reports something missing (st.missing), show just that.
  loopFeedback(t, addr) {
    const lk = shared("herdr-mod.estado") ?? {};
    const alerts = shared("herdr-mod.alerts") ?? [];
    const st = addr ? lk[addr] : null;
    const out = [];
    const btn = (id, label, color, action) => div().id(id).px(7).h(20).rounded(5).flex().items_center().cursor_pointer()
      .text_size(11.5).font_semibold().bg(`${color}33`).text_color(color).hover((s) => s.bg(`${color}55`))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);
    if (st && !st.missing) {
      if (st.stage) {
        const c = /^(design|spec|tickets|split)/.test(st.stage) ? t.ansi4 : /^(impl|fix|small|refactor)/.test(st.stage) ? t.ansi3 : /^pr/.test(st.stage) ? t.ansi2 : t.muted;
        out.push(div().px(7).h(20).rounded(5).flex().items_center().text_size(12).font_bold().bg(`${c}33`).text_color(c)
          .child(`${st.size ? `${st.size} · ` : ""}/${st.stage}`));
      }
    }
    if (st?.review) {
      const m = Math.floor(st.review.secs / 60), c = st.review.secs >= 1200 ? t.blocked : st.review.secs >= 600 ? t.ansi3 : t.muted;
      out.push(div().text_size(12).font_semibold().text_color(c).child(`${st.review.tool} ${st.review.kind ?? "review"} ${m}m`));
      if (st.review.secs >= 600) out.push(btn("cut-review", "stop", t.blocked, () => stopReview(st.review)));
    }
    if (st?.next) {
      out.push(div().text_size(12).text_color(t.accent).child(`waiting for go → ${st.next}`));
      out.push(btn("send-go", "go", t.accent, () => exec("hc", ["send", addr, "go"])));
    }
    const pr = alerts.find((a) => a.kind === "pr" && a.addr === addr);
    if (pr) out.push(btn("pr-fix", `PR #${pr.number}: ${pr.what} → ${prLabel("fix")}`, t.ansi5, () => exec("hc", ["send", addr, prAsk("fix", pr.number, pr.repo)])));
    // The other agents: how many alerts; ⌘J lists them.
    const rest = alerts.filter((a) => a.addr !== addr && a.kind !== "pr" && a.kind !== "rr");
    if (rest.length) {
      const bad = rest.some((a) => a.kind === "review" && a.hung);
      out.push(btn("alerts", `⚠ ${rest.length} alert${rest.length > 1 ? "s" : ""}`, bad ? t.blocked : t.ansi3, () => openOverlay({ mod: "herdr-mod", kind: "dialog", width: 900, height: 620 , props: { role: "waiting" } })));
    }
    return out;
  }

  render(cx) {
    const t = theme();
    SCALE = props()?.bar ? 1 : 1.25;
    if (props()?.bar) return this.renderBar(t);
    const level = (p) => (p >= 80 ? t.blocked : p >= 50 ? t.ansi3 : t.ansi2);
    const bar = (p, color = level(p), h = 8) => div().h(h).w_full().rounded(h / 2).bg(t.border)
      .child(div().h(h).rounded(h / 2).bg(color).w(`${Math.max(2, Math.min(100, p))}%`));
    const caps = (text) => div().text_size(11).font_semibold().text_color(t.muted).child(text.toUpperCase());
    const tile = () => v_flex().flex_1().min_w(0).p(12).gap(6).rounded(10).bg(t.raised);
    const MODEL_COLOR = (m) => /fable/i.test(m) ? t.ansi5 : /opus/i.test(m) ? t.ansi3 : /sonnet/i.test(m) ? t.ansi4 : /haiku/i.test(m) ? t.ansi2 : /luna/i.test(m) ? t.ansi2 : /astra/i.test(m) ? t.ansi4 : t.ansi6;
    const modelName = (m) => m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1");

    const segment = (id, label) => div().id(`uso-${id}`).px(14).py(5).rounded(7).cursor_pointer().text_size(13).font_semibold()
      .bg(this.tab === id ? t.selected : t.raised).text_color(this.tab === id ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setTab(id, cx)).child(label);

    // --- Accounts ---
    // One limit: how much is left (large), its bar, when it resets and its pace.
    const limitTile = (w) => {
      const p = pace(w), free = Math.round(100 - w.used);
      return tile().min_w(150)
        .child(caps(w.label))
        .child(h_flex().gap(5).items_end()
          .child(div().text_size(28).font_bold().text_color(level(w.used)).child(`${free}%`))
          .child(div().pb(5).text_size(12.5).text_color(t.muted).child("free")))
        .child(bar(w.used))
        .child(div().text_size(12).text_color(t.muted).child(w.resets_at ? `↻ ${when(w.resets_at)} · in ${left(w.resets_at)}` : ""))
        .child(div().h(16).text_size(12).font_medium().text_color(p?.bad ? t.blocked : t.ansi2).child(p?.text ?? ""));
    };
    // Usage over a period, at API prices (or in tokens, unpriced).
    const spendTile = (label, s, priced, note) => tile()
      .child(caps(label))
      .child(div().text_size(22).font_bold().text_color(t.foreground)
        .child(priced ? `${usd(s.cost)}${s.unpriced ? "+" : ""}` : `${tok(s.total)}`))
      .child(div().text_size(12).text_color(t.muted)
        .child([priced ? `${tok(s.total)} tok` : "tokens", s.turns ? `${s.turns} turns` : null].filter(Boolean).join(" · ")))
      .child(div().h(16).text_size(12).font_medium().text_color(t.accent).child(note ?? ""));
    const monthNote = (m, priced) => {
      if (m.days >= m.month_len) return "last day of the month";
      return priced && m.projected_cost != null ? `month end ~${usd(m.projected_cost)}` : m.projected_total != null ? `month end ~${tok(m.projected_total)} tok` : null;
    };
    // Which models the week's usage came from: a split bar and its legend.
    const split = (models, priced) => {
      const key = priced ? "cost" : "tokens";
      const total = models.reduce((a, m) => a + (m[key] || 0), 0);
      if (!total) return null;
      const parts = models.filter((m) => m[key] > 0).map((m) => ({ ...m, pct: (100 * m[key]) / total }));
      return v_flex().gap(8)
        .child(h_flex().h(10).w_full().rounded(5).overflow_hidden().children(parts.map((m) => div().h(10).bg(MODEL_COLOR(m.model)).w(`${m.pct}%`))))
        .child(h_flex().flex_wrap().gap_x(14).gap_y(4).children(parts.map((m) => h_flex().gap(6).items_center().text_size(12.5)
          .child(div().size(9).rounded(3).bg(MODEL_COLOR(m.model)))
          .child(div().text_color(t.foreground).child(modelName(m.model)))
          .child(div().text_color(t.muted).child(`${Math.round(m.pct)}%${priced ? ` · ${usd(m.cost)}` : ` · ${tok(m.tokens)}`}`)))));
    };
    // The last 7 days: one bar per day, with the highest and today's value on top.
    const days = (daily, key) => {
      const max = Math.max(...daily.map((d) => d[key] || 0), 1);
      const L = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const fmt = (v) => (key === "cost" ? usd(v) : tok(v));
      return h_flex().h(104).gap(8).items_end()
        .children(daily.map((d, i) => {
          const v = d[key] || 0, today = i === daily.length - 1;
          return v_flex().id(`day-${key}-${d.day}`).flex_1().h_full().justify_end().items_center().gap(4)
            .tooltip(`${d.day.slice(5, 7)}/${d.day.slice(8)}: ${fmt(v)}${key === "cost" ? ` · ${tok(d.total)} tok` : ""}`)
            .when(today || v === max, (el) => el.child(div().text_size(11).text_color(today ? t.accent : t.muted).child(v ? fmt(v) : "")))
            .child(div().w_full().rounded(4).bg(today ? t.accent : `${t.foreground}40`).h(Math.max(2, Math.round(64 * v / max))))
            .child(div().text_size(11.5).text_color(today ? t.foreground : t.muted).child(L[new Date(`${d.day}T12:00:00`).getDay()]));
        }));
    };
    const projects = (u) => {
      const max = Math.max(...u.week.projects.map((p) => p.tokens), 1);
      return v_flex().gap(6).children(u.week.projects.map((p) => h_flex().gap(10).items_center().text_size(12.5)
        .child(div().w(150).flex_none().truncate().text_color(t.foreground).child(p.name))
        .child(div().flex_1().child(bar((100 * p.tokens) / max, `${t.accent}aa`, 6)))
        .child(div().w(56).flex_none().text_right().text_color(t.muted).child(tok(p.tokens)))));
    };
    const service = (id, icon, name, d, u, priced) => {
      const acc = d?.account ?? {};
      const open = this.more.has(id);
      const meta = [acc.email, acc.extra ? "extra usage on" : null, acc.until ? `plan until ${shortDate(acc.until)}` : null, d?.at ? `updated ${ago(d.at)}` : null].filter(Boolean).join(" · ");
      return v_flex().p(16).gap(14).rounded(12).bg(t.background).border(1).border_color(t.border)
        .child(v_flex().gap(3)
          .child(h_flex().gap(8).items_center()
            .child(image(icon).size(20))
            .child(div().text_size(17).font_bold().text_color(t.foreground).child(name))
            .when(Boolean(acc.plan ?? d?.plan), (el) => el.child(div().px(7).py(1).rounded(5).text_size(12).font_semibold().bg(`${t.accent}26`).text_color(t.accent).child(acc.plan ?? d.plan))))
          .when(Boolean(meta), (el) => el.child(div().text_size(12).text_color(t.muted).child(meta))))
        .when(Boolean(d?.apiError), (el) => el.child(div().text_size(12).text_color(t.ansi3).child(`limits from the status line (${d.apiError})`)))
        .child(d?.windows?.length
          ? h_flex().gap(10).flex_wrap().items_start().children(d.windows.map(limitTile))
          : div().text_size(13).text_color(t.muted).child(id === "claude" ? "No limits yet: they show up next time Claude is open." : "No limits: they show up after using Codex."))
        .when(Boolean(d?.extra?.enabled && d.extra.spent != null), (el) => el.child(h_flex().gap(8).text_size(13)
          .child(caps("extra usage"))
          .child(div().text_color(t.foreground).child(`${d.extra.currency === "USD" ? "$" : `${d.extra.currency} `}${d.extra.spent.toFixed(2)}${d.extra.limit ? ` of ${d.extra.limit.toFixed(0)}` : ""} this month`))))
        .when(Boolean(u), (el) => el
          .child(v_flex().gap(8)
            .child(caps(priced ? "if paid at API prices" : "usage in tokens (unpriced)"))
            .child(h_flex().gap(10).items_start()
              .child(spendTile("Today", u.today, priced))
              .child(spendTile("7 days", u.week, priced))
              .when(Boolean(u.month), (el) => el.child(spendTile(`${MONTHS[Number(u.month.name) - 1]} (month)`, u.month, priced, monthNote(u.month, priced))))))
          .when(Boolean(split(u.week.models, priced)), (el) => el.child(v_flex().gap(8).child(caps("by model · 7 days")).child(split(u.week.models, priced))))
          .child(v_flex().gap(8).child(caps(priced ? "by day · cost" : "by day · tokens")).child(days(u.daily, priced ? "cost" : "total")))
          .child(div().id(`more-${id}`).text_size(13).font_semibold().text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { open ? this.more.delete(id) : this.more.add(id); localStorage.setItem("more", JSON.stringify([...this.more])); cx.notify(); })
            .child(open ? "less ▾" : "by project and cache ▸"))
          .when(open, (el) => el.child(v_flex().gap(8)
            .child(caps("by project · 7 days"))
            .child(projects(u))
            .when(u.week.cache_rate != null, (el) => el.child(div().text_size(12.5).text_color(t.muted)
              .child(`${u.week.cache_rate}% of the prompt came from cache · ${u.week.sessions} sessions`))))));
    };
    // Claude and Codex side by side: everything fits without scrolling.
    const limites = () => v_flex().gap(14)
      .child(h_flex().gap(14).items_start()
        .child(div().flex_1().min_w(0).child(service("claude", "icons/claude.svg", "Claude Code", this.claude(), this.usage?.claude, true)))
        .child(div().flex_1().min_w(0).child(service("codex", "icons/codex.svg", "Codex", this.limits?.codex, this.usage?.codex, false))))
      .child(div().text_size(12).text_color(t.muted)
        .child("Cost is what those tokens would cost at API prices (Orca's table), to compare with your plan: a subscription isn't billed this way. \"+\": some models have no price (Haiku 5.5, Sonnet 5.5). Codex has no price table: tokens only."));

    // --- System ---
    const meterTile = (label, p, big, sub) => tile().min_w(140)
      .child(caps(label))
      .child(div().text_size(24).font_bold().text_color(level(p)).child(big))
      .child(bar(p))
      .child(div().text_size(12).text_color(t.muted).child(sub));
    const machine = (key) => {
      const st = this.stats[key], d = st?.data;
      const title = key ? key : "This Mac";
      const card = v_flex().p(16).gap(14).rounded(12).bg(t.background).border(1).border_color(t.border);
      if (!d) return card.child(div().text_size(17).font_bold().child(title))
        .child(div().text_size(13).text_color(st?.error ? t.blocked : t.muted).child(st?.error ?? "measuring…"));
      const memP = d.mem_total ? (100 * d.mem_used) / d.mem_total : 0;
      const diskP = d.disk_total ? (100 * d.disk_used) / d.disk_total : 0;
      return card
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(17).font_bold().text_color(t.foreground).child(key ? `${title} · ${d.host}` : title))
          .when(d.battery != null, (el) => el.child(div().text_size(12.5).text_color(d.battery < 20 ? t.blocked : t.muted).child(`battery ${d.battery}%`)))
          .child(div().text_size(12.5).text_color(t.muted).child(`up ${uptime(d.uptime)}`)))
        .child(h_flex().gap(10).flex_wrap().items_start()
          .child(meterTile("CPU", d.cpu, `${Math.round(d.cpu)}%`, `load ${d.load} on ${d.ncpu} cores`))
          .child(meterTile("RAM", memP, `${Math.round(memP)}%`, `${GB(d.mem_used)} of ${GB(d.mem_total)}${d.mem_free_pct != null ? ` · ${d.mem_free_pct}% free` : ""}`))
          .child(meterTile("Disk", diskP, `${Math.round(diskP)}%`, `${GB(d.disk_used)} of ${GB(d.disk_total)}`))
          .children((d.gpus ?? []).map((g, i) => meterTile(`GPU${d.gpus.length > 1 ? ` ${i}` : ""}`, g.util, `${g.util}%`, `${GB(g.mem_used)} of ${GB(g.mem_total)}`))))
        .when((d.procs ?? []).length > 0, (el) => el.child(v_flex().gap(6)
          .child(caps("top consumers"))
          .children(d.procs.slice(0, 3).map((p) => h_flex().gap(10).items_center().text_size(13)
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.name))
            .child(div().w(60).flex_none().text_right().font_semibold().text_color(level(Math.min(100, p.cpu / d.ncpu * 4))).child(`${Math.round(p.cpu)}%`))
            .child(div().w(70).flex_none().text_right().text_color(t.muted).child(GB(p.rss)))))));
    };
    const sistema = () => h_flex().gap(14).items_start().flex_wrap()
      .children(["", ...machines().map((m) => m.name).filter(Boolean)].map((k) => div().flex_1().min_w(520).child(machine(k))));

    return v_flex().size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(20).pt(16).pb(12).gap(8).items_center().flex_none()
        .child(div().flex_1().text_size(20).font_bold().child("Usage"))
        .child(h_flex().p(3).gap(3).rounded(9).bg(t.raised).child(segment("limites", "Accounts")).child(segment("sistema", "System"))))
      .child(v_flex().id("uso-body").flex_1().min_h(0).px(20).pb(20).overflow_y_scrollbar()
        .child(this.tab === "sistema" ? sistema() : limites()));
  }
}
