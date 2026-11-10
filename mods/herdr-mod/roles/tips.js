// Cartelito abajo a la derecha: cuando hacés con el mouse algo que tiene
// atajo, se lo recomienda. Los otros mods (roles tabs, spaces, agents) dejan
// el pedido en shared("herdr-mod.tip") = { items: [{ action, text }], at }; aca se
// busca la tecla de cada accion en keys() (si se rebindea, el tip sigue bien).
// Una tecla que no es de Herdr (la de otro programa) va directo: { key, text }.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, keys, theme, window } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("tips");

const SHOW_MS = 4500;

function pretty(action) {
  const k = keys().find(b => b.section === "global" && b.action === action);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class Tips extends View {
  init(_props, cx) {
    this.visible = false;
    // Solo para esconderlo a tiempo: redibuja cuando vence, no en cada tick.
    cx.timer.every(500, (cx) => {
      const tip = shared("herdr-mod.tip");
      const live = Boolean(tip) && Date.now() - tip.at < SHOW_MS;
      if (live !== this.visible) cx.notify();
    });
  }

  render() {
    const t = theme();
    const tip = shared("herdr-mod.tip");
    const items = (tip && Date.now() - tip.at < SHOW_MS ? tip.items ?? [] : [])
      .map(i => ({ ...i, key: i.key ?? pretty(i.action) })).filter(i => i.key);
    this.visible = items.length > 0;
    if (!this.visible) return div();
    const kbd = (k) => div().px(6).py(1).rounded(5).border(1).border_color(t.input).bg(t.raised)
      .text_color(t.foreground).font_semibold().child(k);
    return v_flex().px(12).py(9).gap(5).text_size(12).text_color(t.muted)
      .child(div().text_size(10.5).text_color(t.accent).font_semibold().child("ATAJO"))
      .children(items.map(i => h_flex().gap(8).items_center().child(kbd(i.key)).child(i.text)));
  }
}
