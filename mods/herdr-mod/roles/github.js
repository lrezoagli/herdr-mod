// Panel GitHub (al lado de Files y Changes): los issues abiertos del proyecto
// (el repo del space activo; desde un worktree, el de su checkout principal).
// Filtro Todos / Míos (asignados a mí), guardado. Clic abre el issue en el
// navegador; los botones Claude y Codex abren el agente en el worktree <prefijo>IS-<n> (carpeta
// ~/.herdr/worktrees/<repo>/IS-<n>) como pestaña del proyecto. Usa `gh` con la cuenta logueada; refresca al cambiar de proyecto,
// cada 2 minutos y con el botón ↻.
// Mis PRs y Reviews: en todos mis repos (no solo el del proyecto). Los trae
// el rol agents con prs.py cada 2 min en shared("herdr-mod.prs"). Arriba lo que
// te toca. /pr-fix y /pr-review abren Claude en el worktree de ese PR (o le
// escriben al agente que ya está ahí); el repo tiene que estar abierto como
// proyecto en Herdr.
// Pedido: marca el issue como pedido grande (rama <prefijo>IS-<n> desde el HEAD
// del checkout principal, sin agente, con branch.<rama>.herdrPedido = true). Sale
// en el arbol de agentes y se le cuelgan ramas con el + de cada rama.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, exec, theme, run, notify, home, shared, setShared } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("github");

// /pr-review y /pr-fix son skills (si las tenés). Sin ellas (shared "herdr-mod.skills", lo
// mira el rol agents), el agente recibe un pedido común que hace lo mismo a mano.
const hasSkill = (s) => Boolean(shared("herdr-mod.skills")?.[s]);
const prAsk = (kind, n, repo) => kind === "fix"
  ? (hasSkill("pr-fix") ? `/pr-fix ${n}` : `Atendé los comentarios de review del PR #${n}${repo ? ` de ${repo}` : ""}: leelos con gh, validá cada uno contra el código, proponé el cambio y la respuesta, y esperá mi ok antes de commitear, pushear o contestar en GitHub.`)
  : (hasSkill("pr-review") ? `/pr-review ${n}` : `Revisá el PR #${n}${repo ? ` de ${repo}` : ""}: resumen, problemas (archivo:línea, severidad, cómo arreglarlo) y los comentarios que dejarías. No publiques nada en GitHub sin mi ok.`);
const prLabel = (kind) => kind === "fix" ? (hasSkill("pr-fix") ? "/pr-fix" : "fix") : (hasSkill("pr-review") ? "/pr-review" : "review");

const REFRESH_MS = 120000;
const FIELDS = "number,title,labels,assignees,updatedAt,url";
const AGENTS = [
  { id: "claude", label: "Claude", argv: ["claude"], app: "claude-code", icon: "icons/claude.svg", color: "ansi3" },
  { id: "codex", label: "Codex", argv: ["codex"], app: "codex", icon: "icons/codex.svg", color: "ansi4" },
];

const ago = (iso) => {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : m < 86400 ? `${Math.floor(m / 1440)}d` : `${Math.floor(m / 43200)}mo`;
};

// Donde esta el proyecto activo ahora: el pane enfocado si es de este space,
// si no su primer terminal, si no la carpeta con que se creo.
function placeOf(space) {
  return placesOf(space)[0] ?? null;
}

// Las carpetas candidatas del space: la terminal enfocada, las otras, la del proyecto.
function placesOf(space) {
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const mine = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  const f = mine.find((p) => p.focused);
  return [...new Set([f?.cwd, ...mine.map((p) => p.cwd), space?.folder].filter(Boolean))];
}

export default class GitHub extends View {
  init(_props, cx) {
    this.goAt = shared("herdr-mod.github.section")?.at ?? 0;
    this.filter = localStorage.getItem("filter") ?? "mine"; // "mine" | "all"
    this.section = localStorage.getItem("section") ?? "issues"; // "issues" | "prs" | "reviews"
    this.lastPrs = "";
    let tick = 0;
    cx.timer.every(1000, (cx) => {
      // Datos nuevos, el ↻ que gira o se para, y cada 30 s el "hace Xm".
      const now = `${shared("herdr-mod.prs.at") ?? 0}:${Boolean(shared("herdr-mod.prs.loading"))}`;
      if (now !== this.lastPrs || ++tick % 30 === 0) { this.lastPrs = now; cx.notify(); }
      // Cambié de proyecto (o de carpeta): el panel pasa a ese repo. No alcanza con render,
      // que no siempre corre al cambiar de space.
      const space = spaces().find((x) => x.active);
      if (space?.id !== this.spaceId || placeOf(space) !== this.folder) { this.load(cx, true); cx.notify(); }
      // ⌘J pide mostrar una sección ("prs" | "reviews").
      const go = shared("herdr-mod.github.section");
      if (go && go.at > (this.goAt ?? 0)) { this.goAt = go.at; this.setSection(go.id, cx); }
    });
    this.cache = new Map(); // `${repo}\0${filter}` -> { issues, at, error }
    this.repo = null; // { main, slug }
    this.loading = false;
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx, true));
    this.load(cx);
  }

  key() { return this.repo ? `${this.repo.main}\0${this.filter}` : null; }

  load(cx, force = false) {
    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    const folder = placeOf(space);
    this.spaceId = space?.id; this.folder = folder;
    cx.spawn(async (cx) => {
      if (!folder) { this.repo = null; this.error = "Este proyecto no tiene carpeta."; return cx.notify(); }
      // La primera carpeta que exista y sea un repo: una terminal puede haber quedado en un
      // worktree borrado (exec ahí falla) o fuera del repo.
      let common = null;
      for (const cwd of placesOf(space)) {
        try {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
          if (r.code === 0) { common = r; break; }
        } catch {}
      }
      if (!common) { this.repo = null; this.error = "Este proyecto no es un repo git."; return cx.notify(); }
      const main = common.stdout.trim().replace(/\/\.git$/, "");
      if (this.repo?.main !== main) {
        const view = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: main, on });
        this.repo = { main, slug: view.code === 0 ? view.stdout.trim() : null };
      }
      this.error = this.repo.slug ? null : "El repo no tiene remoto en GitHub (o gh no lo encuentra).";
      if (this.error) return cx.notify();
      const k = this.key(), hit = this.cache.get(k);
      if (hit && !force && Date.now() - hit.at < REFRESH_MS) return cx.notify();
      this.loading = true; cx.notify();
      const ped = await exec("git", ["config", "--get-regexp", "^branch\\..*\\.herdrpedido$"], { cwd: main, on });
      this.pedidos = new Set((ped.stdout ?? "").split("\n").filter((l) => l.endsWith(" true")).map((l) => (l.match(/IS-(\d+)\.herdrpedido/i) ?? [])[1]).filter(Boolean).map(Number));
      const args = ["issue", "list", "--state", "open", "--limit", "200", "--json", FIELDS];
      if (this.filter === "mine") args.push("--assignee", "@me");
      const r = await exec("gh", args, { cwd: main, on });
      let entry;
      try { entry = r.code === 0 ? { issues: JSON.parse(r.stdout), at: Date.now() } : { issues: [], at: Date.now(), error: (r.stderr || r.stdout).trim() }; }
      catch (e) { entry = { issues: [], at: Date.now(), error: String(e) }; }
      this.cache.set(k, entry);
      this.loading = false;
      cx.notify();
    });
  }

  setFilter(f, cx) {
    if (f === this.filter) return;
    this.filter = f; localStorage.setItem("filter", f);
    this.load(cx);
  }

  // Claude o Codex en el worktree del issue. Si ya hay una pestaña de ese agente
  // en esa rama, va ahi;
  // si el worktree existe, abre otra pestaña en el; si no, lo crea desde el HEAD
  // del checkout principal (o desde la rama, si ya existe).
  async agentFor(issue, agent) {
    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    const branch = `${cfg().branchPrefix}IS-${issue.number}`;
    const fail = (body) => notify({ title: `No pude abrir ${agent.label} para ${branch}`, body, level: "error" });
    try {
      const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
      const there = panes().find((p) => tabs.has(p.tab) && p.branch === branch && p.app === agent.app);
      if (there) return run("pane.focus", { pane: there.pane });
      const git = async (args) => {
        const r = await exec("git", args, { cwd: this.repo.main, on });
        return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
      };
      const list = await git(["worktree", "list", "--porcelain"]);
      const block = list.out.split(/\n\n+/).find((b) => b.split("\n").includes(`branch refs/heads/${branch}`));
      let path = block?.split("\n").find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path) {
        let userHome = home();
        if (on) userHome = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on })).stdout.trim();
        path = `${userHome}/.herdr/worktrees/${this.repo.main.split("/").pop()}/IS-${issue.number}`;
        const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
        const add = await git(exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
        if (!add.ok) return fail(add.err || "git worktree add falló.");
      }
      // Se llama IS-<n> (pestaña y, en Claude, la sesión).
      const name = `IS-${issue.number}`;
      run("tab.new", { space: space.id, name, folder: path, argv: agent.argv[0] === "claude" ? [...agent.argv, "-n", name] : agent.argv });
    } catch (e) { fail(String(e)); }
  }

  // El issue pasa a ser un pedido: su rama (la crea si falta) marcada en git.
  async makePedido(issue, cx) {
    const on = spaces().find((s) => s.active)?.machine ?? null;
    const branch = `${cfg().branchPrefix}IS-${issue.number}`;
    const git = async (args) => {
      const r = await exec("git", args, { cwd: this.repo.main, on });
      return { ok: r.code === 0, err: (r.stderr || r.stdout || "").trim() };
    };
    try {
      if (!(await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) {
        const b = await git(["branch", branch, "HEAD"]);
        if (!b.ok) return notify({ title: `No pude crear ${branch}`, body: b.err, level: "error" });
      }
      await git(["config", `branch.${branch}.herdrPedido`, "true"]);
      (this.pedidos ??= new Set()).add(issue.number);
      setShared("herdr-mod.chains.at", Date.now());
      notify({ title: `IS-${issue.number} es un pedido`, body: "Está en el árbol de agentes. Pasá el mouse por la rama y usá + para colgarle otra con su agente.", level: "info", timeout: 8000 });
      cx.notify();
    } catch (e) { notify({ title: `No pude marcar IS-${issue.number} como pedido`, body: String(e), level: "error" }); }
  }

  setSection(id, cx) {
    this.section = id; localStorage.setItem("section", id);
    cx.notify();
  }

  // /pr-fix (mi PR, en su rama) o /pr-review (de otro, worktree rv-PR-<n> y rama rv/PR-<n>
  // con lo último del PR, sin su config de agentes): si ya hay un agente ahí, se lo
  // escribe; si no, abre Claude (o Codex, en review) en ese worktree, como pestaña
  // del proyecto del repo, con el comando. Review arranca en modo skip (cc / cx).
  // El worktree sale del checkout del repo (abierto en Herdr o clonado en ~/Projects).
  async agentForPr(pr, cmd, who = "claude") {
    const fail = (body) => notify({ title: `No pude abrir ${cmd} para ${pr.repo.split("/")[1]} #${pr.number}`, body, level: "error" });
    try {
      const local = shared("herdr-mod.prs")?.repos?.[pr.repo];
      if (!local) return fail("No encuentro ese repo: ni abierto en Herdr ni clonado en ~/Projects.");
      const { main, on, space } = local;
      const git = async (args, cwd = main) => {
        const r = await exec("git", args, { cwd, on });
        return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
      };
      // Fetch por origin (SSH); si falla (p. ej., el agente SSH no responde),
      // otra vez por HTTPS con las credenciales de gh.
      const fetch = async (src, dst) => {
        const a = await git(["fetch", "origin", dst ? `+${src}:${dst}` : src]);
        if (a.ok) return a;
        const b = await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
          "fetch", `https://github.com/${pr.repo}.git`, dst ? `+${src}:${dst}` : src]);
        return b.ok ? b : { ...b, err: `${a.err}\n${b.err}` };
      };
      const own = cmd === "/pr-fix";
      const list = (await git(["worktree", "list", "--porcelain"])).out.split(/\n\n+/).map((b) => ({
        path: b.split("\n").find((l) => l.startsWith("worktree "))?.slice(9),
        branch: b.split("\n").find((l) => l.startsWith("branch "))?.slice(18),
      }));
      let userHome = home();
      if (on) userHome = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on })).stdout.trim();
      const base = `${userHome}/.herdr/worktrees/${main.split("/").pop()}`;
      // Review: rama rv/PR-<n> (las de antes se llamaban rv-PR-<n>: si hay una, se usa esa).
      const names = own ? [pr.branch] : [`rv/PR-${pr.number}`, `rv-PR-${pr.number}`];
      const old = list.find((w) => names.includes(w.branch));
      const branch = old?.branch ?? names[0];
      let path = old?.path;
      // Un agente que ya está en esa rama: le escribo.
      const there = panes().find((p) => p.program?.agent && p.terminal && names.includes(p.branch));
      if (there) {
        await exec("hc", ["send", there.terminal, prAsk(own ? "fix" : "review", pr.number, pr.repo)]);
        return run("pane.focus", { pane: there.pane });
      }
      if (own && !path) {
        path = `${base}/${pr.branch.replace(prefixRe(), "").replace(/\//g, "-")}`;
        await fetch(`refs/heads/${pr.branch}`, `refs/remotes/origin/${pr.branch}`);
        const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${pr.branch}`])).ok;
        const add = await git(exists ? ["worktree", "add", path, pr.branch] : ["worktree", "add", "--track", "-b", pr.branch, path, `origin/${pr.branch}`]);
        if (!add.ok) return fail(add.err || "git worktree add falló.");
      } else if (!own) {
        // El PR es de otro: código no confiable. El worktree sale sin la config de
        // agentes que trae el PR (.claude/ con hooks y skills, .mcp.json, .codex/,
        // .agents/, en cualquier carpeta; sparse-checkout) y Claude arranca sin la
        // config del proyecto y pidiendo permiso (abajo). Nada de reset --hard: si el
        // PR se reescribió, que lo borre a mano.
        const f = await fetch(`pull/${pr.number}/head`);
        if (!f.ok) return fail(f.err || "git fetch del PR falló.");
        const head = (await git(["rev-parse", "FETCH_HEAD"])).out; // FETCH_HEAD es de cada worktree: el sha
        const fresh = !path;
        if (fresh) {
          path = `${base}/rv-PR-${pr.number}`; // carpeta sin barra; la rama es rv/PR-<n>
          const add = await git(["worktree", "add", "--no-checkout", "-B", branch, path, head]);
          if (!add.ok) return fail(add.err || "git worktree add falló.");
        }
        // Los CLAUDE.md / AGENTS.md de la base que puse la vez anterior: afuera, para que el
        // sparse-checkout y el merge vean el worktree limpio.
        const DOC = /(^|\/)(CLAUDE|AGENTS)\.md$/;
        // El PR controla el worktree: una carpeta suya puede ser un symlink a otro lado
        // (docs -> ~/.claude). Antes de escribir o borrar un doc: ningún tramo del camino es
        // un symlink, la carpeta real queda adentro del worktree y el archivo no es un link.
        const SAFE = 'set -f; wt="$1"; rel="$2"; root=$(cd "$wt" && pwd -P) || exit 3; '
          + 'dir=${rel%/*}; [ "$dir" = "$rel" ] && dir=""; cur="$wt"; IFS=/; for c in $dir; do cur="$cur/$c"; [ -L "$cur" ] && exit 3; done; unset IFS; '
          + 'dest="$wt/$rel"; [ -L "$dest" ] && exit 3; ';
        const inside = 'real=$(cd "$(dirname "$dest")" && pwd -P) || exit 3; case "$real/" in "$root"/*) ;; *) exit 3;; esac; ';
        if (!fresh) {
          // Lo que puse la vez anterior (marcado assume-unchanged: "h" en ls-files -v) vuelve
          // a como lo dejó el PR: los docs se borran (están fuera del sparse) y los importados
          // se restauran.
          const marked = (await git(["ls-files", "-v"], path)).out.split("\n").filter((l) => /^[a-z] /.test(l)).map((l) => l.slice(2));
          if (marked.length) {
            await git(["update-index", "--no-assume-unchanged", "--", ...marked], path);
            for (const f of marked.filter((f) => DOC.test(f))) await exec("sh", ["-c", SAFE + '[ -e "$dest" ] || exit 0; ' + inside + 'rm -f -- "$dest"', "sh", path, f], { on });
            const back = marked.filter((f) => !DOC.test(f));
            if (back.length) await git(["checkout", "--", ...back], path);
          }
        }
        // Sin barra al final también agarra archivos y symlinks (un .claude que apunta a otra carpeta).
        // Los CLAUDE.md / AGENTS.md del PR tampoco: el agente los cargaría como instrucciones
        // (y corre en modo skip). Los de la rama base los lee con git show (ver task).
        const sparse = await git(["sparse-checkout", "set", "--no-cone", "/*", "!.claude/", "!.claude", "!.mcp.json", "!.codex/", "!.codex", "!.agents/", "!.agents",
          "!CLAUDE.md", "!CLAUDE.local.md", "!AGENTS.md", "!AGENTS.override.md"], path);
        if (!sparse.ok) return fail(`No pude dejar afuera la config de agentes del PR: ${sparse.err}`);
        if (fresh) {
          const co = await git(["read-tree", "-mu", "HEAD"], path);
          if (!co.ok) return fail(co.err || "git read-tree falló.");
        } else if (!(await git(["merge", "--ff-only", head], path)).ok) {
          notify({ title: `${branch} no está al día con el PR`, body: "El PR se reescribió (force push) o el worktree tiene cambios. Abro el que hay; para traerlo de nuevo, borrá el worktree.", level: "warning", timeout: 12000 });
        }
        // Control final: si algo de eso quedó en la carpeta (no marcado S), no lanzo Claude.
        const shown = (await git(["ls-files", "-t"], path)).out.split("\n").filter((l) => l && !l.startsWith("S "))
          .map((l) => l.slice(2)).filter((f) => /(^|\/)(\.claude|\.mcp\.json|\.codex|\.agents|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|AGENTS\.override\.md)(\/|$)/.test(f));
        if (shown.length) return fail(`El PR trae config de agentes que no pude dejar afuera (${shown.slice(0, 3).join(", ")}). No lanzo el agente ahí.`);
        // Los CLAUDE.md / AGENTS.md que sí van: los de la rama principal del repo (origin/HEAD,
        // si no main o master), nunca los del PR ni los de su base (la base la elige quien
        // abre el PR). git los ignora y el agente los carga como en cualquier repo.
        const head0 = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out.replace(/^origin\//, "");
        let def = head0;
        if (!def) for (const b of ["main", "master"]) if ((await git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`])).ok) { def = b; break; }
        if (def) await fetch(`refs/heads/${def}`, `refs/remotes/origin/${def}`);
        const ref = def ? `origin/${def}` : null;
        const inRef = new Set(ref ? (await git(["ls-tree", "-r", "--name-only", ref])).out.split("\n").filter(Boolean) : []);
        const docs = [...inRef].filter((f) => DOC.test(f));
        const write = (f) => exec("sh", ["-c", SAFE + 'mkdir -p "$(dirname "$dest")" || exit 3; ' + inside
          // $3: lo de la rama principal. Se escribe en un temporal nuevo (mktemp) y se mueve encima.
          + 'tmp=$(mktemp "$(dirname "$dest")/.herdr.XXXXXX") || exit 3; git show "$3" > "$tmp" && mv -f "$tmp" "$dest" || { rm -f "$tmp"; exit 3; }',
          "sh", path, f, `${ref}:${f}`], { cwd: main, on });
        const remove = (f) => exec("sh", ["-c", SAFE + '[ -e "$dest" ] || exit 0; ' + inside + 'rm -f -- "$dest"', "sh", path, f], { on });
        // Lo que un doc importa con @ruta (relativa al doc) se lee del worktree, o sea del PR:
        // también sale de la rama principal, y si allá no existe, se saca. Hasta 5 niveles,
        // como Claude. Rutas absolutas o con ~ no son del PR: quedan.
        const norm = (base, rel) => {
          const out = [];
          for (const c of `${base ? `${base}/` : ""}${rel}`.split("/")) {
            if (c === "" || c === ".") continue;
            if (c === "..") { if (!out.length) return null; out.pop(); } else out.push(c);
          }
          return out.join("/");
        };
        const done = new Set(), touched = [];
        let queue = docs.map((f) => [f, 0]);
        while (queue.length) {
          const [f, depth] = queue.shift();
          if (done.has(f)) continue;
          done.add(f);
          if (!inRef.has(f)) { await remove(f); touched.push(f); continue; }
          await write(f);
          touched.push(f);
          if (depth >= 5) continue;
          const text = (await git(["show", `${ref}:${f}`])).out;
          const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
          for (const m of text.matchAll(/(?:^|\s)@([^\s`'"()<>]+)/g)) {
            const rel = m[1].replace(/[.,;:]+$/, "");
            if (!rel || rel.startsWith("/") || rel.startsWith("~") || rel.includes("@")) continue;
            const target = norm(dir, rel);
            if (target) queue.push([target, depth + 1]);
          }
        }
        // Que git no los muestre como cambios (con sparse-checkout, --skip-worktree no se sostiene).
        const tracked = new Set((await git(["ls-files"], path)).out.split("\n"));
        const mark = touched.filter((f) => tracked.has(f));
        if (mark.length) await git(["update-index", "--assume-unchanged", "--", ...mark], path);
      }
      // En su proyecto; si el repo no está abierto en Herdr, un proyecto nuevo para él.
      // Todo en modo skip, como cc / cx. Claude sin settings del proyecto (igual quedaron
      // afuera). Codex no tiene la skill: le paso el SKILL.md de Claude para que la siga.
      const codex = !own && who === "codex";
      const argv = own ? ["claude", "--dangerously-skip-permissions"]
        : codex ? ["codex", "--dangerously-bypass-approvals-and-sandbox"]
        : ["claude", "--setting-sources", "user", "--dangerously-skip-permissions"];
      const task = own ? prAsk("fix", pr.number, pr.repo)
        : codex && hasSkill("pr-review") ? `Seguí la skill pr-review (${userHome}/.claude/skills/pr-review/SKILL.md) para el PR #${pr.number} de ${pr.repo}. Argumento: ${pr.number}.`
        : prAsk("review", pr.number, pr.repo);
      // Se llama como su rama (rv/PR-<n> o la de mi PR): pestaña y, en Claude, la sesión.
      const name = branch.replace(prefixRe(), "");
      if (argv[0] === "claude") argv.push("-n", name);
      if (space) run("tab.new", { space, name, folder: path, argv, task });
      else run("space.new", { name: pr.repo.split("/")[1], folder: path, argv, task });
    } catch (e) { fail(String(e)); }
  }

  render(cx) {
    const t = theme();
    // Cambio de proyecto (o de carpeta): recargar. render corre en cada cambio de spaces/panes.
    const space = spaces().find((s) => s.active);
    // Muestra lo guardado y lo actualiza igual: lo guardado puede tener hasta 2 minutos.
    if (space?.id !== this.spaceId || placeOf(space) !== this.folder) this.load(cx, true);

    const entry = this.cache.get(this.key());
    const issues = entry?.issues ?? [];
    const pill = (id, label) => {
      const on = this.filter === id;
      return div().id(`f-${id}`).px(9).py(3).rounded(6).text_size(12.75).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setFilter(id, cx)).child(label);
    };
    const label = (l) => div().px(6).rounded(4).text_size(11.25).flex_none()
      .bg(`#${l.color}33`).text_color(`#${l.color}`).child(l.name);
    const agentButton = (i, a) => {
      const c = t[a.color];
      return h_flex().id(`${a.id}-${i.number}`).flex_none().h(21).px(6).gap(4).items_center().rounded(5).cursor_pointer()
        .text_size(11.75).font_semibold().text_color(c).bg(`${c}22`).border(1).border_color(`${c}55`)
        .hover((s) => s.bg(`${c}44`).border_color(c))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async () => this.agentFor(i, a)); })
        .child(image(a.icon).size(11.75)).child(a.label);
    };
    const pedidoButton = (i) => {
      const done = this.pedidos?.has(i.number);
      const c = t.accent;
      return h_flex().id(`pedido-${i.number}`).flex_none().h(21).px(6).gap(4).items_center().rounded(5)
        .text_size(11.75).font_semibold().text_color(done ? t.dim : c).border(1).border_color(done ? t.border : `${c}55`)
        .when(!done, (el) => el.cursor_pointer().bg(`${c}22`).hover((s) => s.bg(`${c}44`).border_color(c))
          .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => this.makePedido(i, cx)); }))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .tooltip(done ? "ya es un pedido: está en el árbol de agentes" : "rama del pedido, sin agente: le colgás otras desde el árbol")
        .child(svg("mods/workspace-chrome/branch.svg").size(11.75)).child(done ? "Pedido ✓" : "Pedido");
    };
    const row = (i) => v_flex().id(`is-${i.number}`).px(12).py(7).gap(4).cursor_pointer().border_b(1).border_color(t.border)
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("open", [i.url]))
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().text_color(t.dim).text_size(12.75).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).text_color(t.foreground).text_size(13.5).child(i.title))
        .child(div().flex_none().text_size(11.75).text_color(t.dim).child(ago(i.updatedAt)))
        .child(v_flex().flex_none().gap(3).children(AGENTS.map((a) => agentButton(i, a))).child(pedidoButton(i))))
      .when(i.labels.length > 0 || i.assignees.length > 0, (el) => el.child(h_flex().pl(35).gap(4).flex_wrap()
        .children(i.labels.map(label))
        .when(this.filter === "all" && i.assignees.length > 0, (el) => el.child(div().text_size(11.25).text_color(t.muted).child(i.assignees.map((a) => `@${a.login}`).join(" "))))));

    // --- Mis PRs y Reviews (todos los repos) ---
    const data = shared("herdr-mod.prs") ?? {};
    // Los repos del proyecto en el que estoy: el de la terminal enfocada y los que la
    // lista de agentes asoció a este space (aunque la terminal esté en otra carpeta).
    const activeId = spaces().find((x) => x.active)?.id;
    const hereSet = new Set([this.repo?.slug, ...Object.entries(data.repos ?? {}).filter(([, r]) => r.space && r.space === activeId).map(([slug]) => slug)].filter(Boolean));
    const here = this.repo?.slug;
    const isHere = (r) => hereSet.has(r);
    const byHere = (a, b) => isHere(b.repo) - isHere(a.repo);
    const mine = [...(data.mine ?? [])].sort((a, b) => b.needs - a.needs || byHere(a, b) || Date.parse(b.updated) - Date.parse(a.updated));
    const reviews = [...(data.reviews ?? [])].sort((a, b) => a.draft - b.draft || byHere(a, b) || Date.parse(a.asked_at) - Date.parse(b.asked_at));
    const needCount = mine.filter((p) => p.needs).length;
    // Piden algo: pedidas o respondidas después de mi review. Las ya revisadas sin novedad se ven, no cuentan.
    const rrPending = (p) => !p.draft && p.status !== "reviewed";
    const rrCount = reviews.filter(rrPending).length;
    const chip = (text, color, strong = false) => div().flex_none().px(6).h(18).rounded(4).flex().items_center().text_size(11.25)
      .when(strong, (el) => el.font_semibold()).bg(`${color}26`).text_color(color).child(text);
    const plural = (n, a) => `${n} ${a}${n > 1 ? "s" : ""}`;
    const action = (id, label, color, fn, tip) => {
      const ok = Boolean(fn);
      return div().id(id).flex_none().h(21).px(7).rounded(5).flex().items_center().text_size(11.75).font_semibold()
        .text_color(ok ? color : t.dim).border(1).border_color(ok ? `${color}55` : t.border)
        .when(ok, (el) => el.cursor_pointer().bg(`${color}22`).hover((s) => s.bg(`${color}44`).border_color(color))
          .on_click((_e, cx) => { cx.stop_propagation(); fn(); }))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(Boolean(tip), (el) => el.tooltip(tip)).child(label);
    };
    const repoName = (r) => r.split("/")[1];
    const head = (pr, when, grouped = false) => h_flex().gap(8).items_start()
      .child(div().flex_1().min_w(0).text_size(13.5).text_color(t.foreground)
        .child(div().text_size(11.75).text_color(isHere(pr.repo) ? t.accent : t.dim).child(grouped ? `#${pr.number}` : `${repoName(pr.repo)} #${pr.number}`))
        .child(div().child(pr.title)))
      .child(div().flex_none().text_size(11.75).text_color(t.dim).child(when));
    // Raya de color a la izquierda: lo que te toca (rojo si está trabado o hace más de un día).
    const strip = (c) => div().absolute().left(0).top(0).bottom(0).w(3).bg(c);
    const known = (r) => Boolean(data.repos?.[r]);
    const noRepo = "no encuentro ese repo: ni abierto en Herdr ni clonado en ~/Projects";

    const prRow = (pr) => {
      const chips = [];
      if (pr.changes) chips.push(chip("cambios pedidos", t.blocked, true));
      if (pr.threads) chips.push(chip(`${plural(pr.threads, "hilo")} sin responder`, t.ansi3, true));
      if (pr.comments) chips.push(chip(`${plural(pr.comments, "comentario")} nuevo${pr.comments > 1 ? "s" : ""}`, t.ansi3, true));
      if (pr.ci === "fail") chips.push(chip("CI ✗", t.blocked, true));
      if (pr.conflict) chips.push(chip("conflicto", t.blocked, true));
      if (pr.decision === "APPROVED") chips.push(chip("aprobado", t.ansi2));
      if (!pr.needs && pr.decision !== "APPROVED") chips.push(chip(pr.reviewers.length ? `esperando a ${pr.reviewers.join(", ")}` : pr.reviewed_by.length ? `revisado por ${pr.reviewed_by.join(", ")}` : "sin reviewer", t.muted));
      if (pr.ci === "pending") chips.push(chip("CI …", t.muted));
      if (pr.draft) chips.push(chip("borrador", t.dim));
      if (pr.bots) chips.push(chip(`bots ${pr.bots}`, t.dim).id(`bots-${pr.repo}-${pr.number}`).tooltip("comentarios de bots sin responder (no cuentan como pendientes)"));
      return v_flex().id(`pr-${pr.repo}-${pr.number}`).relative().px(12).py(8).gap(5).cursor_pointer().border_b(1).border_color(t.border)
        .when(pr.needs, (el) => el.child(strip(pr.changes || pr.ci === "fail" || pr.conflict ? t.blocked : t.ansi3)))
        .hover((s) => s.bg(t.hover))
        .on_click(() => exec("open", [pr.url]))
        .tooltip(pr.talk ? "clic: abre el último comentario" : "clic: abre el PR")
        .child(head(pr, ago(pr.updated), true))
        .child(h_flex().gap(4).flex_wrap().items_center().children(chips)
          .child(div().flex_1())
          .when(pr.talk, (el) => el.child(action(`fix-${pr.repo}-${pr.number}`, prLabel("fix"), t.ansi5,
            known(pr.repo) ? () => this.agentForPr(pr, "/pr-fix") : null,
            known(pr.repo) ? "Claude en la rama del PR atiende los comentarios (si ya hay un agente ahí, se lo escribe)" : noRepo))));
    };
    const MY_STATE = { COMMENTED: ["comentaste", t.muted], APPROVED: ["aprobaste", t.ansi2], CHANGES_REQUESTED: ["pediste cambios", t.ansi3], DISMISSED: ["tu review se descartó", t.dim] };
    const rrRow = (pr) => v_flex().id(`rr-${pr.repo}-${pr.number}`).relative().px(12).py(8).gap(5).cursor_pointer().border_b(1).border_color(t.border)
      .when(rrPending(pr), (el) => el.child(strip(Date.now() - Date.parse(pr.asked_at) > 86400000 ? t.blocked : t.ansi5)))
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("open", [pr.url]))
      .tooltip(pr.status === "answered" ? "clic: abre lo último que te respondieron" : "clic: abre el PR")
      .child(head(pr, ago(pr.status === "reviewed" ? pr.reviewed_at : pr.asked_at)))
      .child(h_flex().gap(4).flex_wrap().items_center()
        .child(chip(`@${pr.author}`, t.muted))
        .when(Boolean(MY_STATE[pr.my_state]), (el) => el.child(chip(MY_STATE[pr.my_state][0], MY_STATE[pr.my_state][1])))
        .when(pr.status === "answered", (el) => el.child(chip(`te respondió: ${pr.why}`, t.accent, true)))
        .child(chip(`+${pr.plus} −${pr.minus}`, pr.plus + pr.minus > 1000 ? t.ansi3 : t.muted))
        .when(pr.again, (el) => el.child(chip("te lo volvieron a pedir", t.accent, true)))
        .when(pr.draft, (el) => el.child(chip("borrador", t.dim)))
        .child(div().flex_1())
        .child(action(`review-${pr.repo}-${pr.number}`, `${prLabel("review")} cc`, t.ansi5,
          known(pr.repo) ? () => this.agentForPr(pr, "/pr-review", "claude") : null,
          known(pr.repo) ? `Claude en modo skip, en la rama rv/PR-${pr.number} del proyecto, hace la review (publica solo con tu go)` : noRepo))
        .child(action(`review-cx-${pr.repo}-${pr.number}`, "cx", t.ansi4,
          known(pr.repo) ? () => this.agentForPr(pr, "/pr-review", "codex") : null,
          known(pr.repo) ? `Codex en modo yolo, en la rama rv/PR-${pr.number} del proyecto, sigue la skill pr-review (publica solo con tu go)` : noRepo)));
    const group = (title, items, fn, color = t.muted) => items.length === 0 ? [] : [
      div().px(12).pt(10).pb(5).text_size(11).font_semibold().text_color(color).child(`${title.toUpperCase()} · ${items.length}`),
      ...items.map(fn)];
    const prsBody = () => {
      if (!data.at) return [div().p(12).text_color(data.error ? t.blocked : t.dim).child(data.error ?? "Buscando tus PRs en GitHub…")];
      if (this.section === "prs") {
        if (!mine.length) return [div().p(12).text_color(t.dim).child("No tenés PRs abiertos.")];
        // Agrupados por repo; dentro, lo que me toca primero (mine ya viene así ordenado).
        // Los repos con algo que me toca primero, después por el último movimiento.
        const byRepo = (list) => {
          const m = new Map();
          for (const p of list) (m.get(p.repo) ?? m.set(p.repo, []).get(p.repo)).push(p);
          const last = (ps) => Math.max(...ps.map((p) => Date.parse(p.updated)));
          return [...m.entries()].sort(([, a], [, b]) => b.some((p) => p.needs) - a.some((p) => p.needs) || last(b) - last(a));
        };
        const repoHead = (repo, ps, color) => {
          const n = ps.filter((p) => p.needs).length;
          return h_flex().px(12).pt(12).pb(5).gap(6).items_center()
            .child(div().flex_none().text_size(11).font_semibold().text_color(color).child(`${repoName(repo).toUpperCase()} · ${ps.length}`))
            .when(n > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi3).child(`te toca ${n}`)));
        };
        const section = (list, color) => byRepo(list).flatMap(([repo, ps]) => [repoHead(repo, ps, color), ...ps.map(prRow)]);
        const mineHere = mine.filter((p) => isHere(p.repo)), others = mine.filter((p) => !isHere(p.repo));
        // El proyecto actual en su propio recuadro, bien separado del resto.
        const box = mineHere.length ? [
          v_flex().id("prs-here").mx(8).mt(8).rounded(8).overflow_hidden().border(1).border_color(`${t.accent}88`).bg(`${t.accent}14`)
            .child(div().px(12).pt(8).text_size(10.5).font_semibold().text_color(t.accent).child("ESTE PROYECTO"))
            .children(section(mineHere, t.accent))] : [];
        const sep = mineHere.length && others.length ? [h_flex().px(12).pt(26).pb(2).gap(8).items_center()
          .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child("OTROS PROYECTOS"))
          .child(div().flex_1().h(1).bg(t.border))] : [];
        return [...box, ...sep, ...section(others, t.muted)];
      }
      if (!reviews.length) return [div().p(12).text_color(t.dim).child("No tenés reviews abiertas. 🎉")];
      return [...group("Te pidieron review", reviews.filter((p) => !p.draft && p.status === "asked"), rrRow),
        ...group("Te respondieron", reviews.filter((p) => !p.draft && p.status === "answered"), rrRow),
        ...group("Ya revisaste", reviews.filter((p) => !p.draft && p.status === "reviewed").sort((a, b) => byHere(a, b) || Date.parse(b.reviewed_at) - Date.parse(a.reviewed_at)), rrRow),
        ...group("Borradores", reviews.filter((p) => p.draft), rrRow)];
    };
    const updated = data.at ? `${data.error ? "⚠ " : ""}${Date.now() - data.at < 60000 ? "recién" : `hace ${ago(new Date(data.at).toISOString())}`}` : "";

    const segment = (id, label, n, hot) => {
      const on = this.section === id;
      return h_flex().id(`sec-${id}`).flex_1().h(26).gap(5).justify_center().items_center().rounded(6).text_size(12.75).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setSection(id, cx)).child(label)
        .when(n > 0, (el) => el.child(div().px(5).rounded(8).text_size(10.5).font_semibold().bg(`${hot}33`).text_color(hot).child(String(n))));
    };
    const issuesSection = this.section === "issues";

    return v_flex().size_full().bg(t.chrome).text_color(t.foreground).text_size(12.75)
      .child(h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).flex_none()
        .child(svg("mods/herdr-mod/assets/github.svg").size(15).text_color(t.muted))
        .child(h_flex().id("repo-link").flex_1().min_w(0).gap(5).items_center()
          .when(Boolean(this.repo?.slug), (el) => el.cursor_pointer().hover((s) => s.text_color(t.accent))
            .on_click(() => exec("open", [`https://github.com/${this.repo.slug}`])))
          .child(div().min_w(0).truncate().text_size(13.5).font_semibold().child(this.repo?.slug ?? "GitHub"))
          .when(Boolean(this.repo?.slug), (el) => el.child(div().flex_none().text_size(11.75).text_color(t.dim).child("↗"))))
        .child(div().id("refresh").px(6).rounded(5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.load(cx, true); setShared("herdr-mod.prs.refresh", Date.now()); setShared("herdr-mod.prs.loading", true); cx.notify(); })
          .tooltip("Actualizar issues, PRs y reviews")
          .child(this.loading || shared("herdr-mod.prs.loading")
            ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.accent).spin(900)
            : div().child("↻"))))
      .child(h_flex().px(8).pt(8).gap(4).flex_none()
        .child(segment("issues", "Issues", 0, t.muted))
        .child(segment("prs", "Mis PRs", needCount, t.ansi3))
        .child(segment("reviews", "Reviews", rrCount, t.ansi5)))
      .child(h_flex().px(12).py(8).gap(6).items_center().flex_none()
        .when(issuesSection, (el) => el.child(pill("mine", "Míos")).child(pill("all", "Todos")))
        .when(!issuesSection, (el) => el.child(div().text_size(11.75).text_color(t.dim).child("todos tus repos")))
        .child(div().flex_1())
        .child(div().text_size(11.75).text_color(t.dim).child(issuesSection ? (entry && !entry.error ? `${issues.length} abiertos` : "") : updated)))
      .when(!issuesSection, (el) => el.child(v_flex().id("prs").flex_1().min_h(0).overflow_y_scrollbar().children(prsBody())))
      .when(issuesSection, (el) => el.child(v_flex().id("issues").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().p(12).text_color(t.muted).child(this.error)))
        .when(!this.error && Boolean(entry?.error), (el) => el.child(div().p(12).text_color(t.blocked).child(entry.error)))
        .when(!this.error && !entry, (el) => el.child(div().p(12).text_color(t.dim).child("Cargando issues…")))
        .when(!this.error && entry && !entry.error && issues.length === 0, (el) => el.child(div().p(12).text_color(t.dim)
          .child(this.filter === "mine" ? "No tenés issues asignados." : "No hay issues abiertos.")))
        .children(this.error ? [] : issues.map(row))));
  }
}
