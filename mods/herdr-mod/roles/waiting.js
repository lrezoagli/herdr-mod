// Cmd+J: quien me esta esperando (dialogo grande, centrado). blocked (pregunta / pide permiso),
// los que esperan tu go (etapas de una extensión) y los avisos (revisiones largas, PRs con comentarios).
// primero, despues done (termino sin que lo mire); dentro de cada grupo, el que
// espera hace mas tiempo arriba. 1-9 o Enter van a ese agente; Esc cierra.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, panes, run, theme, props, closeOverlay, shared, setShared, exec } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("waiting");

// /pr-review y /pr-fix son skills (si las tenés). Sin ellas (shared "herdr-mod.skills", lo
// mira el rol agents), el agente recibe un pedido común que hace lo mismo a mano.
const hasSkill = (s) => Boolean(shared("herdr-mod.skills")?.[s]);
const prAsk = (kind, n, repo) => kind === "fix"
  ? (hasSkill("pr-fix") ? `/pr-fix ${n}` : `Atendé los comentarios de review del PR #${n}${repo ? ` de ${repo}` : ""}: leelos con gh, validá cada uno contra el código, proponé el cambio y la respuesta, y esperá mi ok antes de commitear, pushear o contestar en GitHub.`)
  : (hasSkill("pr-review") ? `/pr-review ${n}` : `Revisá el PR #${n}${repo ? ` de ${repo}` : ""}: resumen, problemas (archivo:línea, severidad, cómo arreglarlo) y los comentarios que dejarías. No publiques nada en GitHub sin mi ok.`);
const prLabel = (kind) => kind === "fix" ? (hasSkill("pr-fix") ? "/pr-fix" : "fix") : (hasSkill("pr-review") ? "/pr-review" : "review");

const RANK = { blocked: 0, done: 1 };

// También los que terminaron una etapa y esperan tu go (aunque ya los hayas mirado).
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
    // La etapa y si espera go, abajo de la rama.
    const loopLine = (a) => {
      const st = lk[a.address];
      if (!st) return null;
      if (st.missing) return div().text_size(12.5).text_color(t.muted).child(st.missing);
      const bits = [st.stage ? `${st.size ? `${st.size} · ` : ""}/${st.stage}` : null, st.next ? `espera go → ${st.next}` : st.activity].filter(Boolean);
      return bits.length ? div().truncate().text_size(12.5).text_color(st.next ? t.accent : t.muted).child(bits.join(" · ")) : null;
    };
    // Si arma un equipo de Claude: como va cada compañero.
    const team = (a) => (teams[a.address] ?? []).map(m => `${m.name} ${m.status === "working" ? "trabajando" : "✓"}`).join(" · ");
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
          .when(Boolean(team(a)), el => el.child(div().truncate().text_size(12.5).text_color(t.muted).child(`equipo: ${team(a)}`)))
          .when(Boolean(loopLine(a)), el => el.child(loopLine(a))))
        .when(Boolean(lk[a.address]?.next), el => el.child(btn(`go-${a.address}`, "go", t.accent, () => exec("hc", ["send", a.address, "go"]))))
        .child(div().w(110).text_right().font_semibold().text_color(a.status === "blocked" ? t.blocked : a.status === "done" ? t.done : t.accent)
          .child(a.status === "blocked" ? "pregunta" : a.status === "done" ? "terminó" : "espera go"))
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
      .child(h_flex().px(16).pt(6).pb(6).items_center().child(div().flex_1().text_size(22).font_semibold().text_color(t.foreground).child(`Esperándote (${list.length})`))
        .child(div().text_size(13).text_color(t.dim).child("1-9 / ↵ ir · ↑↓ elegir · esc cerrar")))
      .child(v_flex().id("w-list").flex_1().min_h(0).overflow_y_scroll().children(list.map(row))
        .when(list.length === 0 && alerts.length === 0, el => el.child(div().p(16).text_size(18).text_color(t.dim).child("Nadie te espera.")))
        // Avisos: revisiones que tardan (¿colgadas?) y PRs míos con comentarios nuevos.
        .when(alerts.length > 0, el => el
          .child(div().px(16).pt(14).pb(6).text_size(13).font_semibold().text_color(t.muted).child("AVISOS"))
          .children(alerts.map(al => h_flex().id(`al-${al.kind}-${al.key ?? al.addr}`).min_h(48).px(16).gap(12).items_center().rounded(9)
            .child(div().size(11).rounded(6).flex_none().bg(al.kind === "review" ? (al.hung ? t.blocked : t.ansi3) : al.changes ? t.blocked : t.ansi5))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(8).min_w(0).child(div().flex_none().font_semibold().text_color(t.foreground).child(al.who))
                .when(Boolean(al.title), el => el.child(div().min_w(0).truncate().text_size(13).text_color(t.dim).child(al.title))))
              .child(div().truncate().text_size(13).text_color(t.muted).child(al.kind === "review"
                ? `la revisión de ${al.tool} lleva ${Math.floor(al.secs / 60)} min${al.hung ? ": parece colgada" : ""}`
                : al.what)))
            .when(al.kind === "review", el => el
              .child(btn(`go-to-${al.addr}`, "ir", t.muted, () => this.go({ address: al.addr })))
              .child(btn(`cut-${al.pid}`, "cortar", t.blocked, () => exec("kill", [String(al.pid)]))))
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
              .child(btn(`open-${al.key}`, "abrir", t.muted, () => exec("open", [al.url])))
              .child(btn(`dismiss-${al.key}`, "✕", t.muted, () => setShared("herdr-mod.alerts.dismiss", { key: al.key, at: Date.now() }))))))));
  }
}
