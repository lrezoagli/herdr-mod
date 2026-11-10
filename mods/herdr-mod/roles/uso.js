// Uso. Dos formas:
// - props.bar: la barra de abajo entera (reemplaza a workspace-status): a la
//   izquierda cuánto queda de Claude y Codex, CPU y RAM; a la derecha el atajo de
//   comandos. Clic abre el panel entero.
// - el panel entero, como diálogo en el medio (openOverlay con props.tab). Dos pestañas:
// - Cuentas: por Claude Code y Codex, la cuenta (mail, plan), cuánto queda en cada
//   ventana (5 h, semana), cuándo se renueva y a qué ritmo se va; y el consumo de
//   hoy y de 7 días (tokens, costo estimado, caché, turnos, sesiones, por día, por
//   modelo, por proyecto). Ideas de Orca. limits.py (cada 30 s) lee lo que guarda
//   ~/.claude/statusline.sh, ~/.codex y las cuentas; usage.py (cada 60 s) los
//   registros locales de los dos.
// - Sistema: CPU, RAM, disco, carga, batería, GPU y lo que más consume, de esta
//   Mac y de cada máquina remota de Herdr (machines()): stats.sh corre allá con
//   exec(..., { on }). Cada 5 s, solo con la pestaña a la vista.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, machines, theme, props, openOverlay, run, window, shared, setShared, spaces, panes, focused, terminals } from "herdr";

import { scoped } from "../store.js";
import { cfg, prefixRe, loadConfig } from "../config.js";
const localStorage = scoped("uso");

// /pr-review y /pr-fix son skills (si las tenés). Sin ellas (shared "herdr-mod.skills", lo
// mira el rol agents), el agente recibe un pedido común que hace lo mismo a mano.
const hasSkill = (s) => Boolean(shared("herdr-mod.skills")?.[s]);
const prAsk = (kind, n, repo) => kind === "fix"
  ? (hasSkill("pr-fix") ? `/pr-fix ${n}` : `Atendé los comentarios de review del PR #${n}${repo ? ` de ${repo}` : ""}: leelos con gh, validá cada uno contra el código, proponé el cambio y la respuesta, y esperá mi ok antes de commitear, pushear o contestar en GitHub.`)
  : (hasSkill("pr-review") ? `/pr-review ${n}` : `Revisá el PR #${n}${repo ? ` de ${repo}` : ""}: resumen, problemas (archivo:línea, severidad, cómo arreglarlo) y los comentarios que dejarías. No publiques nada en GitHub sin mi ok.`);
const prLabel = (kind) => kind === "fix" ? (hasSkill("pr-fix") ? "/pr-fix" : "fix") : (hasSkill("pr-review") ? "/pr-review" : "review");

// Letra: la barra va chica; el panel (diálogo), más grande para leerlo cómodo.
let SCALE = 1;
const fs = (x) => Math.round(x * SCALE * 10) / 10;
const DIR = () => `${home()}/.config/herdr-app/mods/herdr-mod/scripts`;
const GB = (b) => `${(b / 1073741824).toFixed(b >= 107374182400 ? 0 : 1)} GB`;
const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// Cuándo se renueva: hora si es hoy, día y hora si no.
function when(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}
const ago = (ms) => {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "recién" : m < 60 ? `hace ${m}m` : m < 1440 ? `hace ${Math.floor(m / 60)}h` : `hace ${Math.floor(m / 1440)}d`;
};
const uptime = (s) => s >= 86400 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 3600)}h`;
// Cuánto falta: "4d 2h", "3h 10m", "25m".
const left = (sec) => {
  const s = Math.max(0, sec - Date.now() / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
// Tokens cortos: 940, 12k, 161M, 2,2B.
const tok = (n) => {
  const f = (x, u) => `${(x >= 100 ? Math.round(x) : x.toFixed(1)).toString().replace(".", ",")}${u}`;
  return n >= 1e9 ? f(n / 1e9, "B") : n >= 1e6 ? f(n / 1e6, "M") : n >= 1e3 ? f(n / 1e3, "k") : String(n);
};
const usd = (n) => `US$ ${n >= 100 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".") : n.toFixed(2).replace(".", ",")}`;
// Límites de Claude desde la API de uso de Anthropic (como Orca): trae la ventana de
// 5 h, la semana, las semanas por modelo (Fable) y el uso extra, que la barra de
// estado de Claude no pasa. Solo la barra de abajo la consulta (cada 5 min) y deja el
// resultado, sin credenciales, en shared("herdr-mod.claude-usage").
// El login sale del Llavero ("Claude Code-credentials") y vive solo en la memoria de
// este mod: se vuelve a leer únicamente si venció o la API lo rechaza. Nunca a disco.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const secOf = (v) => (typeof v === "number" ? (v > 1e12 ? v / 1000 : v) : v ? Date.parse(v) / 1000 : null);
function claudeWindows(r) {
  const w = (label, x, minutes) => {
    const used = typeof x?.utilization === "number" ? x.utilization : typeof x?.used_percentage === "number" ? x.used_percentage : typeof x?.percent === "number" ? x.percent : null;
    return used == null ? null : { label, used: Math.min(100, Math.max(0, used)), resets_at: secOf(x.resets_at), minutes };
  };
  const scoped = (Array.isArray(r.limits) ? r.limits : [])
    .filter((l) => l?.kind === "weekly_scoped" && Number.isFinite(l.percent) && l.scope?.model?.display_name)
    .map((l) => w(l.scope.model.display_name, l, 10080));
  return [w("5 h", r.five_hour, 300), w("semana", r.seven_day, 10080), ...scoped].filter(Boolean);
}
function extraOf(r) {
  const e = r.extra_usage;
  if (!e) return null;
  const k = 10 ** (e.decimal_places ?? 2);
  const spent = e.used_credits != null ? e.used_credits / k : null, limit = e.monthly_limit != null ? e.monthly_limit / k : null;
  return { enabled: e.is_enabled === true, spent, limit, currency: e.currency || "USD", pct: typeof e.utilization === "number" ? e.utilization : spent != null && limit ? (100 * spent) / limit : null };
}

// Fable dentro de un resumen de Claude: sus tokens, su costo y qué parte del costo de Claude es.
function fableOf(s) {
  const ms = (s?.models ?? []).filter((m) => /fable/i.test(m.model));
  if (!ms.length) return null;
  const tokens = ms.reduce((a, m) => a + m.tokens, 0), cost = ms.reduce((a, m) => a + m.cost, 0);
  return { tokens, cost, share: s.cost ? Math.round((100 * cost) / s.cost) : null };
}
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const shortDate = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
// Ritmo: con lo usado hasta ahora en la ventana, ¿llega o se agota antes de renovarse?
function pace(w) {
  if (!w.minutes || !w.resets_at || w.used == null) return null;
  const now = Date.now() / 1000, len = w.minutes * 60, elapsed = len - (w.resets_at - now);
  if (w.used >= 99.5) return { bad: true, text: `agotado hasta ${when(w.resets_at)}` };
  if (elapsed < len * 0.03 || w.used <= 0) return null;
  const rate = w.used / elapsed, projected = w.used + rate * (w.resets_at - now);
  if (projected >= 100) return { bad: true, text: `a este ritmo se agota ${when(now + (100 - w.used) / rate)}` };
  return { bad: false, text: `a este ritmo llegás al ${Math.round(projected)}%` };
}

export default class Uso extends View {
  init(_props, cx) {
    this.tab = props()?.tab ?? localStorage.getItem("tab") ?? "limites"; // "limites" (Cuentas) | "sistema"
    this.limits = null;
    this.usage = null;
    this.stats = {};
    this.script = null;
    this.loadLimits(cx);
    if (props()?.bar) {
      // La barra: límites cada 30 s y esta Mac cada 10 s (stats.sh tarda ~2 s).
      cx.timer.every(30000, (cx) => this.loadLimits(cx));
      this.loadUsage(cx);
      cx.timer.every(60000, (cx) => this.loadUsage(cx));
      this.loadClaudeApi(cx);
      cx.timer.every(300000, (cx) => this.loadClaudeApi(cx));
      this.loadStats(cx, true);
      cx.timer.every(10000, (cx) => this.loadStats(cx, true));
      // El estado de los agentes y los avisos cambian en shared: redibujar apenas cambian.
      cx.timer.every(1500, (cx) => {
        const now = JSON.stringify([shared("herdr-mod.estado"), shared("herdr-mod.alerts"), focused()?.agent]);
        if (now !== this.lastLoop) { this.lastLoop = now; cx.notify(); }
      });
      return;
    }
    this.more = new Set(JSON.parse(localStorage.getItem("more") ?? "[]")); // servicios con el detalle abierto
    if (this.tab === "sistema") this.loadStats(cx);
    this.loadUsage(cx);
    cx.timer.every(60000, (cx) => this.loadUsage(cx));
    // this.stats: máquina ("" = esta) -> { data, error, at }
    cx.timer.every(30000, (cx) => this.loadLimits(cx));
    cx.timer.every(5000, (cx) => { if (this.tab === "sistema") this.loadStats(cx); });
  }

  loadLimits(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${DIR()}/limits.py`]);
        this.limits = JSON.parse(r.stdout || "{}");
      } catch { this.limits = {}; }
      cx.notify();
    });
  }

  async claudeToken(force) {
    if (!force && this.token && (!this.tokenExp || Date.now() < this.tokenExp - 60000)) return this.token;
    this.token = null;
    const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    if (r.code !== 0) return null;
    try {
      const o = JSON.parse(r.stdout).claudeAiOauth ?? {};
      this.token = o.accessToken ?? null;
      this.tokenExp = o.expiresAt ?? null;
    } catch { this.token = null; }
    return this.token;
  }

  loadClaudeApi(cx) {
    if (this.loadingApi) return;
    this.loadingApi = true;
    cx.spawn(async (cx) => {
      let error = null;
      try {
        for (const force of [false, true]) {
          const token = await this.claudeToken(force);
          if (!token) { error = "no pude leer el login de Claude del Llavero"; break; }
          const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" } });
          if (res.status === 401 || res.status === 403) { this.token = null; error = "el login venció"; continue; }
          if (!res.ok) { error = `la API respondió ${res.status}`; break; }
          const r = await res.json();
          setShared("herdr-mod.claude-usage", { at: Date.now(), windows: claudeWindows(r), extra: extraOf(r) });
          error = null;
          break;
        }
      } catch { error = "no hay conexión con la API"; }
      if (error) setShared("herdr-mod.claude-usage", { ...(shared("herdr-mod.claude-usage") ?? {}), error, errorAt: Date.now() });
      this.loadingApi = false;
      cx.notify();
    });
  }

  // Claude: lo de la API si es reciente (≤ 15 min); si no, lo que guardó la barra de estado.
  claude() {
    const base = this.limits?.claude ?? {};
    const api = shared("herdr-mod.claude-usage");
    if (api?.windows?.length && Date.now() - api.at < 900000) return { ...base, at: api.at, windows: api.windows, extra: api.extra, apiError: null };
    return { ...base, apiError: api?.error ?? null };
  }

  loadUsage(cx) {
    if (this.loadingUsage) return;
    this.loadingUsage = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${DIR()}/usage.py`]);
        if (r.code === 0) this.usage = JSON.parse(r.stdout || "{}");
      } catch {}
      this.loadingUsage = false;
      cx.notify();
    });
  }

  loadStats(cx, onlyHere = false) {
    if (this.loadingStats) return;
    this.loadingStats = true;
    cx.spawn(async (cx) => {
      try {
        this.script ??= (await exec("cat", [`${DIR()}/stats.sh`])).stdout;
        const list = onlyHere ? [null] : [null, ...machines().map((m) => m.name).filter(Boolean)];
        await Promise.all(list.map(async (name) => {
          const key = name ?? "";
          try {
            const r = await exec("sh", ["-c", this.script], name ? { on: name } : {});
            this.stats[key] = r.code === 0 ? { data: JSON.parse(r.stdout), at: Date.now() } : { ...this.stats[key], error: (r.stderr || "falló").trim() };
          } catch (e) { this.stats[key] = { ...this.stats[key], error: String(e).slice(0, 120) }; }
        }));
        for (const k of Object.keys(this.stats)) if (k && !list.includes(k)) delete this.stats[k];
      } catch {}
      this.loadingStats = false;
      cx.notify();
    });
  }

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("tab", tab);
    if (tab === "sistema") this.loadStats(cx);
    cx.notify();
  }

  // La barra de abajo: logo y % libre de cada uno (rojo si a este ritmo se agota), CPU y RAM.
  renderBar(t) {
    const level = (p) => (p >= 80 ? t.blocked : p >= 50 ? t.ansi3 : t.ansi2);
    const open = (tab) => () => openOverlay({ mod: "herdr-mod", kind: "dialog", width: 1280, height: 900, props: { role: "uso", tab } });
    const acct = (id, icon) => {
      const ws = (id === "claude" ? this.claude().windows : this.limits?.[id]?.windows ?? [])?.filter((w) => !/fable/i.test(w.label)) ?? [];
      if (!ws.length) return null;
      const worst = ws.reduce((m, w) => (w.used > m.used ? w : m));
      const bad = ws.map(pace).find((p) => p?.bad);
      const tip = ws.map((w) => `${w.label}: ${Math.round(100 - w.used)}% libre, se renueva ${when(w.resets_at)}${pace(w) ? ` (${pace(w).text})` : ""}`).join("\n");
      return h_flex().id(`bar-${id}`).gap(4).items_center().tooltip(tip)
        .child(image(icon).size(12))
        .child(div().font_semibold().text_color(level(worst.used)).child(`${Math.round(100 - worst.used)}%`))
        .when(Boolean(bad), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
    };
    // Fable: qué parte del costo de Claude de la semana se fue en Fable (no tiene límite propio).
    const fableBar = () => {
      const fw = this.claude().windows?.find((w) => /fable/i.test(w.label));
      if (fw) {
        const p = pace(fw);
        return h_flex().id("bar-fable").gap(4).items_center()
          .tooltip(`Fable, semana: ${Math.round(100 - fw.used)}% libre, se renueva ${when(fw.resets_at)}${p ? ` (${p.text})` : ""}`)
          .child(div().text_color(t.ansi5).font_semibold().child("Fable"))
          .child(div().font_semibold().text_color(level(fw.used)).child(`${Math.round(100 - fw.used)}%`))
          .when(Boolean(p?.bad), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
      }
      const f = fableOf(this.usage?.claude?.week), ft = fableOf(this.usage?.claude?.today);
      if (!f) return null;
      return h_flex().id("bar-fable").gap(4).items_center()
        .tooltip(`Fable, 7 días: ${tok(f.tokens)} tok · ${usd(f.cost)}${f.share != null ? ` · ${f.share}% del costo de Claude` : ""}${ft ? `\nhoy: ${tok(ft.tokens)} tok · ${usd(ft.cost)}` : ""}\nClaude no informa un límite propio de Fable.`)
        .child(div().text_color(t.ansi5).font_semibold().child("Fable"))
        .child(div().text_color(t.foreground).child(f.share != null ? `${f.share}%` : tok(f.tokens)));
    };
    const here = this.stats[""]?.data;
    // En el medio: con qué proyecto y qué agente estoy hablando, resaltado.
    const f = focused();
    const space = spaces().find((x) => x.id === f?.space) ?? spaces().find((x) => x.active);
    const pane = panes().find((p) => p.pane === f?.pane) ?? panes().find((p) => p.focused);
    const prog = terminals().find((k) => k.address === (f?.agent ?? pane?.terminal))?.program ?? pane?.program;
    const where = shared("herdr-mod.names")?.[f?.agent ?? pane?.terminal] || pane?.branch?.replace(prefixRe(), "");
    const fg = t.accent_foreground ?? t.background;
    const here_ = h_flex().gap(8).items_center().px(14).h(26).rounded(8).bg(t.accent)
      .when(Boolean(prog?.icon), (el) => el.child(div().size(18).rounded(5).bg(t.background).flex().items_center().justify_center()
        .child(prog.tint ? svg(prog.icon).size(12).text_color(t.foreground) : image(prog.icon).size(12))))
      .child(div().text_size(14.5).font_bold().text_color(fg).child(space?.name ?? ""))
      .when(Boolean(where), (el) => el.child(div().text_size(14.5).text_color(fg).opacity(0.7).child("›")).child(div().text_size(14.5).font_semibold().text_color(fg).child(where)));
    // A la derecha del proyecto: la etapa del agente que miro y lo que pide atención.
    const loop = this.loopFeedback(t, f?.agent ?? pane?.terminal);
    return h_flex().size_full().px(10).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(fs(11.5)).text_color(t.muted)
      .child(h_flex().flex_1().min_w(0).gap(10).items_center()
      .child(h_flex().id("bar-cuentas").gap(10).items_center().px(6).h(22).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_up("left", (e) => open("limites")(e))
        .children([acct("claude", "icons/claude.svg"), fableBar(), acct("codex", "icons/codex.svg")].filter(Boolean))
        .when(!this.limits?.claude?.windows?.length && !this.limits?.codex?.windows?.length, (el) => el.child("cuentas")))
      .child(h_flex().id("bar-sistema").gap(8).items_center().px(6).h(22).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_up("left", (e) => open("sistema")(e))
        .child(div().text_color(t.muted).child("CPU"))
        .child(div().text_color(here ? level(here.cpu) : t.dim).child(here ? `${Math.round(here.cpu)}%` : "…"))
        .child(div().text_color(t.muted).child("RAM"))
        .child(div().text_color(here ? level((100 * here.mem_used) / here.mem_total) : t.dim)
          .child(here ? `${Math.round((100 * here.mem_used) / here.mem_total)}%` : "…")))
      )
      .child(h_flex().flex_none().max_w(1100).gap(10).items_center().child(here_).children(loop))
      .child(h_flex().flex_1().justify_end().gap(8).items_center().children(this.githubBar(t)).child(div().id("palette").text_color(t.muted).cursor_pointer().on_click(() => run("app.palette"))
        .child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`)));
  }

  // GitHub en la barra (todos los repos): mis PRs con comentarios por contestar y
  // las reviews que me pidieron. Clic abre el panel GitHub en esa sección.
  githubBar(t) {
    const alerts = shared("herdr-mod.alerts") ?? [];
    const show = (id) => () => {
      setShared("herdr-mod.github.section", { id, at: Date.now() });
      run("layout.select", { stack: "panel-body", child: "github" }); run("layout.show", { id: "panel" });
    };
    const chip = (id, text, color, tip, fn) => h_flex().id(id).px(8).h(22).gap(5).rounded(5).items_center().cursor_pointer()
      .text_size(fs(11.5)).font_semibold().bg(`${color}26`).text_color(color).hover((s) => s.bg(`${color}44`))
      .tooltip(tip).on_click(fn).child(svg("mods/herdr-mod/assets/github.svg").size(12)).child(text);
    const out = [];
    const prs = alerts.filter((a) => a.kind === "pr");
    if (prs.length) {
      const hot = prs.some((a) => a.changes);
      out.push(chip("bar-prs", `${prs.length} PR${prs.length > 1 ? "s" : ""} con comentarios`, hot ? t.blocked : t.ansi3,
        prs.map((a) => `${a.who}: ${a.what}`).join("\n"), show("prs")));
    }
    const rr = alerts.filter((a) => a.kind === "rr");
    if (rr.length) {
      const old = rr.some((a) => Date.now() - Date.parse(a.asked_at) > 86400000);
      const label = rr.every((a) => a.status === "answered") ? `${rr.length} review${rr.length > 1 ? "s" : ""} respondida${rr.length > 1 ? "s" : ""}`
        : `${rr.length} review${rr.length > 1 ? "s" : ""} pendiente${rr.length > 1 ? "s" : ""}`;
      out.push(chip("bar-rr", label, old ? t.blocked : t.ansi5,
        rr.map((a) => `${a.who}: ${a.what}`).join("\n"), show("reviews")));
    }
    return out;
  }

  // El estado del agente en la barra: etapa y qué hace el agente enfocado, la
  // revisión corriendo (cortarla), si espera go (mandarlo), y cuántos avisos hay en
  // los demás (abre ⌘J). Si una extensión avisa que falta algo (st.missing), lo dice y nada más.
  loopFeedback(t, addr) {
    const lk = shared("herdr-mod.estado") ?? {};
    const alerts = shared("herdr-mod.alerts") ?? [];
    const st = addr ? lk[addr] : null;
    const out = [];
    const btn = (id, label, color, action) => div().id(id).px(7).h(20).rounded(5).flex().items_center().cursor_pointer()
      .text_size(11.5).font_semibold().bg(`${color}33`).text_color(color).hover((s) => s.bg(`${color}55`))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);
    if (st?.missing) {
      out.push(div().px(7).h(20).rounded(5).flex().items_center().text_size(11.5).bg(t.raised).text_color(t.muted).child(st.missing));
    } else if (st) {
      if (st.stage) {
        const c = /^(design|spec|tickets|split)/.test(st.stage) ? t.ansi4 : /^(impl|fix|small|refactor)/.test(st.stage) ? t.ansi3 : /^pr/.test(st.stage) ? t.ansi2 : t.muted;
        out.push(div().px(7).h(20).rounded(5).flex().items_center().text_size(12).font_bold().bg(`${c}33`).text_color(c)
          .child(`${st.size ? `${st.size} · ` : ""}/${st.stage}`));
      }
      if (st.activity) out.push(div().max_w(320).truncate().text_size(12).text_color(t.foreground).child(st.activity));
    }
    if (st?.review) {
      const m = Math.floor(st.review.secs / 60), c = st.review.secs >= 1200 ? t.blocked : st.review.secs >= 600 ? t.ansi3 : t.muted;
      out.push(div().text_size(12).font_semibold().text_color(c).child(`${st.review.tool} revisando ${m}m`));
      if (st.review.secs >= 600) out.push(btn("cut-review", "cortar", t.blocked, () => exec("kill", [String(st.review.pid)])));
    }
    if (st?.next) {
      out.push(div().text_size(12).text_color(t.accent).child(`espera go → ${st.next}`));
      out.push(btn("send-go", "go", t.accent, () => exec("hc", ["send", addr, "go"])));
    }
    const pr = alerts.find((a) => a.kind === "pr" && a.addr === addr);
    if (pr) out.push(btn("pr-fix", `PR #${pr.number}: ${pr.what} → ${prLabel("fix")}`, t.ansi5, () => exec("hc", ["send", addr, prAsk("fix", pr.number, pr.repo)])));
    // Lo de los demás agentes: cuántos avisos, y ⌘J los lista.
    const rest = alerts.filter((a) => a.addr !== addr && a.kind !== "pr" && a.kind !== "rr");
    if (rest.length) {
      const bad = rest.some((a) => a.kind === "review" && a.hung);
      out.push(btn("alerts", `⚠ ${rest.length} aviso${rest.length > 1 ? "s" : ""}`, bad ? t.blocked : t.ansi3, () => openOverlay({ mod: "herdr-mod", kind: "dialog", width: 900, height: 620 , props: { role: "waiting" } })));
    }
    return out;
  }

  render(cx) {
    const t = theme();
    SCALE = props()?.bar ? 1 : 1.25;
    if (props()?.bar) return this.renderBar(t);
    const level = (p) => (p >= 80 ? t.blocked : p >= 50 ? t.ansi3 : t.ansi2);
    const bar = (p, color = level(p), h = 8) => div().h(h).w_full().rounded(h / 2).bg(t.border)
      .child(div().h(h).rounded(h / 2).bg(color).w(`${Math.max(2, Math.min(100, p))}%`));
    const caps = (text) => div().text_size(11).font_semibold().text_color(t.muted).child(text.toUpperCase());
    const tile = () => v_flex().flex_1().min_w(0).p(12).gap(6).rounded(10).bg(t.raised);
    const MODEL_COLOR = (m) => /fable/i.test(m) ? t.ansi5 : /opus/i.test(m) ? t.ansi3 : /sonnet/i.test(m) ? t.ansi4 : /haiku/i.test(m) ? t.ansi2 : /luna/i.test(m) ? t.ansi2 : /astra/i.test(m) ? t.ansi4 : t.ansi6;
    const modelName = (m) => m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1");

    const segment = (id, label) => div().id(`uso-${id}`).px(14).py(5).rounded(7).cursor_pointer().text_size(13).font_semibold()
      .bg(this.tab === id ? t.selected : t.raised).text_color(this.tab === id ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setTab(id, cx)).child(label);

    // --- Cuentas ---
    // Un límite: cuánto queda, grande, su barra, cuándo se renueva y a qué ritmo va.
    const limitTile = (w) => {
      const p = pace(w), free = Math.round(100 - w.used);
      return tile().min_w(150)
        .child(caps(w.label))
        .child(h_flex().gap(5).items_end()
          .child(div().text_size(28).font_bold().text_color(level(w.used)).child(`${free}%`))
          .child(div().pb(5).text_size(12.5).text_color(t.muted).child("libre")))
        .child(bar(w.used))
        .child(div().text_size(12).text_color(t.muted).child(w.resets_at ? `↻ ${when(w.resets_at)} · en ${left(w.resets_at)}` : ""))
        .child(div().h(16).text_size(12).font_medium().text_color(p?.bad ? t.blocked : t.ansi2).child(p?.text ?? ""));
    };
    // Lo consumido en un período, a precio de API (o en tokens, sin precio).
    const spendTile = (label, s, priced, note) => tile()
      .child(caps(label))
      .child(div().text_size(22).font_bold().text_color(t.foreground)
        .child(priced ? `${usd(s.cost)}${s.unpriced ? "+" : ""}` : `${tok(s.total)}`))
      .child(div().text_size(12).text_color(t.muted)
        .child([priced ? `${tok(s.total)} tok` : "tokens", s.turns ? `${s.turns} turnos` : null].filter(Boolean).join(" · ")))
      .child(div().h(16).text_size(12).font_medium().text_color(t.accent).child(note ?? ""));
    const monthNote = (m, priced) => {
      if (m.days >= m.month_len) return "último día del mes";
      return priced && m.projected_cost != null ? `cierre ~${usd(m.projected_cost)}` : m.projected_total != null ? `cierre ~${tok(m.projected_total)} tok` : null;
    };
    // De qué modelo salió el consumo de la semana: una barra partida y su leyenda.
    const split = (models, priced) => {
      const key = priced ? "cost" : "tokens";
      const total = models.reduce((a, m) => a + (m[key] || 0), 0);
      if (!total) return null;
      const parts = models.filter((m) => m[key] > 0).map((m) => ({ ...m, pct: (100 * m[key]) / total }));
      return v_flex().gap(8)
        .child(h_flex().h(10).w_full().rounded(5).overflow_hidden().children(parts.map((m) => div().h(10).bg(MODEL_COLOR(m.model)).w(`${m.pct}%`))))
        .child(h_flex().flex_wrap().gap_x(14).gap_y(4).children(parts.map((m) => h_flex().gap(6).items_center().text_size(12.5)
          .child(div().size(9).rounded(3).bg(MODEL_COLOR(m.model)))
          .child(div().text_color(t.foreground).child(modelName(m.model)))
          .child(div().text_color(t.muted).child(`${Math.round(m.pct)}%${priced ? ` · ${usd(m.cost)}` : ` · ${tok(m.tokens)}`}`)))));
    };
    // Los últimos 7 días: una barra por día, el valor del más alto y de hoy arriba.
    const days = (daily, key) => {
      const max = Math.max(...daily.map((d) => d[key] || 0), 1);
      const L = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
      const fmt = (v) => (key === "cost" ? usd(v) : tok(v));
      return h_flex().h(104).gap(8).items_end()
        .children(daily.map((d, i) => {
          const v = d[key] || 0, today = i === daily.length - 1;
          return v_flex().id(`day-${key}-${d.day}`).flex_1().h_full().justify_end().items_center().gap(4)
            .tooltip(`${d.day.slice(8)}/${d.day.slice(5, 7)}: ${fmt(v)}${key === "cost" ? ` · ${tok(d.total)} tok` : ""}`)
            .when(today || v === max, (el) => el.child(div().text_size(11).text_color(today ? t.accent : t.muted).child(v ? fmt(v) : "")))
            .child(div().w_full().rounded(4).bg(today ? t.accent : `${t.foreground}40`).h(Math.max(2, Math.round(64 * v / max))))
            .child(div().text_size(11.5).text_color(today ? t.foreground : t.muted).child(L[new Date(`${d.day}T12:00:00`).getDay()]));
        }));
    };
    const projects = (u) => {
      const max = Math.max(...u.week.projects.map((p) => p.tokens), 1);
      return v_flex().gap(6).children(u.week.projects.map((p) => h_flex().gap(10).items_center().text_size(12.5)
        .child(div().w(150).flex_none().truncate().text_color(t.foreground).child(p.name))
        .child(div().flex_1().child(bar((100 * p.tokens) / max, `${t.accent}aa`, 6)))
        .child(div().w(56).flex_none().text_right().text_color(t.muted).child(tok(p.tokens)))));
    };
    const service = (id, icon, name, d, u, priced) => {
      const acc = d?.account ?? {};
      const open = this.more.has(id);
      const meta = [acc.email, acc.extra ? "uso extra activado" : null, acc.until ? `plan hasta el ${shortDate(acc.until)}` : null, d?.at ? `actualizado ${ago(d.at)}` : null].filter(Boolean).join(" · ");
      return v_flex().p(16).gap(14).rounded(12).bg(t.background).border(1).border_color(t.border)
        .child(v_flex().gap(3)
          .child(h_flex().gap(8).items_center()
            .child(image(icon).size(20))
            .child(div().text_size(17).font_bold().text_color(t.foreground).child(name))
            .when(Boolean(acc.plan ?? d?.plan), (el) => el.child(div().px(7).py(1).rounded(5).text_size(12).font_semibold().bg(`${t.accent}26`).text_color(t.accent).child(acc.plan ?? d.plan))))
          .when(Boolean(meta), (el) => el.child(div().text_size(12).text_color(t.muted).child(meta))))
        .when(Boolean(d?.apiError), (el) => el.child(div().text_size(12).text_color(t.ansi3).child(`límites de la barra de estado (${d.apiError})`)))
        .child(d?.windows?.length
          ? h_flex().gap(10).flex_wrap().items_start().children(d.windows.map(limitTile))
          : div().text_size(13).text_color(t.muted).child(id === "claude" ? "Sin límites todavía: aparecen con el próximo Claude abierto." : "Sin límites: aparecen después de usar Codex."))
        .when(Boolean(d?.extra?.enabled && d.extra.spent != null), (el) => el.child(h_flex().gap(8).text_size(13)
          .child(caps("uso extra"))
          .child(div().text_color(t.foreground).child(`${d.extra.currency === "USD" ? "US$ " : `${d.extra.currency} `}${d.extra.spent.toFixed(2).replace(".", ",")}${d.extra.limit ? ` de ${d.extra.limit.toFixed(0)}` : ""} este mes`))))
        .when(Boolean(u), (el) => el
          .child(v_flex().gap(8)
            .child(caps(priced ? "si lo pagaras a precio de API" : "consumo en tokens (sin precio)"))
            .child(h_flex().gap(10).items_start()
              .child(spendTile("Hoy", u.today, priced))
              .child(spendTile("7 días", u.week, priced))
              .when(Boolean(u.month), (el) => el.child(spendTile(`${MONTHS[Number(u.month.name) - 1]} (mes)`, u.month, priced, monthNote(u.month, priced))))))
          .when(Boolean(split(u.week.models, priced)), (el) => el.child(v_flex().gap(8).child(caps("por modelo · 7 días")).child(split(u.week.models, priced))))
          .child(v_flex().gap(8).child(caps(priced ? "por día · costo" : "por día · tokens")).child(days(u.daily, priced ? "cost" : "total")))
          .child(div().id(`more-${id}`).text_size(13).font_semibold().text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { open ? this.more.delete(id) : this.more.add(id); localStorage.setItem("more", JSON.stringify([...this.more])); cx.notify(); })
            .child(open ? "menos ▾" : "por proyecto y caché ▸"))
          .when(open, (el) => el.child(v_flex().gap(8)
            .child(caps("por proyecto · 7 días"))
            .child(projects(u))
            .when(u.week.cache_rate != null, (el) => el.child(div().text_size(12.5).text_color(t.muted)
              .child(`${u.week.cache_rate}% del prompt salió de caché · ${u.week.sessions} sesiones`))))));
    };
    // Claude y Codex lado a lado: entra todo sin scrollear.
    const limites = () => v_flex().gap(14)
      .child(h_flex().gap(14).items_start()
        .child(div().flex_1().min_w(0).child(service("claude", "icons/claude.svg", "Claude Code", this.claude(), this.usage?.claude, true)))
        .child(div().flex_1().min_w(0).child(service("codex", "icons/codex.svg", "Codex", this.limits?.codex, this.usage?.codex, false))))
      .child(div().text_size(12).text_color(t.muted)
        .child("El costo es lo que saldría pagar esos tokens a precio de API (tabla de Orca), para compararlo con el plan: con la suscripción no se paga así. \"+\": hay modelos sin precio (Haiku 5.5, Sonnet 5.5). Codex no tiene tabla de precios: solo tokens."));

    // --- Sistema ---
    const meterTile = (label, p, big, sub) => tile().min_w(140)
      .child(caps(label))
      .child(div().text_size(24).font_bold().text_color(level(p)).child(big))
      .child(bar(p))
      .child(div().text_size(12).text_color(t.muted).child(sub));
    const machine = (key) => {
      const st = this.stats[key], d = st?.data;
      const title = key ? key : "Esta Mac";
      const card = v_flex().p(16).gap(14).rounded(12).bg(t.background).border(1).border_color(t.border);
      if (!d) return card.child(div().text_size(17).font_bold().child(title))
        .child(div().text_size(13).text_color(st?.error ? t.blocked : t.muted).child(st?.error ?? "midiendo…"));
      const memP = d.mem_total ? (100 * d.mem_used) / d.mem_total : 0;
      const diskP = d.disk_total ? (100 * d.disk_used) / d.disk_total : 0;
      return card
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(17).font_bold().text_color(t.foreground).child(key ? `${title} · ${d.host}` : title))
          .when(d.battery != null, (el) => el.child(div().text_size(12.5).text_color(d.battery < 20 ? t.blocked : t.muted).child(`batería ${d.battery}%`)))
          .child(div().text_size(12.5).text_color(t.muted).child(`prendida hace ${uptime(d.uptime)}`)))
        .child(h_flex().gap(10).flex_wrap().items_start()
          .child(meterTile("CPU", d.cpu, `${Math.round(d.cpu)}%`, `carga ${d.load} en ${d.ncpu} núcleos`))
          .child(meterTile("RAM", memP, `${Math.round(memP)}%`, `${GB(d.mem_used)} de ${GB(d.mem_total)}${d.mem_free_pct != null ? ` · ${d.mem_free_pct}% libre` : ""}`))
          .child(meterTile("Disco", diskP, `${Math.round(diskP)}%`, `${GB(d.disk_used)} de ${GB(d.disk_total)}`))
          .children((d.gpus ?? []).map((g, i) => meterTile(`GPU${d.gpus.length > 1 ? ` ${i}` : ""}`, g.util, `${g.util}%`, `${GB(g.mem_used)} de ${GB(g.mem_total)}`))))
        .when((d.procs ?? []).length > 0, (el) => el.child(v_flex().gap(6)
          .child(caps("lo que más consume"))
          .children(d.procs.slice(0, 3).map((p) => h_flex().gap(10).items_center().text_size(13)
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.name))
            .child(div().w(60).flex_none().text_right().font_semibold().text_color(level(Math.min(100, p.cpu / d.ncpu * 4))).child(`${Math.round(p.cpu)}%`))
            .child(div().w(70).flex_none().text_right().text_color(t.muted).child(GB(p.rss)))))));
    };
    const sistema = () => h_flex().gap(14).items_start().flex_wrap()
      .children(["", ...machines().map((m) => m.name).filter(Boolean)].map((k) => div().flex_1().min_w(520).child(machine(k))));

    return v_flex().size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(20).pt(16).pb(12).gap(8).items_center().flex_none()
        .child(div().flex_1().text_size(20).font_bold().child("Uso"))
        .child(h_flex().p(3).gap(3).rounded(9).bg(t.raised).child(segment("limites", "Cuentas")).child(segment("sistema", "Sistema"))))
      .child(v_flex().id("uso-body").flex_1().min_h(0).px(20).pb(20).overflow_y_scrollbar()
        .child(this.tab === "sistema" ? sistema() : limites()));
  }
}
