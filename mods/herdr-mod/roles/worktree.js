// Agent in a worktree, as a tab of the project (space). Opened by the tabs role's
// Claude/Codex buttons with props { space, id, label, argv, icon }; by the agent
// tree's + with { space, base, choose: true } (Claude or Codex is picked here).
// Asks for the worktree name (it's the branch), creates the checkout at
// ~/.herdr/worktrees/<repo>/<name> from the main checkout's HEAD (reusing the
// branch if it exists) and opens a tab with the agent (the bar shows agent + branch).
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, setShared } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("worktree");

const AGENTS = {
  claude: { id: "claude", label: "Claude", argv: ["claude"], icon: "icons/claude.svg", color: "ansi3" },
  codex: { id: "codex", label: "Codex", argv: ["codex"], icon: "icons/codex.svg", color: "ansi4" },
};

const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
// Branch convention: a number is an issue -> <branchPrefix>IS-<n> (config.json),
// folder IS-<n>. Any other text is used as the branch name as is.
export const names = (raw) => /^#?\d+$/.test(raw)
  ? { branch: `${cfg().branchPrefix}IS-${raw.replace("#", "")}`, folder: `IS-${raw.replace("#", "")}` }
  : { branch: raw, folder: slug(raw.replace(prefixRe(), "")) };

export default class AgentWorktree extends View {
  init(_props, cx) {
    this.text = "";
    this.agent = AGENTS[props()?.id] ?? AGENTS.claude;
    this.error = "";
    this.busy = false;
    this.repo = undefined; // undefined: looking; null: not a repo
    this.input = InputState.new({ value: "", placeholder: "issue number (12 → IS-12) or branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const s = this.space();
        this.on = s?.machine ?? null;
        const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
        const folder = panes().find((p) => p.focused && tabs.has(p.tab))?.cwd ?? panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? s?.folder;
        this.folder = folder;
        const common = await this.git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (!common.ok) { this.repo = null; return cx.notify(); }
        const main = common.out.replace(/\/\.git$/, "");
        let userHome = home();
        if (this.on) userHome = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on })).stdout.trim();
        this.repo = { main, name: main.split("/").pop(), root: `${userHome}/.herdr/worktrees/${main.split("/").pop()}`, userHome };
      } catch (error) { this.repo = null; this.error = String(error); }
      cx.notify();
    });
  }

  space() { return spaces().find((s) => s.id === props()?.space); }

  async git(cwd, args) {
    const r = await exec("git", args, { cwd, on: this.on });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => {
      this.busy = true; cx.notify();
      try { this.error = await this.create(); } catch (error) { this.error = String(error); }
      this.busy = false;
      if (!this.error) closeOverlay(props().overlay);
      cx.notify();
    });
  }

  async create() {
    const p = props();
    const raw = this.text.trim();
    if (!raw) return "Enter an issue number or a name.";
    const { branch, folder } = names(raw);
    if (!(await this.git(this.repo.main, ["check-ref-format", "--branch", branch])).ok) return `"${branch}" isn't a valid branch name.`;
    const path = `${this.repo.root}/${folder}`;
    const exists = (await this.git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    const add = await this.git(this.repo.main, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, p.base ?? "HEAD"]);
    if (!add.ok) return add.err || "git worktree add failed.";
    // The request chain lives in git: the agent tree reads it from here.
    if (p.base && !exists) {
      const sha = await this.git(this.repo.main, ["rev-parse", p.base]);
      await this.git(this.repo.main, ["config", `branch.${branch}.herdrBase`, p.base]);
      if (sha.ok) await this.git(this.repo.main, ["config", `branch.${branch}.herdrFrom`, sha.out]);
      setShared("herdr-mod.chains.at", Date.now());
    }
    // The agent keeps the name you typed, for good: the tab gets that name and,
    // for Claude, its session too (-n). If it later switches branch, the list shows
    // it small alongside. The project is named after the repo even if the first tab changes.
    const name = /^#?\d+$/.test(raw) ? folder : raw.replace(prefixRe(), "");
    const space = this.space();
    if (space && !space.named) run("space.rename", { id: space.id, name: this.repo.name });
    const argv = p.choose ? this.agent.argv : p.argv;
    run("tab.new", { space: p.space, name, folder: path, argv: argv[0] === "claude" ? [...argv, "-n", name] : argv });
    return "";
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const r = this.repo;
    const tilde = (path) => (r?.userHome && path?.startsWith(r.userHome) ? `~${path.slice(r.userHome.length)}` : path);
    const detail = r === undefined ? "…"
      : r === null ? `${tilde(this.folder) ?? "This space"} isn't a git repo.`
      : `${this.text.trim() ? names(this.text.trim()).branch : "New branch"} ${p.base ? `on top of ${p.base}` : `from ${r.name}'s HEAD`} (reused if it exists). Checkout at ${tilde(r.root)}/${this.text.trim() ? names(this.text.trim()).folder : "…"}`;
    const a = p.choose ? this.agent : { label: p.label, icon: p.icon };
    // With choose: Claude or Codex (click, or tab to switch).
    const pick = (x) => h_flex().id(`pick-${x.id}`).h(26).px(9).gap(6).items_center().rounded(7).cursor_pointer()
      .text_size(12.5).font_semibold().text_color(t[x.color]).border(1)
      .bg(this.agent.id === x.id ? `${t[x.color]}33` : t.popover).border_color(this.agent.id === x.id ? t[x.color] : t.border)
      .on_click((_e, cx) => { this.agent = x; this.input.focus(); cx.notify(); })
      .child(image(x.icon).size(14)).child(x.label);
    return v_flex().id("worktree").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
        if (e.key === "tab" && p.choose) { this.agent = this.agent.id === "claude" ? AGENTS.codex : AGENTS.claude; cx.stop_propagation(); cx.notify(); }
      })
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().gap(8).items_center()
        .when(Boolean(a.icon), (el) => el.child(image(a.icon).size(16)))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(`${a.label ?? "Agent"} in a worktree${p.base ? ` on top of ${p.base.replace(prefixRe(), "")}` : r ? ` of ${r.name}` : ""}`)))
      .when(Boolean(p.choose), (el) => el.child(h_flex().gap(6).items_center().child(pick(AGENTS.claude)).child(pick(AGENTS.codex))
        .child(div().text_size(11).text_color(t.dim).child("tab switches"))))
      .child(div().text_color(t.muted).child(detail))
      .when(Boolean(r), (el) => el.child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child(this.busy ? "creating…" : r ? "↵ create · esc cancel" : "esc close"));
  }
}
