// Right-click on an agent in the tree: a menu with what you can do with it.
// Opens as a popup at the pointer (props from the row). What changes the tree's own
// state (pin, sleep, wake) goes to the agents role through shared("herdr-mod.agent.action"):
// each copy has its own localStorage, and the pins and sleeping agents live in that one.
// props: { addr, pane, tab, space, branch, cwd, kind, status, sleeping, pinned, next, pr, label }
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, run, openOverlay, setShared, notify } from "herdr";

const close = () => { const id = props()?.overlay; if (id) closeOverlay(id); };
const act = (op) => setShared("herdr-mod.agent.action", { op, addr: props().addr, at: Date.now() });

// The menu's items, also used by the agents role to size the popup.
export function items(p) {
  const claude = p.kind === "claude-code", agent = claude || p.kind === "codex";
  const copy = (text, what) => () => exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]).then(() => notify({ title: `Copied ${what}`, body: text, level: "info", timeout: 3000 }));
  return [
    { label: "Go to agent", icon: "chevron-right", run: () => run("pane.focus", { pane: p.pane }) },
    { label: "Peek", icon: "search", hint: "without leaving where you are", run: () => run("terminal.peek", { terminal: p.addr }), off: p.sleeping },
    { label: "Rename…", icon: "square-pen", run: () => run("tab.rename", { id: p.tab }) },
    { label: p.pinned ? "Unpin" : "Pin to the top", icon: p.pinned ? "pin-off" : "pin", hint: p.pinned ? null : "it won't go to sleep", run: () => act(p.pinned ? "unpin" : "pin") },
    agent && (p.sleeping
      ? { label: "Wake up", icon: "circle-check", run: () => act("wake") }
      : { label: "Put to sleep now", icon: "clock", hint: "frees its memory; comes back with its session", run: () => act("sleep"), off: p.status === "working" }),
    "-",
    p.next && { label: `Send go → ${p.next}`, icon: "chevron-right", color: "accent", run: () => exec("hc", ["send", p.addr, "go"]) },
    agent && p.status === "working" && { label: "Interrupt", icon: "square", hint: "Esc in the agent", run: () => exec("hc", ["interrupt", p.addr]) },
    claude && !p.sleeping && { label: "Codex review", icon: "codex", hint: "/codex:review in the background", run: () => exec("hc", ["send", p.addr, "/codex:review --background"]) },
    claude && !p.sleeping && { label: "Codex adversarial review", icon: "codex", hint: "challenges the approach", run: () => exec("hc", ["send", p.addr, "/codex:adversarial-review --background"]) },
    "-",
    p.branch && { label: "New agent on top of this branch…", icon: "git-branch", run: () => openOverlay({ mod: "herdr-mod", kind: "dialog", width: 520, height: 250, props: { role: "worktree", space: p.space, id: "claude", choose: true, base: p.branch } }) },
    p.pr && { label: `Open PR #${p.pr} on GitHub`, icon: "github", run: () => exec("gh", ["pr", "view", String(p.pr), "--web"], { cwd: p.cwd }) },
    p.cwd && { label: "Open folder in Finder", icon: "folder", run: () => exec("open", [p.cwd]) },
    p.branch && { label: "Copy branch name", icon: "files", run: copy(p.branch, "the branch") },
    p.cwd && { label: "Copy path", icon: "files", run: copy(p.cwd, "the path") },
    "-",
    { label: "Close…", icon: "x", color: "blocked", run: () => openOverlay({ mod: "herdr-mod", kind: "dialog", width: 440, height: 240, props: { role: "close", pane: p.pane } }) },
  ].filter(Boolean).filter((x, i, all) => x !== "-" || (i > 0 && all[i - 1] !== "-" && i < all.length - 1));
}

export const menuHeight = (p) => items(p).reduce((h, x) => h + (x === "-" ? 9 : 30), 40);

const ICONS = { github: "mods/herdr-mod/assets/github.svg" };

export default class AgentMenu extends View {
  init() {}

  render() {
    const t = theme();
    const p = props() ?? {};
    return v_flex().id("agentmenu").size_full().p(5).bg(t.popover).text_size(13)
      .child(div().px(8).pt(3).pb(5).truncate().text_size(11).text_color(t.dim).child(p.label ?? p.addr))
      .children(items(p).map((x, i) => x === "-"
        ? div().my(4).mx(6).h(1).bg(t.border)
        : h_flex().id(`mi-${i}`).h(30).px(8).gap(9).rounded(7).items_center().flex_none()
          .text_color(x.off ? t.dim : t[x.color] ?? t.foreground)
          .when(!x.off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { close(); x.run(); }))
          .child(x.icon === "codex" ? image("icons/codex.svg").size(14).flex_none()
            : svg(ICONS[x.icon] ?? `mods/workspace-chrome/${x.icon}.svg`).size(14).flex_none().text_color(x.off ? t.dim : t[x.color] ?? t.muted))
          .child(div().flex_1().min_w(0).truncate().child(x.label))
          .when(Boolean(x.hint), (el) => el.child(div().flex_none().max_w(170).truncate().text_size(11).text_color(t.dim).child(x.hint)))));
  }
}
