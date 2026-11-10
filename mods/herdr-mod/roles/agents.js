// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
// tips de atajos.
import { exec, home, notify, agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";
import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("agents");

const tip = (...items) => setShared("herdr-mod.tip", { items: items.map(([action, text]) => ({ action, text })), at: Date.now() });
const rowTip = (a) => (a.status === "blocked" || a.status === "done")
  ? tip(["herdr-mod.waiting", "ver quién te espera"])
  : tip(["herdr-mod.buscar", "buscar un agente"], ["agent.next", "agente siguiente"], ["herdr-mod.waiting", "ver quién te espera"]);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
// Los colores de los compañeros de Claude, en la paleta del tema.
const MATE_COLOR = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", cyan: "ansi6", orange: "ansi9", pink: "ansi13" };
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("herdr-mod.agents.sort")) ?? SORTS[1];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    this.parents = JSON.parse(localStorage.getItem("parents") ?? "{}"); // agente -> agente que lo contiene (solo a la vista)
    cx.timer.every(30000, (cx) => cx.notify());
    // arbol de ramas por proyecto (branch.<b>.herdrBase / herdrPedido en git).
    this.chains = {};
    cx.timer.every(15000, (cx) => this.loadChains(cx));
    // Otro mod (GitHub, el dialogo de agente) cambio una cadena: recargar ya.
    this.chainsAt = shared("herdr-mod.chains.at") ?? 0; // lo mira el timer de 1 s de abajo
    this.loadChains(cx);
    // compañeros de los equipos de Claude (agent teams), por terminal.
    this.teams = {};
    cx.timer.every(5000, (cx) => this.loadTeams(cx));
    this.loadTeams(cx);
    // qué hace cada agente (agentes.py, cada 5 s; con una extensión al lado, también
    // su etapa) y los PRs míos
    // con comentarios nuevos (cada 2 min). Todo lo que pide atención va a
    // shared("herdr-mod.alerts") para la barra de abajo y ⌘J.
    this.lk = {};
    this.prs = null;
    // agentes dormidos (2 h sin uso): salen con /exit y vuelven con --resume.
    this.sleeping = JSON.parse(localStorage.getItem("sleeping") ?? "{}");
    cx.timer.every(60000, (cx) => this.sleepIdle(cx));
    cx.timer.after(30000, (cx) => this.sleepIdle(cx));
    this.reviewWarned = new Set();
    cx.timer.every(5000, (cx) => this.loadEstado(cx));
    this.loadEstado(cx);
    // /pr-review y /pr-fix (skills, si las tenés): si no están instaladas, los botones de PR
    // mandan un pedido común. shared("herdr-mod.skills") = { "pr-review": bool, "pr-fix": bool }.
    const skills = (cx) => cx.spawn(async () => {
      const r = await exec("sh", ["-c", 'for s in pr-review pr-fix; do [ -f "$HOME/.claude/skills/$s/SKILL.md" ] && echo $s; done']);
      const have = new Set((r.stdout ?? "").split("\n").filter(Boolean));
      setShared("herdr-mod.skills", { "pr-review": have.has("pr-review"), "pr-fix": have.has("pr-fix") });
    });
    skills(cx);
    cx.timer.every(600000, skills);
    cx.timer.every(120000, (cx) => this.loadReviews(cx));
    cx.timer.after(4000, (cx) => this.loadReviews(cx));
    cx.timer.after(25000, (cx) => this.loadReviews(cx)); // con los proyectos ya cargados
    // ⌘J y la barra piden descartar un aviso de PR o actualizar ya.
    // ↻ del panel GitHub pide actualizar ya.
    // Un solo timer de 1 s para todo lo que piden los otros mods (cada llamada a JS cuesta).
    cx.timer.every(1000, (cx) => {
      const at = shared("herdr-mod.chains.at") ?? 0;
      if (at > this.chainsAt) { this.chainsAt = at; this.loadChains(cx); }
      const d = shared("herdr-mod.alerts.dismiss");
      if (d && d.at > (this.dismissAt ?? 0)) { this.dismissAt = d.at; this.dismissPr(d.key); this.publishAlerts(); cx.notify(); }
      const f = shared("herdr-mod.prs.refresh");
      if (f && f > (this.refreshAt ?? 0)) { this.refreshAt = f; this.loadReviews(cx); }
      // Mirar un agente dormido lo despierta.
      const pane = focused()?.pane;
      const z = pane && Object.values(this.sleeping).find((r) => r.pane === pane);
      if (z && !agents().some((a) => a.address === z.addr)) { this.wake(z.addr); cx.notify(); } // si todavía está saliendo, al próximo tick
    });
  }

  // Avisos: un compañero que termina su turno (con lo que contesto) y, cuando
  // terminan todos, el equipo entero. Solo cambios, nunca al arrancar.
  announce(before, after) {
    for (const [lead, mates] of Object.entries(after)) {
      const was = new Map((before[lead] ?? []).map((m) => [m.name, m.status]));
      const done = mates.filter((m) => m.status === "idle" && was.get(m.name) === "working");
      if (!done.length) continue;
      const who = panes().find((p) => p.terminal === lead)?.branch?.replace(prefixRe(), "") || lead;
      const all = mates.every((m) => m.status === "idle");
      for (const m of done) {
        notify({ title: all && m === done.at(-1) ? `Equipo de ${who}: terminaron todos` : `${m.name} terminó (${who})`, body: m.said ?? "", level: "info", timeout: 8000 });
      }
    }
  }

  loadEstado(cx) {
    if (this.loadingLk) return;
    this.loadingLk = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${home()}/.config/herdr-app/mods/herdr-mod/scripts/agentes.py`]);
        const next = JSON.parse(r.stdout || "{}");
        // Una revisión cruzada que pasa los 15 min: aviso, una vez por proceso.
        for (const [addr, st] of Object.entries(next)) {
          const rv = st.review;
          if (rv && rv.secs >= 900 && !this.reviewWarned.has(rv.pid)) {
            this.reviewWarned.add(rv.pid);
            notify({ title: `La revisión de ${rv.tool} de ${this.who(addr)} lleva ${Math.floor(rv.secs / 60)} min`, body: "Puede estar colgada: la cortás desde la barra de abajo o ⌘J.", level: "warning", timeout: 10000 });
          }
        }
        if (JSON.stringify(next) !== JSON.stringify(this.lk)) {
          this.lk = next;
          this.syncNames();
          setShared("herdr-mod.estado", next);
          this.publishAlerts();
          cx.notify();
        }
      } catch {}
      this.loadingLk = false;
    });
  }

  // La sesión de Claude se llama como el agente: si no (Claude le inventó uno, o le
  // cambiaste el nombre en Herdr), le mando /rename. Solo con el agente quieto y sin
  // foco, para no mezclarlo con lo que estés escribiendo; un intento cada 2 min.
  syncNames() {
    const now = Date.now();
    this.renameSent ??= {};
    for (const a of agents()) {
      const st = this.lk?.[a.address], want = this.names?.[a.address];
      if (!st || st.agent !== "claude-code" || !st.session || !want || st.session_name === want) continue;
      if (a.focused || !["idle", "done"].includes(a.status)) continue;
      const sent = this.renameSent[a.address];
      if (sent && sent.name === want && now - sent.at < 120000) continue;
      this.renameSent[a.address] = { name: want, at: now };
      exec("hc", ["send", a.address, `/rename ${want}`]);
    }
  }

  // La rama (sin prefijo) del agente, o su programa.
  who(addr) {
    const p = panes().find((x) => x.terminal === addr);
    return this.names?.[addr] || p?.branch?.replace(prefixRe(), "") || terminals().find((k) => k.address === addr)?.program?.name || addr;
  }

  // GitHub, en todos mis repos (scripts/prs.py, cada 2 min): mis PRs
  // abiertos (si me toca: hilos sin responder, comentarios nuevos, cambios pedidos,
  // CI, conflictos) y los que me pidieron revisar. Va a shared("herdr-mod.prs") para
  // el panel GitHub, con repos = {"dueño/repo": checkout local de algún proyecto}.
  // Avisa lo nuevo (la primera vez, sin aviso) y una vez por día lo que lleva más
  // de un día esperando.
  loadReviews(cx) {
    if (this.loadingReviews) return;
    this.loadingReviews = true;
    setShared("herdr-mod.prs.loading", true); // el ↻ del panel GitHub gira
    cx.spawn(async (cx) => {
      try {
        const repos = {};
        for (const sp of spaces()) {
          const c = this.chains[sp.id];
          if (!c?.cwd) continue;
          const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: c.cwd, on: c.on });
          if (common.code !== 0) continue;
          const main = common.stdout.trim().replace(/\/\.git$/, "");
          const url = await exec("git", ["remote", "get-url", "origin"], { cwd: main, on: c.on });
          const slug = (url.stdout ?? "").trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
          if (slug && !repos[slug]) repos[slug] = { main, on: c.on, space: sp.id };
        }
        const r = await exec("python3", [`${home()}/.config/herdr-app/mods/herdr-mod/scripts/prs.py`, ...cfg().projects]);
        const data = JSON.parse(r.stdout || "{}");
        if (data.error || !data.mine) {
          const at = Date.now();
          setShared("herdr-mod.prs", { ...(shared("herdr-mod.prs") ?? {}), error: data.error ?? "gh no respondió", repos, at });
          setShared("herdr-mod.prs.at", at); // que el panel muestre el ⚠
        } else {
          this.prs = data;
          // Los repos que no están abiertos en Herdr pero sí clonados en ~/Projects.
          for (const [slug, main] of Object.entries(data.clones ?? {})) repos[slug] ??= { main, on: null, space: null };
          const at = Date.now();
          setShared("herdr-mod.prs", { ...data, clones: undefined, repos, at });
          setShared("herdr-mod.prs.at", at); // chico: para ver si cambió sin traer todo
          this.announcePrs(data);
        }
        this.publishAlerts();
        cx.notify();
      } catch {}
      this.loadingReviews = false;
      setShared("herdr-mod.prs.loading", false);
    });
  }

  announcePrs(data) {
    const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    const first = localStorage.getItem("prtalk") == null;
    const talk = JSON.parse(localStorage.getItem("prtalk") ?? "{}");
    const asked = JSON.parse(localStorage.getItem("prasked") ?? "{}");
    const short = (pr) => `${pr.repo.split("/")[1]} #${pr.number}`;
    const nextTalk = {}, nextAsked = {};
    for (const pr of data.mine) {
      const key = `${pr.repo}#${pr.number}`, n = pr.threads + pr.comments + (pr.changes ? 1 : 0);
      nextTalk[key] = n;
      if (!first && n > (talk[key] ?? 0)) {
        notify({ title: `${short(pr)}: ${pr.changes && !(talk[key] > 0) ? "te pidieron cambios" : "te comentaron"}`, body: `${pr.title}\nEn GitHub › Mis PRs: /pr-fix con un clic.`, level: "info", timeout: 12000 });
      }
    }
    // Reviews que piden algo: pedidas o que ya revisé y me respondieron ("reviewed" no avisa).
    const pending = data.reviews.filter((p) => p.status !== "reviewed");
    for (const pr of pending) {
      const key = `${pr.repo}#${pr.number}`;
      nextAsked[key] = pr.asked_at;
      if (!first && asked[key] !== pr.asked_at) {
        notify({ title: pr.status === "answered" ? `${pr.author} respondió tu review: ${short(pr)}` : `${pr.author} te pidió review${pr.again ? " otra vez" : ""}: ${short(pr)}`,
          body: `${pr.title}${pr.why ? `\n${pr.why}` : ""}\nEn GitHub › Reviews.`, level: "info", timeout: 12000 });
      }
    }
    store("prtalk", nextTalk); store("prasked", nextAsked);
    // Una vez por día: lo que lleva más de 24 h esperándote.
    const today = new Date().toDateString();
    if (localStorage.getItem("prnag") !== today) {
      const old = (iso) => iso && Date.now() - Date.parse(iso) > 86400000;
      const rr = pending.filter((p) => !p.draft && old(p.asked_at)).length;
      const ch = data.mine.filter((p) => p.changes && old(p.updated)).length;
      if (rr || ch) {
        localStorage.setItem("prnag", today);
        notify({ title: "Te están esperando en GitHub", body: [rr && `${rr} review${rr > 1 ? "s" : ""} esperándote hace más de un día`, ch && `${ch} PR${ch > 1 ? "s" : ""} tuyo${ch > 1 ? "s" : ""} con cambios pedidos`].filter(Boolean).join(" · "), level: "warning", timeout: 15000 });
      }
    }
  }

  // ✕ en ⌘J: silencia el aviso hasta que cambie (otro comentario, otro pedido).
  dismissPr(key) {
    const sig = this.prSig(key);
    if (sig == null) return;
    const mute = JSON.parse(localStorage.getItem("prmute") ?? "{}");
    mute[key] = sig;
    localStorage.setItem("prmute", JSON.stringify(mute));
  }

  prSig(key) {
    const pr = this.prs?.mine.find((p) => `${p.repo}#${p.number}` === key);
    if (pr) return `${pr.threads}:${pr.comments}:${pr.changes}:${pr.mine_at}`;
    const rr = this.prs?.reviews.find((p) => `rr:${p.repo}#${p.number}` === key);
    return rr ? rr.asked_at : null;
  }

  // Lo que pide atención: revisiones largas, agentes esperando go y PRs con comentarios.
  publishAlerts() {
    const out = [];
    for (const [addr, st] of Object.entries(this.lk)) {
      if (st.review && st.review.secs >= 600) out.push({ kind: "review", addr, who: this.who(addr), secs: st.review.secs, pid: st.review.pid, tool: st.review.tool, hung: st.review.secs >= 1200 });
      if (st.next) out.push({ kind: "go", addr, who: this.who(addr), next: st.next, stage: st.stage, size: st.size });
    }
    // Mis PRs con algo que contestar y las reviews que me pidieron (menos lo silenciado).
    const mute = JSON.parse(localStorage.getItem("prmute") ?? "{}");
    const plural = (n, a) => `${n} ${a}${n > 1 ? "s" : ""}`;
    for (const pr of this.prs?.mine ?? []) {
      const key = `${pr.repo}#${pr.number}`;
      if (!pr.talk || mute[key] === this.prSig(key)) continue;
      const agent = panes().find((p) => p.branch === pr.branch && p.program?.agent);
      const what = [pr.changes && "pidieron cambios", pr.threads && `${plural(pr.threads, "hilo")} sin responder`, pr.comments && `${plural(pr.comments, "comentario")} nuevo${pr.comments > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
      out.push({ kind: "pr", key, repo: pr.repo, number: pr.number, branch: pr.branch, url: pr.url, n: pr.threads + pr.comments, changes: pr.changes, what,
        who: `${pr.repo.split("/")[1]} #${pr.number}`, title: pr.title, addr: agent?.terminal ?? null });
    }
    for (const pr of this.prs?.reviews ?? []) {
      const key = `rr:${pr.repo}#${pr.number}`;
      if (pr.draft || pr.status === "reviewed" || mute[key] === pr.asked_at) continue;
      const what = pr.status === "answered" ? `${pr.author} respondió tu review: ${pr.why}` : `${pr.author} te pidió review${pr.again ? " otra vez" : ""} · +${pr.plus} −${pr.minus}`;
      out.push({ kind: "rr", key, repo: pr.repo, number: pr.number, url: pr.url, author: pr.author, asked_at: pr.asked_at, again: pr.again, status: pr.status,
        who: `${pr.repo.split("/")[1]} #${pr.number}`, title: pr.title, what, addr: null });
    }
    setShared("herdr-mod.alerts", out);
  }

  // Etapa (de una extensión) y revisión corriendo, como chips de la fila del agente.
  loopTags(t, a) {
    const st = this.lk?.[a.address];
    if (!st) return [];
    const out = [];
    if (st.stage) {
      const c = /^(design|spec|tickets|split)/.test(st.stage) ? t.ansi4 : /^(impl|fix|small|refactor)/.test(st.stage) ? t.ansi3 : /^pr/.test(st.stage) ? t.ansi2 : t.muted;
      out.push(div().id(`lk-${a.address}`).flex_none().px(5).rounded(4).text_size(10.5).font_semibold().bg(`${c}26`).text_color(c)
        .tooltip([`etapa: /${st.stage}`, st.size ? `tamaño ${st.size}${st.mode ? ` · modo ${st.mode}` : ""}` : null, st.activity, st.next ? `espera go para ${st.next}` : null].filter(Boolean).join("\n"))
        .child(`${st.size ? `${st.size} · ` : ""}${st.stage}`));
    }
    if (st.next) out.push(div().flex_none().px(5).rounded(4).text_size(10.5).font_semibold().bg(`${t.accent}26`).text_color(t.accent).child("go?"));
    if (st.review) {
      const m = Math.floor(st.review.secs / 60), c = st.review.secs >= 1200 ? t.blocked : st.review.secs >= 600 ? t.ansi3 : t.muted;
      out.push(div().id(`rv-${a.address}`).flex_none().px(5).rounded(4).text_size(10.5).font_semibold().bg(`${c}26`).text_color(c)
        .tooltip(`Revisión de ${st.review.tool} corriendo hace ${m} min`).child(`${st.review.tool} ${m}m`));
    }
    return out;
  }

  // teams.py lee ~/.claude/teams y devuelve { "t1b": [{ name, color, model, status, task }] }.
  loadTeams(cx) {
    if (this.loadingTeams) return;
    this.loadingTeams = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${home()}/.config/herdr-app/mods/herdr-mod/scripts/teams.py`]);
        const next = JSON.parse(r.stdout || "{}");
        if (JSON.stringify(next) !== JSON.stringify(this.teams)) {
          if (this.teamsLoaded) this.announce(this.teams, next);
          this.teams = next;
          setShared("herdr-mod.teams", next);
          cx.notify();
        }
        this.teamsLoaded = true;
      } catch {}
      this.loadingTeams = false;
    });
  }

  loadChains(cx) {
    if (this.loadingChains) return;
    this.loadingChains = true;
    cx.spawn(async (cx) => {
      const next = {};
      this.prs ??= {};
      for (const sp of spaces()) {
        const tabs = new Set(sp.tabs.map((x) => x.id));
        const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? sp.folder;
        if (!cwd) continue;
        try {
          const on = sp.machine ?? null;
          const git = async (args) => { const r = await exec("git", args, { cwd, on }); return { ok: r.code === 0, out: (r.stdout ?? "").trim() }; };
          const heads = new Set((await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).out.split("\n"));
          const r = await git(["config", "--get-regexp", "^branch\\..*\\.herdr(pedido|base|from)$"]);
          const base = {}, from = {}, pedidos = new Set();
          for (const line of r.out.split("\n").filter(Boolean)) {
            const at = line.indexOf(" "), key = line.slice(0, at), val = line.slice(at + 1);
            const name = key.slice("branch.".length, key.lastIndexOf("."));
            if (!heads.has(name)) continue;
            if (key.endsWith(".herdrbase") && heads.has(val)) base[name] = val;
            if (key.endsWith(".herdrfrom")) from[name] = val;
            if (key.endsWith(".herdrpedido") && val === "true") pedidos.add(name);
          }
          // Estado de cada rama del pedido: ✓ ya esta en el pedido, ● commits
          // propios sin mergear, ○ sin commits. Los propios: from..rama (herdrFrom;
          // sin el, fork-point y si no merge-base con su base).
          const pedidoOf = (b, seen = new Set()) => pedidos.has(b) ? b : base[b] && !seen.has(b) ? pedidoOf(base[b], seen.add(b)) : null;
          const state = {};
          for (const b of Object.keys(base)) {
            let start = from[b];
            if (!start) { const f = await git(["merge-base", "--fork-point", base[b], b]); start = f.ok && f.out ? f.out : (await git(["merge-base", base[b], b])).out; }
            const ahead = Number((await git(["rev-list", "--count", `${start}..${b}`])).out) || 0;
            const ped = pedidoOf(b);
            state[b] = { ahead, merged: ahead > 0 && Boolean(ped) && (await git(["merge-base", "--is-ancestor", b, ped])).ok };
          }
          // PRs por rama: gh es lento, cada 2 minutos por repo.
          const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).out;
          const cache = this.prs[common];
          if ((pedidos.size || Object.keys(base).length) && (!cache || Date.now() - cache.at > 120000)) {
            const pr = await exec("gh", ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,headRefName,state,isDraft"], { cwd, on });
            this.prs[common] = { at: Date.now(), by: Object.fromEntries((pr.code === 0 ? JSON.parse(pr.stdout) : []).map((x) => [x.headRefName, x])) };
          }
          next[sp.id] = { base, pedidos, state, prs: this.prs[common]?.by ?? {}, cwd, on };
        } catch {}
      }
      this.chains = next;
      this.loadingChains = false;
      cx.notify();
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("herdr-mod.agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // Arrastrar y soltar en el arbol (this.drag vive del mouse_down al mouse_up; salir
  // de la lista lo cancela). Destinos: "a:<terminal>" (un agente), "b:<rama>" (una
  // rama sin agente, p. ej. un pedido) o null (el titulo del proyecto).
  // - Un agente sobre otro agente: queda adentro de ese, solo a la vista
  //   (localStorage "parents"; git no se toca). Sobre el titulo: vuelve a su lugar.
  // - Sobre una rama sin agente, o una rama sin agente sobre lo que sea: la rama pasa
  //   a colgar de esa (branch.<rama>.herdrBase; el codigo no se toca). Sobre el
  //   titulo: queda sin base.
  targetBranch(target) {
    if (!target) return null;
    if (target.startsWith("b:")) return target.slice(2);
    return panes().find((p) => p.terminal === target.slice(2))?.branch ?? null;
  }

  canDrop(d, target) {
    if (!d || target === d.src) return false;
    const base = this.chains[d.space]?.base ?? {};
    if (target === null) return Boolean(d.addr && this.parents[d.addr]) || Boolean(d.b && base[d.b]);
    if (d.addr && target.startsWith("a:")) {
      const to = target.slice(2);
      if (this.parents[d.addr] === to) return false;
      const sp = agents().find((a) => a.address === to)?.space ?? this.sleeping[to]?.space;
      if (sp && sp !== d.space) return false; // solo dentro del mismo proyecto
      for (let x = to, seen = new Set(); x && !seen.has(x); x = this.parents[x]) { if (x === d.addr) return false; seen.add(x); }
      return true;
    }
    const tb = this.targetBranch(target);
    if (!d.b || !tb || tb === d.b) return false;
    for (let x = tb, seen = new Set(); x && !seen.has(x); x = base[x]) { if (x === d.b) return false; seen.add(x); }
    return base[d.b] !== tb;
  }

  dragOver(target, cx) {
    const d = this.drag;
    if (!d || d.over === target) return;
    d.over = target;
    if (target !== d.src) d.moving = true;
    cx.notify();
  }

  setParents(next) {
    this.parents = next;
    localStorage.setItem("parents", JSON.stringify(next));
  }

  dropOn(target, cx) {
    const d = this.drag;
    this.drag = null;
    cx.notify();
    if (!d?.moving || !this.canDrop(d, target)) return;
    const short = (b) => b.replace(prefixRe(), "");
    // El nombre que le pusiste (su pestaña), si no la rama.
    const nameOf = (addr) => {
      const tab = agents().find((a) => a.address === addr)?.tab;
      const named = tab && spaces().flatMap((s) => s.tabs).find((x) => x.id === tab && x.named);
      return named?.name || this.who(addr);
    };
    // Agente adentro de otro, o de vuelta a su lugar: solo a la vista.
    if (d.addr && (target === null ? this.parents[d.addr] : target.startsWith("a:"))) {
      const next = { ...this.parents };
      if (target === null) delete next[d.addr]; else next[d.addr] = target.slice(2);
      this.setParents(next);
      notify({ title: target === null ? `${nameOf(d.addr)} volvió a su lugar` : `${nameOf(d.addr)} ahora está dentro de ${nameOf(target.slice(2))}`,
        body: "Solo a la vista: ni la rama ni el código cambian. Soltalo sobre el título del proyecto para sacarlo.", level: "info", timeout: 5000 });
      return;
    }
    const c = this.chains[d.space];
    if (!c?.cwd) return;
    const tb = this.targetBranch(target);
    cx.spawn(async () => {
      const args = target === null ? ["config", "--unset", `branch.${d.b}.herdrBase`] : ["config", `branch.${d.b}.herdrBase`, tb];
      const r = await exec("git", args, { cwd: c.cwd, on: c.on });
      if (r.code !== 0) return notify({ title: `No pude mover ${short(d.b)}`, body: (r.stderr || r.stdout || "").trim(), level: "error" });
      if (d.addr && this.parents[d.addr]) { const next = { ...this.parents }; delete next[d.addr]; this.setParents(next); }
      setShared("herdr-mod.chains.at", Date.now());
      notify({ title: target === null ? `${short(d.b)} quedó suelta` : `${short(d.b)} ahora cuelga de ${short(tb)}`, body: "Solo el árbol: el código no se tocó.", level: "info", timeout: 5000 });
    });
  }

  // Lo que tiene cada fila del arbol para arrastrar y soltar. src: {addr?, b?, space}; key: su destino.
  draggable(el, t, src, key) {
    const d = this.drag;
    const target = d?.moving && d.over === key;
    return el
      .on_mouse_down("left", () => { this.drag = { ...src, src: key, over: key, moving: false }; })
      .on_mouse_move((_e, cx) => this.dragOver(key, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOn(key, cx))
      .when(Boolean(d?.moving) && d.src === key, (el) => el.opacity(0.45))
      .when(Boolean(target) && this.canDrop(d, key), (el) => el.bg(`${t.accent}33`).border(1).border_color(t.accent))
      .when(Boolean(target) && !this.canDrop(d, key) && d.src !== key, (el) => el.bg(`${t.blocked}22`));
  }

  // ✓ ● ○ de una rama de pedido y su PR. Nada si la rama no es de ninguna cadena.
  branchTags(t, spaceId, b) {
    const c = this.chains[spaceId];
    if (!b || !c) return [];
    const out = [];
    // El pedido lo dice tenga o no agente.
    if (c.pedidos?.has(b)) out.push(div().flex_none().px(5).rounded(4).text_size(10.5).bg(`${t.accent}22`).text_color(t.accent).child("pedido"));
    const st = c.state?.[b];
    if (st) {
      const [mark, color, tip] = st.merged ? ["✓", t.ansi2, "ya está en el pedido"] : st.ahead > 0 ? ["●", t.accent, `${st.ahead} commit${st.ahead > 1 ? "s" : ""} sin mergear`] : ["○", t.dim, "sin commits"];
      out.push(div().id(`st-${b}`).flex_none().text_size(11).text_color(color).tooltip(tip).child(mark));
    }
    const pr = c.prs?.[b];
    if (pr) out.push(div().flex_none().px(4).rounded(4).text_size(10).bg(`${pr.state === "MERGED" ? t.ansi5 : t.ansi2}33`).text_color(pr.state === "MERGED" ? t.ansi5 : t.ansi2)
      .child(`#${pr.number}${pr.isDraft ? " draft" : pr.state === "MERGED" ? " ✓" : ""}`));
    return out;
  }

  // + : una rama nueva encima de `b`, con Claude o Codex (el dialogo pide issue y agente).
  plus(t, spaceId, b) {
    return div().id(`plus-${b}`).flex_none().px(4).rounded(4).text_size(13).font_semibold().text_color(t.accent).cursor_pointer()
      .tooltip(`agente nuevo en una rama encima de ${b.replace(prefixRe(), "")}`)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "herdr-mod", kind: "dialog", width: 520, height: 250, props: { role: "worktree", space: spaceId, id: "claude", choose: true, base: b } });
      })
      .child("+");
  }

  // Dormir: un agente de Claude o Codex sin uso hace 2 h (idle o done, sin mirar)
  // sale con /exit (Codex: /quit) y libera su RAM; la terminal queda con su shell.
  // Sigue en la lista, en gris con "zz"; al mirarlo (clic o yendo a su pestaña)
  // vuelve con `claude --resume <sesión>` (Codex: `codex resume`), con sus flags;
  // si nunca tuvo conversación, arranca de cero.
  // No se duerme: el fijado (pin), el que tiene compañeros de equipo o sub-agentes
  // vivos, el que corre una revisión, ni uno de otra máquina.
  sleepIdle(cx) {
    const SLEEP_MS = 2 * 3600 * 1000;
    const now = Date.now();
    const terms = new Map(terminals().map((k) => [k.address, k]));
    const listed = new Set(agents().map((a) => a.address));
    // Los que ya no hacen falta: la terminal se fue o alguien volvió a abrir el agente.
    for (const [addr, r] of Object.entries(this.sleeping)) {
      if (terms.get(addr)?.state !== "live" || listed.has(addr)) delete this.sleeping[addr];
    }
    // Los "adentro de" de agentes que ya no están.
    const gone = Object.entries(this.parents).filter(([k, v]) => !terms.has(k) || !terms.has(v));
    if (gone.length) { const next = { ...this.parents }; for (const [k] of gone) delete next[k]; this.setParents(next); }
    const me = focused()?.agent;
    const slept = [];
    for (const a of agents()) {
      const st = this.lk?.[a.address], k = terms.get(a.address);
      // Sin sesión (nunca charló): se duerme igual y despierta de cero, no pierde nada.
      if (!st || !["claude-code", "codex"].includes(st.agent)) continue;
      if (!["idle", "done"].includes(a.status) || a.focused || a.address === me || a.address.includes("/")) continue;
      if (this.pins.includes(a.address) || st.review || (this.teams?.[a.address] ?? []).length) continue;
      if (terminals().some((x) => x.parent === a.address && x.state === "live")) continue;
      // Desde cuándo está así: lo que anota track() (sobrevive reinicios); terminals() no lo trae.
      const since = this.since(a) || k?.status_ms;
      if (!since || now - since < SLEEP_MS) continue;
      this.sleeping[a.address] = {
        addr: a.address, pane: a.pane, space: a.space, space_name: a.space_name, program: a.program, seq: a.seq, title: a.title,
        kind: st.agent, session: st.session ?? null, argv: st.argv ?? [], at: now,
      };
      exec("hc", ["send", a.address, st.agent === "codex" ? "/quit" : "/exit"]);
      slept.push(this.who(a.address));
    }
    localStorage.setItem("sleeping", JSON.stringify(this.sleeping));
    if (slept.length) {
      notify({ title: `Dormí ${slept.length === 1 ? slept[0] : `${slept.length} agentes`}`, body: `${slept.length > 1 ? slept.join(", ") + ": " : ""}2 h sin uso. Siguen en la lista (zz); al abrirlos vuelven donde estaban.`, level: "info", timeout: 8000 });
      cx.notify();
    }
  }

  // El comando que lo trae de vuelta: sus mismos flags, sin la sesión vieja ni el prompt.
  resumeCmd(r) {
    const q = (x) => /^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`;
    if (r.kind === "codex") {
      // Con los mismos flags (modo yolo, sandbox, modelo…) que tenía.
      const CVAL = new Set(["-C", "--cd", "-i", "--image", "--local-provider", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile", "-c", "--config", "--add-dir", "--enable", "--disable"]);
      const out = ["codex"];
      if (r.session) out.push("resume");
      const argv = (r.argv ?? []).slice(1);
      for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (CVAL.has(x)) { out.push(x, argv[i + 1] ?? ""); i++; continue; }
        if (x.startsWith("-") && !["--last", "--all"].includes(x) && !out.includes(x)) out.push(x);
      }
      return [...out, ...(r.session ? [r.session] : [])].map(q).join(" ");
    }
    const VAL = new Set(["-n", "--name", "--teammate-mode", "--model", "--permission-mode", "--setting-sources", "--add-dir", "--agent", "--settings", "--mcp-config", "--fallback-model", "--append-system-prompt", "--system-prompt", "--effort"]);
    const SKIP_VAL = new Set(["--resume", "-r", "--session-id"]);
    const out = ["claude"];
    const argv = r.argv ?? [];
    for (let i = 1; i < argv.length; i++) {
      const x = argv[i];
      if (SKIP_VAL.has(x)) { i++; continue; }
      if (x === "--continue" || x === "-c") continue;
      if (VAL.has(x)) { out.push(x, argv[i + 1] ?? ""); i++; continue; }
      if (x.startsWith("-") && !out.includes(x)) out.push(x);
    }
    return [...out, ...(r.session ? ["--resume", r.session] : [])].map(q).join(" ");
  }

  wake(addr) {
    const r = this.sleeping[addr];
    if (!r) return;
    delete this.sleeping[addr];
    localStorage.setItem("sleeping", JSON.stringify(this.sleeping));
    // Si la sesión no dejó conversación (nunca charló), --resume no la encuentra: de cero.
    const check = r.kind === "claude-code" && r.session
      ? exec("sh", ["-c", `ls "$HOME"/.claude/projects/*/${r.session}.jsonl >/dev/null 2>&1`]).then((x) => x.code === 0)
      : Promise.resolve(true);
    check.then((ok) => exec("hc", ["send", addr, this.resumeCmd(ok ? r : { ...r, session: null })]));
  }

  // Los dormidos como filas de la lista, al lado de los de su proyecto.
  withSleeping(list) {
    const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
    const ps = new Set(panes().map((p) => p.pane));
    const out = [...list];
    for (const r of Object.values(this.sleeping)) {
      if (out.some((a) => a.address === r.addr) || !live.has(r.addr) || !ps.has(r.pane)) continue;
      const a = { address: r.addr, pane: r.pane, space: r.space, space_name: spaces().find((x) => x.id === r.space)?.name ?? r.space_name,
        program: r.program, seq: r.seq ?? 0, title: r.title, status: "sleep", focused: false, sleeping: true };
      let at = -1;
      out.forEach((x, i) => { if (x.space === a.space) at = i; });
      out.splice(at < 0 ? out.length : at + 1, 0, a);
    }
    return out;
  }

  // ✕ en un pedido: deja de ser pedido. Sus ramas pasan a colgar de la base del
  // pedido (o quedan sueltas) y la rama se borra si no tiene worktree ni commits
  // propios sin mergear (git branch -d, que no pierde nada); si no, queda como rama
  // común. Pide un segundo clic para confirmar.
  closeBtn(t, spaceId, b) {
    const sure = this.closing === b;
    return div().id(`close-${b}`).flex_none().px(5).h(18).rounded(4).flex().items_center().text_size(sure ? 10.5 : 12).font_semibold()
      .text_color(sure ? t.blocked : t.dim).when(sure, (el) => el.bg(`${t.blocked}22`)).cursor_pointer()
      .tooltip(sure ? "clic de nuevo para cerrar el pedido" : "cerrar el pedido")
      .hover((s) => s.bg(`${t.blocked}33`).text_color(t.blocked))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!sure) { this.closing = b; cx.notify(); return; }
        this.closing = null;
        cx.spawn(async (cx) => this.closePedido(spaceId, b, cx));
      })
      .child(sure ? "¿cerrar?" : "✕");
  }

  async closePedido(spaceId, b, cx) {
    const c = this.chains[spaceId];
    if (!c) return;
    const git = async (args) => { const r = await exec("git", args, { cwd: c.cwd, on: c.on }); return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() }; };
    const short = b.replace(prefixRe(), "");
    try {
      await git(["config", "--unset", `branch.${b}.herdrPedido`]);
      const up = c.base[b];
      for (const [k, v] of Object.entries(c.base)) {
        if (v !== b) continue;
        await git(up ? ["config", `branch.${k}.herdrBase`, up] : ["config", "--unset", `branch.${k}.herdrBase`]);
      }
      await git(["config", "--unset", `branch.${b}.herdrBase`]);
      await git(["config", "--unset", `branch.${b}.herdrFrom`]);
      const wt = (await git(["worktree", "list", "--porcelain"])).out.split("\n").includes(`branch refs/heads/${b}`);
      let note = "";
      if (wt) note = "La rama queda: tiene un worktree.";
      else {
        const del = await git(["branch", "-d", b]);
        note = del.ok ? "La rama se borró (no tenía nada sin mergear)." : "La rama queda: tiene commits sin mergear.";
      }
      notify({ title: `Pedido ${short} cerrado`, body: note, level: "info", timeout: 8000 });
    } catch (e) {
      notify({ title: `No pude cerrar el pedido ${short}`, body: String(e), level: "error" });
    }
    setShared("herdr-mod.chains.at", Date.now());
    cx.notify();
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  // despues de los de hc, los compañeros de su equipo de Claude. No son
  // terminales: viven dentro de la del agente (shift+flecha abajo para verlos).
  tree(all, addr, lead = []) {
    const program = all.find((x) => x.address === addr)?.program;
    const mates = (this.teams?.[addr] ?? []).map((m) => ({ address: `${addr}~${m.name}`, name: m.name, status: m.status, program, mate: m, lead: addr }));
    const kids = [...all.filter((k) => k.parent === addr && k.state === "live"), ...mates];
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...(k.mate ? [] : this.tree(all, k.address, [...lead, last ? "" : "│"])),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(k.mate), (el) => el.tooltip([k.mate.model, k.mate.task, ...(k.mate.recent ?? []).slice(0, 4).map((r) => `· ${r.text}`)].filter(Boolean).join("\n")))
      .on_click(() => {
        if (!k.mate) return this.peek(k.address);
        run("pane.focus", { terminal: k.lead });
        setShared("herdr-mod.tip", { items: [{ key: "⇧↓", text: "en Claude, pasar de un compañero a otro" }], at: Date.now() });
      })
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().when(!k.mate, (el) => el.flex_1()).when(Boolean(k.mate), (el) => el.flex_none().mr(7)).truncate().text_color(k.mate ? (t[MATE_COLOR[k.mate.color]] ?? t.muted) : on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .when(Boolean(k.mate?.activity), (el) => el.child(div().flex_1().min_w(0).mr(6).truncate().text_size(10.5).text_color(k.mate.status === "working" ? t.muted : t.dim).child(k.mate.activity)))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "sleep") return div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child("zz");
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const PANES = panes(); // una vez por dibujo: cada llamada copia todos los panes
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = this.withSleeping(agents());
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.filter((a) => !a.sleeping).map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    // el worktree (la rama viva del pane); el logo ya dice que agente es.
    // Si le pusiste nombre (el de su pestaña: doble clic o ✎), ese.
    const tabById = new Map(tabs.map((x) => [x.id, x]));
    const custom = (a) => (tabById.get(a.tab)?.named ? tabById.get(a.tab).name : null);
    // Si no, el nombre del worktree (~/.herdr/worktrees/<repo>/<nombre>: el que escribiste al
    // crearlo), que no cambia aunque el agente pase a otra rama (p. ej. /pr crea feat/...).
    // Fuera de un worktree, la rama.
    const wtName = (a) => (PANES.find(p => p.pane === a.pane)?.cwd ?? "").match(/\/\.herdr\/worktrees\/[^/]+\/([^/]+)/)?.[1] ?? null;
    // Si la rama es la del worktree (con / en vez de -, como rv/PR-12), la rama, que se lee mejor.
    const label = (a) => {
      const br = PANES.find(p => p.pane === a.pane)?.branch?.replace(prefixRe(), "");
      const wt = wtName(a);
      // El que le pusiste a la sesión de Claude con /rename (no el que inventa Claude) va
      // antes que el del worktree.
      const st = this.lk?.[a.address];
      const sess = st?.name_source && st.name_source !== "derived" ? st.session_name : null;
      return custom(a) || sess || (wt && br && br.replace(/\//g, "-") === wt ? br : wt) || br || a.program?.name || a.title || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const branchOf = (a) => PANES.find((p) => p.pane === a.pane)?.branch;
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => { run("pane.focus", { pane: a.pane }); rowTip(a); })
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? `${a.space_name} \u00b7 ${label(a)}` : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click((e, cx) => {
          if (e.click_count === 2) return run("tab.rename", { id: a.tab }); // doble clic: le cambio el nombre
          if (a.sleeping) { this.wake(a.address); cx.notify(); }
          run("pane.focus", { pane: a.pane }); rowTip(a);
        })
        .when(a.sleeping, el => el.tooltip("Dormido (2 h sin uso). Clic: lo despierto donde estaba."))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(a.sleeping ? t.dim : idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`)))
          // Si el nombre no es la rama (le pusiste uno, o el agente cambió de rama), la rama al lado, chica.
          .when(!full && Boolean(branchOf(a)) && ![branchOf(a).replace(prefixRe(), ""), branchOf(a).replace(prefixRe(), "").replace(/\//g, "-")].includes(label(a)), el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(branchOf(a).replace(prefixRe(), "")))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(!full && this.hovered === a.address && Boolean(branchOf(a)), el => el.child(this.plus(t, a.space, branchOf(a))))
        .when(!full && Boolean(branchOf(a)) && this.chains[a.space]?.pedidos?.has(branchOf(a)) && (this.hovered === a.address || this.closing === branchOf(a)),
          el => el.child(this.closeBtn(t, a.space, branchOf(a))))
        .children(this.loopTags(t, a))
        .when(!full, el => el.children(this.branchTags(t, a.space, branchOf(a))))
        .when(!full && !collapsed, el => this.draggable(el, t, { addr: a.address, b: branchOf(a), space: a.space }, `a:${a.address}`))
        .when(this.hovered === a.address && !a.sleeping, el => el.child(div().id(`rename-${a.address}`).flex_none().px(3).rounded(4).text_size(12).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Cambiar el nombre (o doble clic). Vacío: vuelve al de la rama.")
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.rename", { id: a.tab }); }).child("✎")))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // en la vista por proyecto, los agentes como arbol de ramas. Cada
    // rama cuelga de su base; una base sin agente (el pedido) va en gris.
    const SHORT = (b) => (b ?? "").replace(prefixRe(), "");
    const issueN = (b) => Number((b.match(/IS-(\d+)/) ?? [])[1]) || 1e9;
    const treeOf = (g) => {
      const spaceId = g.id.slice(3), chain = this.chains[spaceId] ?? { base: {}, pedidos: new Set() };
      const nodes = new Map(), order = [];
      const node = (key, branch) => {
        if (!nodes.has(key)) { nodes.set(key, { key, branch, agents: [], kids: [] }); order.push(key); }
        return nodes.get(key);
      };
      // Los pedidos primero, aunque todavia no les cuelgue nada.
      for (const p of [...chain.pedidos].sort((x, y) => issueN(x) - issueN(y))) node(`b:${p}`, p);
      for (const a of g.members) {
        const br = PANES.find((p) => p.pane === a.pane)?.branch;
        let n = node(br ? `b:${br}` : `a:${a.address}`, br);
        n.agents.push(a);
        // Subir por las bases para que el arbol no quede cortado.
        for (let b = br, seen = new Set(); b && chain.base[b] && !seen.has(b); b = chain.base[b]) { seen.add(b); node(`b:${chain.base[b]}`, chain.base[b]); }
      }
      for (const n of nodes.values()) {
        const parent = n.branch && chain.base[n.branch] && nodes.get(`b:${chain.base[n.branch]}`);
        if (parent) { n.parent = parent; parent.kids.push(n); }
      }
      for (const n of nodes.values()) n.kids.sort((x, y) => issueN(x.branch) - issueN(y.branch) || SHORT(x.branch).localeCompare(SHORT(y.branch)));
      const roots = order.map((k) => nodes.get(k)).filter((n) => !n.parent);
      const out = [];
      const walk = (n, prefix, last, depth) => {
        const own = depth === 0 ? [] : [last ? "elbow" : "tee"];
        const cont = depth === 0 ? [] : [last ? "blank" : "pipe"];
        const kidsCont = n.kids.length ? "pipe" : "blank";
        if (n.agents.length === 0) out.push({ ghost: n.branch, pedido: chain.pedidos.has(n.branch), prefix: [...prefix, ...own] });
        // sub: la sangria de sus sub-agentes (hc run): un nivel mas adentro, y la
        // linea sigue si la rama tiene hijas abajo.
        n.agents.forEach((a, i) => out.push({ a, prefix: i === 0 ? [...prefix, ...own] : [...prefix, ...cont], sub: [...prefix, ...cont, kidsCont] }));
        n.kids.forEach((k, i) => walk(k, [...prefix, ...cont], i === n.kids.length - 1, depth + 1));
      };
      roots.forEach((r) => walk(r, [], true, 0));
      // Agentes metidos a mano adentro de otro (solo a la vista): van abajo de ese, un nivel adentro.
      const at = new Map(out.filter((e) => e.a).map((e) => [e.a.address, e]));
      const parentOf = (e) => {
        const p = e.a && this.parents[e.a.address];
        if (!p || !at.has(p)) return null;
        for (let x = p, seen = new Set([e.a.address]); x; x = this.parents[x]) { if (seen.has(x)) return null; seen.add(x); if (!at.has(x)) break; }
        return p;
      };
      if (!out.some(parentOf)) return out;
      const kidsOf = new Map();
      for (const e of out) { const p = parentOf(e); if (p) (kidsOf.get(p) ?? kidsOf.set(p, []).get(p)).push(e); }
      const res = [];
      const put = (e) => {
        res.push(e);
        const kids = e.a ? kidsOf.get(e.a.address) ?? [] : [];
        // Si la rama tiene hijas abajo, su linea sigue: el hijo va una columna mas adentro.
        if (!kids.length) return;
        const lane = e.sub.at(-1) === "blank" ? e.sub.slice(0, -1) : e.sub;
        kids.forEach((k, i) => {
          const last = i === kids.length - 1;
          put({ ...k, prefix: [...lane, last ? "elbow" : "tee"], sub: [...lane, last ? "blank" : "pipe", "blank"] });
        });
      };
      for (const e of out) if (!parentOf(e)) put(e);
      return res;
    };
    const LINE = t.dim;
    const connector = (kind, i) => {
      const box = div().w(14).h(30).flex_none().relative();
      if (kind === "blank") return box;
      const vert = div().absolute().left(6).top(0).w(1).h(kind === "elbow" ? 15 : 30).bg(LINE);
      const horiz = div().absolute().left(6).top(15).w(8).h(1).bg(LINE);
      return kind === "pipe" ? box.child(vert) : box.child(vert).child(horiz);
    };
    const prefixed = (prefix, el) => prefix.length === 0 ? el
      : h_flex().pl(8).flex_none().items_center().children(prefix.map(connector)).child(el.flex_1().min_w(0));
    const ghostRow = (e, spaceId) => h_flex().id(`ghost-${e.ghost}`).h(30).px(8).gap(7).flex_none().items_center().rounded(8)
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hovered = `b:${e.ghost}`; else { if (this.hovered === `b:${e.ghost}`) this.hovered = null; if (this.closing === e.ghost) this.closing = null; } cx.notify(); })
      .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim))
      .child(div().truncate().text_color(t.dim).child(SHORT(e.ghost)))
      .child(div().flex_1())
      .when(this.hovered === `b:${e.ghost}`, (el) => el.child(this.plus(t, spaceId, e.ghost)))
      .when(e.pedido && (this.hovered === `b:${e.ghost}` || this.closing === e.ghost), (el) => el.child(this.closeBtn(t, spaceId, e.ghost)))
      .children(this.branchTags(t, spaceId, e.ghost))
      .when(true, (el) => this.draggable(el, t, { b: e.ghost, space: spaceId }, `b:${e.ghost}`));

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      // una línea arriba de cada proyecto (menos el primero) para ver dónde empieza.
      const first = groups[0]?.id === g.id;
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        // el nombre del proyecto bien visible.
        .text_size(12.5)
        .font_semibold()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .when(g.id.startsWith("sp-"), (el) => el
          .on_mouse_move((_e, cx) => this.dragOver(null, cx))
          .on_mouse_up("left", (_e, cx) => this.dropOn(null, cx))
          .when(Boolean(this.drag?.moving) && this.drag.over === null && this.drag.space === g.id.slice(3) && this.canDrop(this.drag, null),
            (el) => el.rounded(6).bg(`${t.accent}33`).child(div().text_size(10.5).text_color(t.accent)
              .child(this.drag.addr && this.parents[this.drag.addr] ? "soltar: sacarlo de adentro" : "soltar: sin base"))))
        .when(!first, (el) => el.mt(8).border_t(1).border_color(t.border).pt(14).h(38))
        .child(div().truncate().text_color(t[g.status] ?? (byPriority ? t.muted : t.foreground)).child(g.label))
        .when(g.id.startsWith("sp-") && g.members.some((a) => !a.sleeping) && g.members.filter((a) => !a.sleeping).every((a) => this.lk?.[a.address]?.missing),
          (el) => el.child(div().id(`nolk-${g.id}`).flex_none().px(5).rounded(4).text_size(10).font_medium().bg(t.raised).text_color(t.muted)
            .tooltip("Lo informa una extensión de agentes.py").child(this.lk?.[g.members.find((a) => !a.sleeping)?.address]?.missing ?? "")))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const asTree = (g) => !byPriority && g.id.startsWith("sp-");
    const trees = new Map(groups.filter(asTree).map((g) => [g.id, treeOf(g)]));
    // ⌘] / ⌘[ siguen el orden del arbol.
    // El nombre de cada agente, para que el footer, ⌘J, ⌘K y Equipo digan lo mismo.
    const names = Object.fromEntries(list.map((a) => [a.address, label(a)]));
    const namesJson = JSON.stringify(names);
    if (namesJson !== this.namesJson) { this.namesJson = namesJson; this.names = names; setShared("herdr-mod.names", names); }
    if (!byPriority && !collapsed) setAgentOrder(groups.flatMap((g) => trees.has(g.id) ? trees.get(g.id).filter((e) => e.a && !e.a.sleeping).map((e) => e.a.address) : g.members.map((a) => a.address)));
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : trees.has(g.id)
          ? trees.get(g.id).flatMap((e, i) => e.a ? withKids(e.a, i).map((r, j) => j === 0 ? prefixed(e.prefix, r) : prefixed(e.sub, r.pl(10))) : [prefixed(e.prefix, ghostRow(e, g.id.slice(3)))])
          : g.members.flatMap(withKids))]);

    return v_flex()
      .id("agents-root")
      // Soltar fuera de una rama, o salir de la lista, cancela el arrastre.
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_hover((on, cx) => { if (!on && this.drag) { this.drag = null; cx.notify(); } })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "herdr-mod", kind: "popup", width: 200, height: 140, props: { role: "agents", sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .child(
        h_flex()
          .h(28)
          .px(12)
          .items_center()
          .justify_end()
          .when(collapsed, (el) => el.justify_center().px(0))
          .child(
            div()
              .id("collapse")
              .text_size(13)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click(toggleSidebar)
              .child(collapsed ? "»" : ""),
          ),
      );
  }
}
