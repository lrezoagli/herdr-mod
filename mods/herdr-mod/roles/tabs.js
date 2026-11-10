import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, agents, terminals, nextCommand } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("tabs");

// tips de atajos (los muestra el rol tips abajo a la derecha).
const tip = (...items) => setShared("herdr-mod.tip", { items: items.map(([action, text]) => ({ action, text })), at: Date.now() });

const AGENTS = { claude: { label: "Claude", argv: ["claude"], icon: "icons/claude.svg" }, codex: { label: "Codex", argv: ["codex"], icon: "icons/codex.svg" } };
function openAgent(id) {
  const space = spaces().find(p => p.active);
  if (!space) return;
  const a = AGENTS[id];
  openOverlay({ mod: "herdr-mod", kind: "dialog", width: 480, height: 210, props: { role: "worktree", space: space.id, id, label: a.label, argv: a.argv, icon: a.icon } });
}
function togglePanel(id) {
  const find = (n) => n?.id === "panel" ? n : (n?.children ?? []).map(find).find(Boolean);
  const panel = find(layout());
  const body = (panel?.children ?? []).find(c => c.id === "panel-body");
  if (panel && !panel.hidden && body?.active === id) run("layout.hide", { id: "panel" });
  else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
}
// Cmd+J: el proximo que me espera. blocked primero, despues done; el que espera
// hace mas tiempo primero. Salta el que ya estoy mirando.
const RANK = { blocked: 0, done: 1 };
function nextWaiting() {
  const since = new Map(terminals().map(k => [k.address, k.status_ms ?? 0]));
  const list = agents().filter(a => a.status in RANK && !a.focused)
    .sort((x, y) => RANK[x.status] - RANK[y.status] || (since.get(x.address) ?? 0) - (since.get(y.address) ?? 0));
  if (list.length) run("agent.focus", { terminal: list[0].address });
  else setShared("herdr-mod.tip", { items: [{ action: "herdr-mod.waiting", text: "nadie más te espera" }], at: Date.now() });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  // main.js: este rol atiende los comandos del mod (los demás los descartan).
  get listensCommands() { return true; }

  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const c = String(await nextCommand()).split(/[.:]/).pop();
        if (c === "claude" || c === "codex") openAgent(c);
        else if (c === "waiting-next") nextWaiting();
        else if (c === "github") togglePanel("github");
        else if (c === "equipo") togglePanel("equipo");
        // Los diálogos del mod (⌘J, ⌘K, ⌘W): este rol está siempre a la vista, los abre él.
        else if (c === "waiting") openOverlay({ mod: "herdr-mod", kind: "dialog", width: 820, height: 520, key: "herdr-mod.waiting", props: { role: "waiting" } });
        else if (c === "buscar") openOverlay({ mod: "herdr-mod", kind: "dialog", width: 820, height: 560, key: "herdr-mod.buscar", props: { role: "buscar" } });
        else if (c === "close") openOverlay({ mod: "herdr-mod", kind: "dialog", width: 440, height: 200, props: { role: "close" } });
      }
    });
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const auto = /^tb\d+$|^\d+$/.test(c.name);
      // El logo dice que agente es; el texto, el worktree (rama viva).
      const name = auto ? lead?.branch?.replace(prefixRe(), "") || program?.name || "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else { run("tab.select", { id: c.id }); tip(i < 9 ? [`tab.select:${i + 1}`, "ir a esta pestaña"] : ["tab.next", "pestaña siguiente"], ["tab.prev", "pestaña anterior"]); }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "herdr-mod", kind: "dialog", width: 440, height: 200, props: { role: "close", tab: c.id } }); tip(["tab.close", "cerrar la pestaña"]); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "github", "equipo"];
    this.syncPanel(space, panel, body, enabled);
    // Equipo: cuantos compañeros de equipos de Claude trabajan ahora en este proyecto.
    const spaceTabs = new Set((space?.tabs ?? []).map(x => x.id));
    const busyMates = Object.entries(shared("herdr-mod.teams") ?? {})
      .filter(([lead]) => spaceTabs.has(panes().find(p => p.terminal === lead)?.tab))
      .flatMap(([, mates]) => mates).filter(m => m.status === "working").length;
    // GitHub: mis PRs con comentarios por contestar y reviews que me pidieron (todos los repos).
    const ghPending = (shared("herdr-mod.alerts") ?? []).filter(a => a.kind === "pr" || a.kind === "rr").length;
    const panelButton = (id, label, icon, badge = 0) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (id === "github") tip(["herdr-mod.github", "abrir/cerrar GitHub"]);
          if (id === "equipo") tip(["herdr-mod.equipo", "abrir/cerrar Equipo"]);
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label)
        .when(badge > 0, el => el.child(div().px(5).rounded(8).text_size(10.5).font_semibold().bg(t.working + "33").text_color(t.working).child(String(badge))));
    };
    // Un agente por worktree, como tab del proyecto: el dialogo del rol worktree
    // pide el nombre y hace el resto.
    const agentButton = (id, label, icon, argv, color) => h_flex().id(`agent-${id}`).h(26).px(9).gap(6).flex_none().items_center().rounded(7)
      .text_size(12.5).font_semibold().text_color(color).bg(`${color}22`).border(1).border_color(`${color}66`)
      .hover(s => s.bg(`${color}44`).border_color(color)).on_mouse_down("left", stop)
      .on_click(() => { openAgent(id); tip([`herdr-mod.${id}`, `${label} en un worktree nuevo`]); })
      .child(image(icon).size(14)).child(label);
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(agentButton("claude", "Claude", "icons/claude.svg", ["claude"], t.ansi3))
      .child(agentButton("codex", "Codex", "icons/codex.svg", ["codex"], t.ansi4))
      .child(button("tab-new", "+", () => { openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }); tip(["tab.new", "terminal nueva"], ["herdr-mod.claude", "Claude en worktree"], ["herdr-mod.codex", "Codex en worktree"]); }))
      .child(div().w(1).h(18).mx(6).flex_none().bg(t.border))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("github", "GitHub", "mods/herdr-mod/assets/github.svg", ghPending))
      .child(panelButton("equipo", "Equipo", "mods/workspace-chrome/layers.svg", busyMates))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/herdr-mod/assets/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/herdr-mod/assets/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/herdr-mod/assets/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
