// Cmd+J: who is waiting on me (large centered dialog). blocked (asking / needs permission)
// first, then done (finished without me looking), plus those waiting for your go (stages of
// an extension) and the alerts (long reviews, PRs with comments). Within each group, the
// longest-waiting on top. 1-9 or Enter jump to that agent; Esc closes.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, panes, run, theme, props, closeOverlay, shared, setShared, exec } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
// Stop a running review: a Codex plugin job is cancelled with its own /codex:cancel
// (interrupts the Codex turn too); anything else gets a kill.
const stopReview = (rv) => rv.stop ? exec(rv.stop[0], rv.stop.slice(1)) : exec("kill", [String(rv.pid)]);
const localStorage = scoped("waiting");

// /pr-review and /pr-fix are skills (if you have them). Without them (shared "herdr-mod.skills",
// checked by the agents role), the agent gets a plain request that does the same by hand.
const hasSkill = (s) => Boolean(shared("herdr-mod.skills")?.[s]);
const prAsk = (kind, n, repo) => kind === "fix"
  ? (hasSkill("pr-fix") ? `/pr-fix ${n}` : `Address the review comments on PR #${n}${repo ? ` in ${repo}` : ""}: read them with gh, check each one against the code, propose the change and the reply, and wait for my ok before committing, pushing or replying on GitHub.`)
  : (hasSkill("pr-review") ? `/pr-review ${n}` : `Review PR #${n}${repo ? ` in ${repo}` : ""}: summary, issues (file:line, severity, how to fix) and the comments you would leave. Don't publish anything on GitHub without my ok.`);
const prLabel = (kind) => kind === "fix" ? (hasSkill("pr-fix") ? "/pr-fix" : "fix") : (hasSkill("pr-review") ? "/pr-review" : "review");

const RANK = { blocked: 0, done: 1 };

// Also those that finished a stage and wait for your go (even if you already looked).
export function waiting() {
  const since = new Map(terminals().map(k => [k.address, k.status_ms ?? 0]));
  const lk = shared("herdr-mod.estado") ?? {};
  return agents().filter(a => a.status in RANK || (a.status === "idle" && lk[a.address]?.next))
    .map(a => ({ ...a, since: since.get(a.address) || 0, branch: panes().find(p => p.pane === a.pane)?.branch }))
    .sort((x, y) => RANK[x.status] - RANK[y.status] || x.since - y.since);
}

const ago = (ms) => {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
};

export default class Waiting extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  go(a) {
    if (!a) return;
    closeOverlay(props().overlay);
    run("agent.focus", { terminal: a.address });
  }

  render() {
    const t = theme();
    const list = waiting();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const teams = shared("herdr-mod.teams") ?? {};
    const lk = shared("herdr-mod.estado") ?? {};
    const alerts = (shared("herdr-mod.alerts") ?? []).filter(a => a.kind !== "go");
    const btn = (id, label, color, action) => div().id(id).px(10).h(26).rounded(6).flex().items_center().cursor_pointer()
      .text_size(13).font_semibold().bg(`${color}33`).text_color(color).hover(s => s.bg(`${color}55`))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(); cx.notify(); }).child(label);
    // The stage, and whether it awaits go, under the branch.
    const loopLine = (a) => {
      const st = lk[a.address];
      if (!st) return null;
      if (st.missing) return div().text_size(12.5).text_color(t.muted).child(st.missing);
      const bits = [st.stage ? `${st.size ? `${st.size} · ` : ""}/${st.stage}` : null, st.next ? `awaiting go → ${st.next}` : st.activity].filter(Boolean);
      return bits.length ? div().truncate().text_size(12.5).text_color(st.next ? t.accent : t.muted).child(bits.join(" · ")) : null;
    };
    // If it runs a Claude team: how each teammate is doing.
    const team = (a) => (teams[a.address] ?? []).map(m => `${m.name} ${m.status === "working" ? "working" : "✓"}`).join(" · ");
    const row = (a, i) => {
      const on = i === this.at;
      const icon = a.program?.icon ? (a.program.tint ? svg(a.program.icon).size(22).text_color(t.foreground) : image(a.program.icon).size(22)) : div().w(22);
      return h_flex().id(`w-${a.address}`).min_h(54).py(6).px(16).gap(14).items_center().rounded(9).flex_none().cursor_pointer()
        .when(on, el => el.bg(t.selected)).when(!on, el => el.hover(s => s.bg(t.hover)))
        .on_click(() => this.go(a))
        .child(div().w(18).text_color(t.dim).child(i < 9 ? String(i + 1) : ""))
        .child(div().size(11).rounded(6).flex_none().bg(t[a.status]))
        .child(icon)
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).text_color(t.dim).child(a.space_name))
          .child(div().truncate().font_semibold().text_color(t.foreground).child(shared("herdr-mod.names")?.[a.address] || (a.branch ? a.branch.replace(prefixRe(), "") : a.program?.name ?? "")))
          .when(Boolean(team(a)), el => el.child(div().truncate().text_size(12.5).text_color(t.muted).child(`team: ${team(a)}`)))
          .when(Boolean(loopLine(a)), el => el.child(loopLine(a))))
        .when(Boolean(lk[a.address]?.next), el => el.child(btn(`go-${a.address}`, "go", t.accent, () => exec("hc", ["send", a.address, "go"]))))
        .child(div().w(110).text_right().font_semibold().text_color(a.status === "blocked" ? t.blocked : a.status === "done" ? t.done : t.accent)
          .child(a.status === "blocked" ? "asking" : a.status === "done" ? "done" : "awaiting go"))
        .child(div().w(48).text_right().text_color(t.dim).child(ago(a.since)));
    };
    return v_flex().id("waiting").track_focus(this.handle).size_full().p(18).gap(10).bg(t.popover).text_size(16)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props().overlay); return cx.stop_propagation(); }
        if (/^[1-9]$/.test(e.key)) return this.go(list[Number(e.key) - 1]);
        if (e.key === "enter") return this.go(list[this.at]);
        if ((e.key === "down" || e.key === "up") && list.length) {
          this.at = (this.at + (e.key === "down" ? 1 : list.length - 1)) % list.length;
          cx.notify();
        }
      })
      .child(h_flex().px(16).pt(6).pb(6).items_center().child(div().flex_1().text_size(22).font_semibold().text_color(t.foreground).child(`Waiting on you (${list.length})`))
        .child(div().text_size(13).text_color(t.dim).child("1-9 / ↵ go to · ↑↓ select · esc close")))
      .child(v_flex().id("w-list").flex_1().min_h(0).overflow_y_scroll().children(list.map(row))
        .when(list.length === 0 && alerts.length === 0, el => el.child(div().p(16).text_size(18).text_color(t.dim).child("Nobody is waiting on you.")))
        // Alerts: reviews taking long (stuck?) and my PRs with new comments.
        .when(alerts.length > 0, el => el
          .child(div().px(16).pt(14).pb(6).text_size(13).font_semibold().text_color(t.muted).child("ALERTS"))
          .children(alerts.map(al => h_flex().id(`al-${al.kind}-${al.key ?? al.addr}`).min_h(48).px(16).gap(12).items_center().rounded(9)
            .child(div().size(11).rounded(6).flex_none().bg(al.kind === "review" ? (al.hung ? t.blocked : t.ansi3) : al.changes ? t.blocked : t.ansi5))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(8).min_w(0).child(div().flex_none().font_semibold().text_color(t.foreground).child(al.who))
                .when(Boolean(al.title), el => el.child(div().min_w(0).truncate().text_size(13).text_color(t.dim).child(al.title))))
              .child(div().truncate().text_size(13).text_color(t.muted).child(al.kind === "review"
                ? `${al.tool} ${al.rkind ?? "review"} running for ${Math.floor(al.secs / 60)} min${al.hung ? ": looks stuck" : ""}`
                : al.what)))
            .when(al.kind === "review", el => el
              .child(btn(`go-to-${al.addr}`, "go to", t.muted, () => this.go({ address: al.addr })))
              .child(btn(`cut-${al.pid}`, "stop", t.blocked, () => stopReview(al))))
            .when(al.kind === "pr" || al.kind === "rr", el => el
              .when(Boolean(al.addr), el => el.child(btn(`fix-${al.key}`, prLabel("fix"), t.ansi5, () => {
                exec("hc", ["send", al.addr, prAsk("fix", al.number, al.repo)]);
                this.go({ address: al.addr });
              })))
              .when(!al.addr, el => el.child(btn(`gh-${al.key}`, `${prLabel(al.kind === "rr" ? "review" : "fix")}…`, t.ansi5, () => {
                setShared("herdr-mod.github.section", { id: al.kind === "rr" ? "reviews" : "prs", at: Date.now() });
                run("layout.select", { stack: "panel-body", child: "github" }); run("layout.show", { id: "panel" });
                closeOverlay(props().overlay);
              })))
              .child(btn(`open-${al.key}`, "open", t.muted, () => exec("open", [al.url])))
              .child(btn(`dismiss-${al.key}`, "✕", t.muted, () => setShared("herdr-mod.alerts.dismiss", { key: al.key, at: Date.now() }))))))));
  }
}
