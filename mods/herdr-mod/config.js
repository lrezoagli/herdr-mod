// Config: config.json (shared) and config.local.json (yours, kept out of git).
//   branchPrefix: prefix of your branches ("user/"): stripped for display and used in IS-<n>.
//   projects: folders where clones of your repos live (to open reviews and PRs).
//   worktreeRoots: folders with worktrees (<folder>/<repo>/<name>) checked by "Clean up worktrees".
import { exec, home } from "herdr";

const DEFAULTS = { branchPrefix: "", projects: ["~/Projects"], worktreeRoots: ["~/.herdr/worktrees"] };
let CFG = { ...DEFAULTS };
let loading = null;

export const cfg = () => CFG;
export const dir = () => `${home()}/.config/herdr-app/mods/herdr-mod`;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const prefixRe = () => (CFG.branchPrefix ? new RegExp(`^${esc(CFG.branchPrefix)}`) : /^(?!)/);

// Await the config before using it (after loadConfig, which main.js always calls).
export const configReady = () => loading ?? Promise.resolve();

// Once per mod version; each instance requests it and re-renders when it's ready.
export function loadConfig(cx) {
  loading ??= (async () => {
    let next = { ...DEFAULTS };
    for (const f of ["config.json", "config.local.json"]) {
      try {
        const r = await exec("cat", [`${dir()}/${f}`]);
        if (r.code === 0) next = { ...next, ...JSON.parse(r.stdout) };
      } catch {}
    }
    CFG = next;
  })();
  cx.spawn(async (cx) => { await loading; cx.notify(); });
}
