// Cerrar con cuidado (⌘W, ⌘⇧W y la ✕ de la pestaña).
// - Sin props (atajo): cierra solo el panel que tiene el foco, no la pestaña entera.
// - props.pane: ese panel (la ✕ de su encabezado, rol pane).
// - props.tab: cierra esa pestaña.
// Si lo que se cierra tiene un agente (Claude, Codex…), pregunta antes; si no, cierra
// directo y el diálogo ni se llega a ver. Enter confirma, Esc cancela.
// Si con esto se cierra lo último que usaba un worktree (de cfg().worktreeRoots), el diálogo
// ofrece borrarlo también: marcado si no se pierde nada (el mismo chequeo que ⌘⇧K, sin contar
// lo que se está cerrando), desmarcado y con el motivo si algo se perdería. La rama queda.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, focused, panes, spaces, exec, home, notify } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig, configReady, dir } from "../config.js";
const localStorage = scoped("close");

const isAgent = (p) => Boolean(p?.program?.agent || p?.status);
const agentName = (p) => p.program?.name || p.app || "agente";
const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };
const script = () => `${dir()}/scripts/limpiar.py`;
const tilde = (p) => p.replace(home(), "~");

// Worktree (<raíz>/<repo>/<nombre>) que contiene esta carpeta, si cae en alguna raíz.
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
      // La pestaña entera: pregunto si adentro hay algún agente.
      const tab = spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, space: s.name }))).find((t) => t.id === p.tab);
      const ags = all.filter((x) => x.tab === p.tab && isAgent(x));
      this.command = { name: "tab.close", args: { id: p.tab, confirmed: true } };
      this.closing = all.filter((x) => x.tab === p.tab);
      if (this.offerWorktree(cx)) {
        this.title = ags.length > 1 ? `¿Cerrar la pestaña con ${ags.length} agentes?` : ags.length ? `¿Cerrar la pestaña con ${agentName(ags[0])}?` : "¿Cerrar la pestaña?";
        this.detail = ags.length ? this.describe(ags, tab?.space) : "No hay ningún agente adentro.";
        return;
      }
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
      this.closing = pane ? [pane] : [];
      if (this.offerWorktree(cx)) {
        this.title = isAgent(pane) ? `¿Cerrar ${agentName(pane)}?` : "¿Cerrar la terminal?";
        this.detail = isAgent(pane) ? this.describe([pane], spaces().find((s) => s.tabs.some((x) => x.id === pane.tab))?.name) : "Es una terminal, sin agente.";
        return;
      }
      if (!isAgent(pane)) return this.now();
      this.title = `¿Cerrar ${agentName(pane)}?`;
      this.detail = this.describe([pane], spaces().find((s) => s.tabs.some((x) => x.id === pane.tab))?.name);
    }
  }

  // ¿Lo que se cierra deja sin uso algún worktree? Si sí, lo chequea en segundo plano y
  // el diálogo muestra la casilla. Sin config todavía o sin candidato, sigue como siempre.
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
        if (!c) return { ...w, state: "error", why: "no pude chequearlo" };
        return { ...w, state: c.state, why: c.state === "inuse" ? `lo usa ${c.why}` : c.why, on: c.state === "safe" };
      });
      cx.notify();
    });
    return true;
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
    const del = (this.wts ?? []).filter((w) => w.on).map((w) => w.path);
    if (!del.length) return;
    // remove vuelve a chequear cada uno (sin contar lo que se acaba de cerrar).
    exec("python3", [script(), "remove", ...del, "--ignore", (this.ignore ?? []).join(",")]).then((r) => {
      let res = [];
      try { res = JSON.parse(r.stdout); } catch { res = del.map((path) => ({ path, ok: false, why: (r.stderr || "falló").trim().split("\n").pop() })); }
      const ok = res.filter((x) => x.ok), bad = res.filter((x) => !x.ok);
      if (ok.length) notify({ title: `Borré el worktree ${ok.map((x) => tilde(x.path)).join(", ")}`, body: "La rama quedó: se puede volver a abrir.", level: "info", timeout: 6000 });
      if (bad.length) notify({ title: "No borré el worktree", body: bad.map((x) => `${tilde(x.path)}: ${x.why}`).join("\n"), level: "warning", timeout: 10000 });
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
        const label = w.state === "checking" ? "revisando…" : w.state === "safe" ? "no se pierde nada; la rama queda" : w.why;
        return h_flex().id(`wt-${i}`).gap(8).items_center().text_size(12.5)
          .when(can, (el) => el.cursor_pointer().on_click((_e, cx) => { w.on = !w.on; cx.notify(); }))
          .child(div().size(15).flex_none().rounded(4).border_1().border_color(w.on ? t.accent : t.input).bg(w.on ? t.accent : t.background)
            .when(!can, (el) => el.opacity(0.4)).flex().items_center().justify_center().text_size(11).text_color("#ffffff").child(w.on ? "✓" : ""))
          .child(div().flex_none().text_color(t.foreground).child(`Borrar también el worktree ${tilde(w.path).split("/").slice(-2).join("/")}`))
          .child(div().flex_1().min_w(0).truncate().text_color(w.state === "safe" || w.state === "checking" ? t.dim : t.blocked ?? t.muted).child(label));
      }))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancelar", t.raised, t.foreground, () => close()))
        .child(button("yes", "Cerrar (Enter)", t.blocked ?? t.solid, "#ffffff", () => this.yes())));
  }
}
