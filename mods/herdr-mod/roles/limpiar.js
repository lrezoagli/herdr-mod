// Clean up worktrees (⌘K → "limpiar", or the herdr-mod.limpiar command): worktrees nobody
// uses anymore. scripts/limpiar.py checks them in the cfg().worktreeRoots folders.
// - Can be deleted (checked by default): no terminal or agent (not even dormant), no
//   changes and no commits missing from the remote or main.
// - To review: they have something that would be lost; shown but not deleted from here.
// - In use: only counted.
// Deletes with git worktree remove (no --force): the branch stays. The script re-checks
// each one right before deleting it. Enter deletes the checked ones, Esc closes.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, home } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, configReady, dir } from "../config.js";
const localStorage = scoped("limpiar");

const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };
const short = (p) => p.replace(home(), "~");

export default class Limpiar extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.rows = null; this.unknown = []; this.marked = new Set(); this.busy = false; this.done = null; this.error = "";
    this.load(cx);
  }

  load(cx) {
    this.rows = null; this.error = "";
    cx.spawn(async (cx) => { await this.fetch(); cx.notify(); });
  }

  async fetch() {
    await configReady();
    const r = await exec("python3", [`${dir()}/scripts/limpiar.py`, "list", ...(cfg().worktreeRoots ?? [])]);
    try {
      const d = JSON.parse(r.stdout);
      this.rows = d.rows; this.unknown = d.unknown ?? []; this.error = "";
      this.marked = new Set(this.rows.filter((x) => x.state === "safe").map((x) => x.path));
    } catch { this.rows = []; this.error = (r.stderr || r.stdout || "couldn't check the worktrees").trim().split("\n").pop(); }
  }

  remove(cx) {
    if (this.busy || !this.marked.size) return;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${dir()}/scripts/limpiar.py`, "remove", ...this.marked]);
      let res = [];
      try { res = JSON.parse(r.stdout); } catch { res = [{ path: "", ok: false, why: (r.stderr || "delete failed").trim().split("\n").pop() }]; }
      this.done = { ok: res.filter((x) => x.ok).length, fail: res.filter((x) => !x.ok) };
      this.busy = false; this.rows = null; cx.notify();
      await this.fetch(); cx.notify();
    });
  }

  render() {
    const t = theme();
    const rows = this.rows ?? [];
    const safe = rows.filter((x) => x.state === "safe");
    const review = rows.filter((x) => x.state === "review" || x.state === "broken");
    const inuse = rows.filter((x) => x.state === "inuse");
    const button = (id, label, bg, fg, onClick, off = false) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg)
        .when(off, (el) => el.opacity(0.5)).when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick)).child(label);
    const head = (text, n, color) => h_flex().pt(8).pb(2).gap(8).items_center().text_size(12).font_semibold().text_color(color)
      .child(text).child(div().text_color(t.dim).child(String(n)));
    const line = (x, check) => {
      const on = this.marked.has(x.path);
      const branch = x.branch && x.branch !== x.name && x.branch.replace(prefixRe(), "") !== x.name ? x.branch.replace(prefixRe(), "") : "";
      return h_flex().id(`w-${x.path}`).min_h(30).px(8).gap(10).items_center().rounded(7).flex_none()
        .when(check, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
          if (on) this.marked.delete(x.path); else this.marked.add(x.path);
          cx.notify();
        }))
        .child(check
          ? div().size(15).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
            .flex().items_center().justify_center().text_size(11).text_color("#ffffff").child(on ? "✓" : "")
          : div().size(15).flex_none())
        .child(div().w(150).flex_none().truncate().text_color(t.muted).child(x.repo))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.name + (branch ? `  ·  ${branch}` : "")))
        .when(Boolean(x.why), (el) => el.child(div().max_w(330).flex_none().truncate().text_size(12).text_color(x.state === "inuse" ? t.dim : t.blocked ?? t.muted).child(x.why)));
    };
    const list = v_flex().gap(1)
      .when(Boolean(this.done), (el) => el.child(div().pb(6).text_color(this.done.fail.length ? t.blocked : t.accent)
        .child(`Deleted ${this.done.ok}.` + (this.done.fail.length ? ` Couldn't delete ${this.done.fail.length}: ${this.done.fail.map((f) => `${short(f.path)} (${f.why})`).join("; ")}` : ""))))
      .when(this.unknown.length > 0, (el) => el.child(div().pb(6).text_color(t.blocked)
        .child(`Heads up: I don't know which folder these dormant agents were in: ${this.unknown.join(", ")}. Make sure it's not among the checked ones.`)))
      .child(head("Can be deleted", safe.length, t.foreground))
      .children(safe.length ? safe.map((x) => line(x, true)) : [div().px(8).text_color(t.dim).child("nothing: no orphaned worktrees")])
      .when(review.length > 0, (el) => el.child(head("Check by hand (something would be lost)", review.length, t.foreground)).children(review.map((x) => line(x, false))))
      .when(inuse.length > 0, (el) => el.child(head("In use or with a dormant agent", inuse.length, t.dim)).children(inuse.map((x) => line(x, false))));
    const n = this.marked.size;
    return v_flex()
      .id("limpiar")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.remove(cx);
        else if (e.key === "escape") close();
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Clean up worktrees"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(12).text_color(t.muted).child(`Checks ${(cfg().worktreeRoots ?? []).join(", ")}. Deletes the folder with git worktree remove: the branch stays.`))
      .child(this.rows === null
        ? h_flex().flex_1().gap(8).items_center().justify_center().text_color(t.muted)
          .child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.working).spin(900)).child("checking worktrees, terminals and dormant agents…")
        : this.error ? div().flex_1().text_color(t.blocked).child(this.error)
        : div().id("limpiar-list").flex_1().min_h(0).overflow_y_scrollbar().child(list))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Close", t.raised, t.foreground, () => close()))
        .child(button("yes", this.busy ? "Deleting…" : `Delete ${n} (Enter)`, t.blocked ?? t.solid, "#ffffff", (_e, cx) => this.remove(cx), this.busy || !n || this.rows === null)));
  }
}
