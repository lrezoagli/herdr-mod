// Cmd+K: buscar entre todos los agentes (de todos los proyectos). Se escribe y
// filtra por proyecto, rama, agente (claude/codex) y estado; cada palabra tiene
// que aparecer. Los que te esperan van primero. ↑↓ eligen, Enter va, Esc cierra.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, panes, run, theme, props, closeOverlay, shared } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("buscar");

const WORD = { blocked: "pregunta", done: "terminó", working: "trabajando", idle: "quieto" };
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const short = (b) => (b ?? "").replace(prefixRe(), "");

export default class Buscar extends View {
  init(_props, cx) {
    this.text = "";
    this.at = 0;
    this.input = InputState.new({ value: "", placeholder: "buscar agente: proyecto, rama, claude/codex, estado…" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.shown()[this.at]));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  shown() {
    const words = this.text.toLowerCase().split(/\s+/).filter(Boolean);
    return agents()
      .map((a) => {
        const branch = panes().find((p) => p.pane === a.pane)?.branch;
        const name = shared("herdr-mod.names")?.[a.address];
        const hay = `${a.space_name} ${name ?? ""} ${short(branch)} ${a.program?.name ?? ""} ${a.app ?? ""} ${WORD[a.status] ?? ""} ${a.tab_name ?? ""}`.toLowerCase();
        return { ...a, branch, name, hay };
      })
      .filter((a) => words.every((w) => a.hay.includes(w)))
      .sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9));
  }

  go(a) {
    if (!a) return;
    closeOverlay(props().overlay);
    run("agent.focus", { terminal: a.address });
  }

  render() {
    const t = theme();
    const list = this.shown();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const status = (a) => a.status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.working).spin(900)
      : div().size(11).rounded(6).flex_none().when(a.status === "idle", (el) => el.border(1.5).border_color(t.idle ?? t.dim))
          .when(a.status !== "idle", (el) => el.bg(t[a.status] ?? t.dim));
    const row = (a, i) => {
      const on = i === this.at;
      const icon = a.program?.icon ? (a.program.tint ? svg(a.program.icon).size(22).text_color(t.foreground) : image(a.program.icon).size(22)) : div().w(22);
      return h_flex().id(`b-${a.address}`).h(54).px(16).gap(14).items_center().rounded(9).flex_none().cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.go(a))
        .child(status(a))
        .child(icon)
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).text_color(t.dim).child(a.space_name))
          .child(div().truncate().font_semibold().text_color(t.foreground).child(a.name || short(a.branch) || a.program?.name || a.title)))
        .child(div().w(110).text_right().text_color(a.status === "blocked" ? t.blocked : a.status === "done" ? t.done : t.muted).child(WORD[a.status] ?? ""));
    };
    return v_flex().id("buscar").track_focus(this.handle).size_full().p(18).gap(12).bg(t.popover).text_size(16)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props().overlay); return cx.stop_propagation(); }
        if (e.key === "enter") return this.go(list[this.at]);
        if ((e.key === "down" || e.key === "up") && list.length) {
          this.at = (this.at + (e.key === "down" ? 1 : list.length - 1)) % list.length;
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(h_flex().px(4).items_center()
        .child(div().flex_1().text_size(22).font_semibold().text_color(t.foreground).child("Buscar agente"))
        .child(div().text_size(13).text_color(t.dim).child(`${list.length} · ↑↓ elegir · ↵ ir · esc cerrar`)))
      .child(Input.new(this.input).h(44).px(14).items_center().rounded(9).border(1).border_color(t.accent).bg(t.background).text_size(17).text_color(t.foreground))
      .child(v_flex().id("b-list").flex_1().min_h(0).overflow_y_scrollbar().children(list.map(row))
        .when(list.length === 0, (el) => el.child(div().p(16).text_size(18).text_color(t.dim).child("Ningún agente coincide."))));
  }
}
