// Careful close (⌘W, ⌘⇧W and the tab's ✕).
// - No props (shortcut): closes only the focused pane, not the whole tab.
// - props.pane: that pane (the ✕ in its header, pane role).
// - props.tab: closes that tab.
// If what's closing has an agent (Claude, Codex…), it asks first; otherwise it closes
// right away and the dialog never shows. Enter confirms, Esc cancels.
// If this closes the last thing using a worktree (under cfg().worktreeRoots), the dialog
// offers to delete it too: checked if nothing would be lost (same check as ⌘⇧K, ignoring
// what's being closed), unchecked with the reason if something would. The branch stays.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, focused, panes, spaces, exec, home, notify } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig, configReady, dir } from "../config.js";
const localStorage = scoped("close");

const isAgent = (p) => Boolean(p?.program?.agent || p?.status);
const agentName = (p) => p.program?.name || p.app || "agent";
const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };
const script = () => `${dir()}/scripts/limpiar.py`;
const tilde = (p) => p.replace(home(), "~");

// Worktree (<root>/<repo>/<name>) containing this folder, if it's under a root.
function worktreeOf(cwd) {
  for (const r of cfg().worktreeRoots ?? []) {
    const root = r.replace(/^~(?=\/|$)/, home()).replace(/\/+$/, "");
    if (!cwd?.startsWith(root + "/")) continue;
    const [repo, name] = cwd.slice(root.length + 1).split("/");
    if (repo && name) return `${root}/${repo}/${name}`;
  }
  return null;
}

export default class Close extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props() ?? {};
    const all = panes();
    if (p.tab) {
      // The whole tab: ask if there's any agent inside.
      const tab = spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, space: s.name }))).find((t) => t.id === p.tab);
      const ags = all.filter((x) => x.tab === p.tab && isAgent(x));
      this.command = { name: "tab.close", args: { id: p.tab, confirmed: true } };
      this.closing = all.filter((x) => x.tab === p.tab);
      if (this.offerWorktree(cx)) {
        this.title = ags.length > 1 ? `Close the tab with ${ags.length} agents?` : ags.length ? `Close the tab with ${agentName(ags[0])}?` : "Close the tab?";
        this.detail = ags.length ? this.describe(ags, tab?.space) : "There are no agents in it.";
        return;
      }
      if (!ags.length) return this.now();
      this.title = ags.length > 1 ? `Close the tab with ${ags.length} agents?` : `Close the tab with ${agentName(ags[0])}?`;
      this.detail = this.describe(ags, tab?.space);
    } else {
      // props.pane (the header's ✕) or the focused pane. A layout agent block
      // (with no pane of its own) isn't closed from here.
      const f = focused();
      const id = p.pane ?? f?.pane;
      if (!id) { this.command = null; return this.now(); }
      const pane = all.find((x) => x.pane === id);
      this.command = { name: "pane.close", args: { pane: id } };
      this.closing = pane ? [pane] : [];
      if (this.offerWorktree(cx)) {
        this.title = isAgent(pane) ? `Close ${agentName(pane)}?` : "Close the terminal?";
        this.detail = isAgent(pane) ? this.describe([pane], spaces().find((s) => s.tabs.some((x) => x.id === pane.tab))?.name) : "It's a terminal, with no agent.";
        return;
      }
      if (!isAgent(pane)) return this.now();
      this.title = `Close ${agentName(pane)}?`;
      this.detail = this.describe([pane], spaces().find((s) => s.tabs.some((x) => x.id === pane.tab))?.name);
    }
  }

  // Does closing this leave a worktree unused? If so, check it in the background and
  // the dialog shows the checkbox. With no config yet or no candidate, behave as usual.
  offerWorktree(cx) {
    const ids = new Set(this.closing.map((x) => x.pane));
    const others = panes().filter((x) => !ids.has(x.pane));
    const wts = [...new Set(this.closing.map((x) => worktreeOf(x.cwd)).filter(Boolean))]
      .filter((w) => !others.some((x) => x.cwd === w || x.cwd?.startsWith(w + "/")));
    if (!wts.length) return false;
    this.ignore = this.closing.map((x) => x.terminal).filter(Boolean);
    this.wts = wts.map((path) => ({ path, state: "checking", why: "", on: false }));
    cx.spawn(async (cx) => {
      await configReady();
      const r = await exec("python3", [script(), "check", ...wts, "--ignore", this.ignore.join(",")]);
      let res = [];
      try { res = JSON.parse(r.stdout); } catch {}
      this.wts = this.wts.map((w) => {
        const c = res.find((x) => x.path === w.path);
        if (!c) return { ...w, state: "error", why: "couldn't check it" };
        return { ...w, state: c.state, why: c.state === "inuse" ? `in use by ${c.why}` : c.why, on: c.state === "safe" };
      });
      cx.notify();
    });
    return true;
  }

  describe(ags, space) {
    const where = (x) => [x.branch?.replace(prefixRe(), ""), x.cwd?.replace(/^\/Users\/[^/]+/, "~")].filter(Boolean)[0] ?? "";
    const busy = ags.some((x) => x.status === "working");
    return `${ags.map((x) => `${agentName(x)}${where(x) ? ` in ${where(x)}` : ""}`).join(", ")}${space ? ` (${space})` : ""}.`
      + (busy ? " It's working: it will be cut off mid-task." : " The conversation is saved and can be resumed with --resume.");
  }

  // No agent: close without asking (and the dialog goes away immediately).
  now() {
    this.quiet = true;
    const c = this.command;
    close();
    if (c) run(c.name, c.args);
  }

  yes() {
    close();
    run(this.command.name, this.command.args);
    const del = (this.wts ?? []).filter((w) => w.on).map((w) => w.path);
    if (!del.length) return;
    // remove re-checks each one (ignoring what was just closed).
    exec("python3", [script(), "remove", ...del, "--ignore", (this.ignore ?? []).join(",")]).then((r) => {
      let res = [];
      try { res = JSON.parse(r.stdout); } catch { res = del.map((path) => ({ path, ok: false, why: (r.stderr || "failed").trim().split("\n").pop() })); }
      const ok = res.filter((x) => x.ok), bad = res.filter((x) => !x.ok);
      if (ok.length) notify({ title: `Deleted worktree ${ok.map((x) => tilde(x.path)).join(", ")}`, body: "The branch was kept: you can reopen it.", level: "info", timeout: 6000 });
      if (bad.length) notify({ title: "Worktree not deleted", body: bad.map((x) => `${tilde(x.path)}: ${x.why}`).join("\n"), level: "warning", timeout: 10000 });
    });
  }

  render() {
    const t = theme();
    if (this.quiet) return div();
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex()
      .id("close")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes();
        else if (e.key === "escape") close();
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(this.title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).child(this.detail))
      .children((this.wts ?? []).map((w, i) => {
        const can = w.state === "safe" || w.state === "review";
        const label = w.state === "checking" ? "checking…" : w.state === "safe" ? "nothing will be lost; the branch stays" : w.why;
        return h_flex().id(`wt-${i}`).gap(8).items_center().text_size(12.5)
          .when(can, (el) => el.cursor_pointer().on_click((_e, cx) => { w.on = !w.on; cx.notify(); }))
          .child(div().size(15).flex_none().rounded(4).border_1().border_color(w.on ? t.accent : t.input).bg(w.on ? t.accent : t.background)
            .when(!can, (el) => el.opacity(0.4)).flex().items_center().justify_center().text_size(11).text_color("#ffffff").child(w.on ? "✓" : ""))
          .child(div().flex_none().text_color(t.foreground).child(`Also delete the worktree ${tilde(w.path).split("/").slice(-2).join("/")}`))
          .child(div().flex_1().min_w(0).truncate().text_color(w.state === "safe" || w.state === "checking" ? t.dim : t.blocked ?? t.muted).child(label));
      }))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancel", t.raised, t.foreground, () => close()))
        .child(button("yes", "Close (Enter)", t.blocked ?? t.solid, "#ffffff", () => this.yes())));
  }
}
