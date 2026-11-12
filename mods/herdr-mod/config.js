// Configuración: config.json (lo de todos) y config.local.json (lo tuyo, fuera de git).
//   branchPrefix: prefijo de tus ramas ("usuario/"): se saca al mostrar y se usa en IS-<n>.
//   projects: carpetas donde buscar clones de tus repos (para abrir reviews y PRs).
//   worktreeRoots: carpetas con worktrees (<carpeta>/<repo>/<nombre>) que revisa "Limpiar worktrees".
import { exec, home } from "herdr";

const DEFAULTS = { branchPrefix: "", projects: ["~/Projects"], worktreeRoots: ["~/.herdr/worktrees"] };
let CFG = { ...DEFAULTS };
let loading = null;

export const cfg = () => CFG;
export const dir = () => `${home()}/.config/herdr-app/mods/herdr-mod`;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const prefixRe = () => (CFG.branchPrefix ? new RegExp(`^${esc(CFG.branchPrefix)}`) : /^(?!)/);

// Para esperar la config antes de usarla (después de loadConfig, que main.js llama siempre).
export const configReady = () => loading ?? Promise.resolve();

// Una vez por versión del mod; cada copia la pide y se redibuja cuando está.
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
