// Watch a sub-agent that has no terminal of its own: a Claude sub-agent (Agent tool), a
// Claude teammate or a Codex plugin job (review, adversarial, rescue). Opens from the
// agent tree; reads its transcript or log with scripts/ver.py every 2 s while open.
// Newest first. Esc closes; "go to agent" focuses the agent it works for.
// props: { title, kind: "claude" | "log", path, lead, icon }
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, run } from "herdr";
import { dir } from "../config.js";

const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };
const clock = (at) => { const d = new Date(at); return isNaN(d) ? "" : d.toTimeString().slice(0, 8); };

export default class Ver extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.data = null;
    this.load(cx);
    cx.timer.every(2000, (cx) => this.load(cx));
  }

  load(cx) {
    if (this.busy || !props()?.path) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${dir()}/scripts/ver.py`, props().kind, props().path]);
      this.busy = false;
      try {
        const d = JSON.parse(r.stdout);
        if (JSON.stringify(d) !== JSON.stringify(this.data)) { this.data = d; cx.notify(); }
      } catch { this.data = { events: [], done: true, error: (r.stderr || "couldn't read it").trim() }; cx.notify(); }
    });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const d = this.data;
    const look = {
      ask: [t.ansi4, "asked"], say: [t.foreground, "says"], tool: [t.ansi3, "runs"],
      result: [t.dim, "got"], info: [t.muted, ""],
    };
    const row = (e, i) => {
      const [c, label] = look[e.kind] ?? [t.muted, ""];
      return h_flex().id(`ev-${i}`).items_start().gap(10).py(5).px(4).flex_none().border_b(1).border_color(t.border)
        .child(div().w(62).flex_none().text_size(11).text_color(t.dim).child(clock(e.at)))
        .child(div().w(46).flex_none().text_size(11).font_semibold().text_color(e.error ? t.blocked : c).child(label))
        .child(div().flex_1().min_w(0).text_size(e.kind === "say" ? 13 : 12).text_color(e.error ? t.blocked : c)
          .when(e.kind === "tool", (el) => el.font_family("JetBrains Mono"))
          .child(e.text));
    };
    const events = (d?.events ?? []).slice().reverse();
    return v_flex().id("ver").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .size_full().min_h(0).p(16).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().gap(10).items_center()
        .when(Boolean(p.icon), (el) => el.child(image(p.icon).size(18)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(15).font_semibold().text_color(t.foreground).child(p.title ?? "sub-agent"))
          .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
            .when(d && !d.done, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)))
            .child(d === null ? "reading…" : d.done ? "finished" : "working")
            .child(div().text_color(t.dim).child("· newest first · updates every 2 s"))))
        .when(Boolean(p.lead), (el) => el.child(h_flex().id("go-lead").h(28).px(10).items_center().rounded(7).border_1().border_color(t.input)
          .cursor_pointer().hover((s) => s.bg(t.hover)).text_color(t.foreground)
          .on_click(() => { close(); run("pane.focus", { terminal: p.lead }); }).child("go to agent")))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(d?.error ? div().text_color(t.blocked).child(d.error)
        : div().id("ver-list").flex_1().min_h(0).overflow_y_scrollbar()
          .child(v_flex().children(events.length ? events.map(row) : [div().p(8).text_color(t.dim).child(d === null ? "" : "nothing yet")])));
  }
}
