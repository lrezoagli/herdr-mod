// herdr-mod: one mod for everything. Each layout slot uses it with props.role
// (agents, spaces, tabs, github, equipo, uso, tips, pane) and dialogs open with
// their role (waiting, buscar, close, worktree, limpiar, ver, plus agents/uso/agentmenu as popups).
// Shortcuts: "herdr-mod.<command>" in keys.json; the tabs role handles them (always visible).
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
import Ver from "./roles/ver.js";
import AgentMenu from "./roles/agentmenu.js";

const ROLES = { agents: Agents, spaces: Spaces, tabs: Tabs, github: Github, equipo: Equipo, uso: Uso, tips: Tips, waiting: Waiting, buscar: Buscar, close: Close, pane: Pane, worktree: Worktree, limpiar: Limpiar, ver: Ver, agentmenu: AgentMenu };

class Missing extends View {
  init() {}
  render() { return div().p(10).child(`herdr-mod: unknown role "${props()?.role ?? ""}"`); }
}

export default class HerdrMod extends View {
  init(p, cx) {
    const C = ROLES[props()?.role] ?? Missing;
    // This instance becomes the role's: its methods and its init.
    Object.setPrototypeOf(this, C.prototype);
    loadConfig(cx);
    // Commands reach every instance: those that don't use them drain them.
    if (!C.prototype.listensCommands) cx.spawn(async () => { for (;;) await nextCommand(); });
    return this.init(p, cx);
  }
}
