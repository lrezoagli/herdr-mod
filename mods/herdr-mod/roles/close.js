// Cerrar con cuidado (⌘W, ⌘⇧W y la ✕ de la pestaña).
// - Sin props (atajo): cierra solo el panel que tiene el foco, no la pestaña entera.
// - props.pane: ese panel (la ✕ de su encabezado, rol pane).
// - props.tab: cierra esa pestaña.
// Si lo que se cierra tiene un agente (Claude, Codex…), pregunta antes; si no, cierra
// directo y el diálogo ni se llega a ver. Enter confirma, Esc cancela.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, focused, panes, spaces } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("close");

const isAgent = (p) => Boolean(p?.program?.agent || p?.status);
const agentName = (p) => p.program?.name || p.app || "agente";
const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };

export default class Close extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props() ?? {};
    const all = panes();
    if (p.tab) {
      // La pestaña entera: pregunto si adentro hay algún agente.
      const tab = spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, space: s.name }))).find((t) => t.id === p.tab);
      const ags = all.filter((x) => x.tab === p.tab && isAgent(x));
      this.command = { name: "tab.close", args: { id: p.tab, confirmed: true } };
      if (!ags.length) return this.now();
      this.title = ags.length > 1 ? `¿Cerrar la pestaña con ${ags.length} agentes?` : `¿Cerrar la pestaña con ${agentName(ags[0])}?`;
      this.detail = this.describe(ags, tab?.space);
    } else {
      // props.pane (la ✕ del encabezado) o el panel con foco. Un bloque de agente del
      // layout (sin pane propio) no se cierra desde acá.
      const f = focused();
      const id = p.pane ?? f?.pane;
      if (!id) { this.command = null; return this.now(); }
      const pane = all.find((x) => x.pane === id);
      this.command = { name: "pane.close", args: { pane: id } };
      if (!isAgent(pane)) return this.now();
      this.title = `¿Cerrar ${agentName(pane)}?`;
      this.detail = this.describe([pane], spaces().find((s) => s.tabs.some((x) => x.id === pane.tab))?.name);
    }
  }

  describe(ags, space) {
    const where = (x) => [x.branch?.replace(prefixRe(), ""), x.cwd?.replace(/^\/Users\/[^/]+/, "~")].filter(Boolean)[0] ?? "";
    const busy = ags.some((x) => x.status === "working");
    return `${ags.map((x) => `${agentName(x)}${where(x) ? ` en ${where(x)}` : ""}`).join(", ")}${space ? ` (${space})` : ""}.`
      + (busy ? " Está trabajando: se corta en el medio." : " La conversación queda guardada y se puede retomar con --resume.");
  }

  // Sin agente: cierro sin preguntar (y el diálogo se va enseguida).
  now() {
    this.quiet = true;
    const c = this.command;
    close();
    if (c) run(c.name, c.args);
  }

  yes() {
    close();
    run(this.command.name, this.command.args);
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
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancelar", t.raised, t.foreground, () => close()))
        .child(button("yes", "Cerrar (Enter)", t.blocked ?? t.solid, "#ffffff", () => this.yes())));
  }
}
