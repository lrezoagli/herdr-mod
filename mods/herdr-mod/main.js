// herdr-mod: un solo mod para todo. Cada lugar del layout lo usa con props.role
// (agents, spaces, tabs, github, equipo, uso, tips, pane) y los diálogos se abren con
// su rol (waiting, buscar, close, worktree, limpiar, y agents/uso como popups).
// Atajos: "herdr-mod.<comando>" en keys.json; los atiende el rol tabs (siempre a la vista).
import { View, div } from "gpui-kit";
import { props, nextCommand } from "herdr";
import { loadConfig } from "./config.js";
import Agents from "./roles/agents.js";
import Spaces from "./roles/spaces.js";
import Tabs from "./roles/tabs.js";
import Github from "./roles/github.js";
import Equipo from "./roles/equipo.js";
import Uso from "./roles/uso.js";
import Tips from "./roles/tips.js";
import Waiting from "./roles/waiting.js";
import Buscar from "./roles/buscar.js";
import Close from "./roles/close.js";
import Pane from "./roles/pane.js";
import Worktree from "./roles/worktree.js";
import Limpiar from "./roles/limpiar.js";

const ROLES = { agents: Agents, spaces: Spaces, tabs: Tabs, github: Github, equipo: Equipo, uso: Uso, tips: Tips, waiting: Waiting, buscar: Buscar, close: Close, pane: Pane, worktree: Worktree, limpiar: Limpiar };

class Missing extends View {
  init() {}
  render() { return div().p(10).child(`herdr-mod: rol desconocido "${props()?.role ?? ""}"`); }
}

export default class HerdrMod extends View {
  init(p, cx) {
    const C = ROLES[props()?.role] ?? Missing;
    // Esta copia pasa a ser la del rol: sus métodos y su init.
    Object.setPrototypeOf(this, C.prototype);
    loadConfig(cx);
    // Los comandos llegan a todas las copias: el que no los usa, los descarta.
    if (!C.prototype.listensCommands) cx.spawn(async () => { for (;;) await nextCommand(); });
    return this.init(p, cx);
  }
}
