// Panel Equipo (al lado de Files, Changes y GitHub; ⌘⇧E): los equipos de Claude
// (agent teams) del proyecto activo. Una tarjeta por compañero: su tarea, que esta
// haciendo, sus ultimas acciones y, cuando termina, lo que contesto. Primero el
// equipo del agente que estoy mirando.
// Los datos los junta el rol agents (teams.py cada 5 s) y los deja en
// shared("herdr-mod.teams") = { "<terminal del lead>": [compañeros] }.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, spaces, panes, terminals, focused, run, theme } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("equipo");

const MATE_COLOR = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", cyan: "ansi6", orange: "ansi9", pink: "ansi13" };

const ago = (ms) => {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

// El agente principal, como lo nombra la lista de agentes: su rama sin prefijo.
function leadLabel(addr) {
  const p = panes().find((x) => x.terminal === addr);
  return shared("herdr-mod.names")?.[addr] || p?.branch?.replace(prefixRe(), "") || terminals().find((k) => k.address === addr)?.program?.name || addr;
}

export default class Equipo extends View {
  init(_props, cx) {
    this.open = new Set(); // resultados desplegados: `${lead}:${name}`
    this.last = "";
    // Los datos cambian en shared; el tiempo transcurrido, cada tanto.
    let tick = 0;
    cx.timer.every(1000, (cx) => {
      const now = JSON.stringify(shared("herdr-mod.teams") ?? {});
      if (now !== this.last || ++tick % 15 === 0) cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const teams = shared("herdr-mod.teams") ?? {};
    this.last = JSON.stringify(teams);
    const space = spaces().find((s) => s.active);
    const tabs = new Set((space?.tabs ?? []).map((x) => x.id));
    const inSpace = (addr) => {
      const k = terminals().find((x) => x.address === addr);
      const tab = panes().find((p) => p.terminal === addr)?.tab ?? k?.labels?.["herdr.tab"];
      return tab ? tabs.has(tab) : true;
    };
    const mine = focused()?.agent;
    const leads = Object.keys(teams).filter(inSpace).sort((a, b) => (b === mine) - (a === mine));

    const status = (m) => m.status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
      : div().flex_none().text_size(11).text_color(t.done).child("terminó");

    const card = (lead, m) => {
      const key = `${lead}:${m.name}`;
      const color = t[MATE_COLOR[m.color]] ?? t.foreground;
      const unfolded = this.open.has(key);
      return v_flex().id(`mate-${key}`).mx(10).mb(8).p(10).gap(6).rounded(8).bg(t.background).border_l(3).border_color(color)
        .child(h_flex().gap(7).items_center()
          .child(div().flex_none().font_semibold().text_size(13.5).text_color(color).child(m.name))
          .when(Boolean(m.model), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(m.model)))
          .child(div().flex_1())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(m.status === "working" ? (m.recent?.[0]?.at || m.turn_at || m.since) : m.recent?.[0]?.at)))
          .child(status(m)))
        .child(div().text_size(12).text_color(t.muted).child(m.task))
        .when(m.status === "working", (el) => el.child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_size(11).text_color(t.working).child("ahora"))
          .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(m.activity))))
        .when((m.recent ?? []).length > (m.status === "working" ? 1 : 0), (el) => el.child(v_flex().gap(2)
          .children(m.recent.slice(m.status === "working" ? 1 : 0, 4).map((r, i) => h_flex().gap(6).items_center()
            .child(div().flex_none().text_color(t.dim).child("·"))
            .child(div().flex_1().min_w(0).truncate().text_size(11.75).text_color(t.dim).child(r.text))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(r.at)))))))
        .when(m.status !== "working" && Boolean(m.result), (el) => el.child(v_flex().id(`res-${key}`).mt(2).p(8).gap(4).rounded(6).bg(t.raised).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { unfolded ? this.open.delete(key) : this.open.add(key); cx.notify(); })
          .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(unfolded ? "CONTESTÓ ▾" : "CONTESTÓ ▸"))
          .child(div().text_size(12).text_color(t.foreground).child(unfolded ? m.result : m.said || m.result))));
    };

    const team = (lead) => {
      const mates = teams[lead] ?? [];
      const busy = mates.filter((m) => m.status === "working").length;
      return v_flex().flex_none()
        .child(h_flex().id(`lead-${lead}`).px(12).pt(10).pb(8).gap(8).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { terminal: lead }))
          .child(div().flex_none().font_semibold().text_size(13.5).text_color(lead === mine ? t.foreground : t.muted).child(leadLabel(lead)))
          .child(div().flex_1().text_size(11.75).text_color(t.dim)
            .child(`${mates.length} ${mates.length === 1 ? "compañero" : "compañeros"} · ${busy ? `${busy} trabajando` : "todos terminaron"}`)))
        .children(mates.map((m) => card(lead, m)));
    };

    return v_flex().size_full().bg(t.chrome).text_color(t.foreground).text_size(12.75)
      .child(h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).flex_none()
        .child(div().flex_1().text_size(13.5).font_semibold().child("Equipo"))
        .child(div().text_size(11.75).text_color(t.dim).child(space?.name ?? "")))
      .child(v_flex().id("teams").flex_1().min_h(0).overflow_y_scrollbar()
        .children(leads.map(team))
        .when(leads.length === 0, (el) => el.child(div().p(14).text_size(12.75).text_color(t.dim)
          .child("No hay equipos en este proyecto. Cuando un Claude arma un equipo (las skills -team, o pidiéndoselo), sus compañeros aparecen acá: qué hacen y qué contestan."))));
  }
}
