# herdr-mod

A single [Herdr](https://herdr.dev) mod for working with many coding agents (Claude Code and
Codex) across several repos at once. The UI is in Spanish.

Un mod de Herdr para trabajar con muchos agentes (Claude Code y Codex) en varios repos a la
vez. Es **un solo mod** (`mods/herdr-mod`) que el layout pone en cada lugar de la ventana con
un rol distinto:

- **Barra izquierda.** Proyectos, y los agentes como árbol de ramas. Podés renombrarlos,
  arrastrar uno adentro de otro y fijarlos. Si no los usás en 2 horas, se duermen solos.
- **Pestañas.** Botones para abrir Claude o Codex en un worktree nuevo, y para abrir los
  paneles.
- **Panel GitHub.**
  - Issues del proyecto.
  - Tus PRs de todos los repos, con lo que te toca.
  - Las reviews donde sos revisor. Un botón abre la review en un worktree aislado.
- **Panel Equipo.** Los equipos de agentes de Claude.
- **Footer.** Uso de Claude y Codex, CPU y RAM, el agente enfocado y los avisos de GitHub.
- **Diálogos.**
  - ⌘J: quién te está esperando.
  - ⌘K: buscar un agente.
  - ⌘W: cerrar el panel con foco; si es un agente, pregunta antes.

El detalle está en [RECIPE.md](RECIPE.md).

## Instalar

Con tu agente:

> Read ~/.config/herdr-app/AGENTS.md, then add this layout: github.com/lrezoagli/herdr-mod

A mano:

1. Copiá `mods/herdr-mod/` a `~/.config/herdr-app/mods/` y `layouts/herdr-mod.json` a
   `~/.config/herdr-app/layouts/`.
2. Sumá las teclas de `keys.json` a tu `~/.config/herdr-app/keys.json`. Ojo: ⌘W pasa a
   cerrar el panel con foco en vez de la pestaña.
3. `herdr-app check ~/.config/herdr-app/mods/herdr-mod`
4. `herdr-app do layout.switch '{"name":"herdr-mod"}'`. Con ctrl-shift-l volvés a tu
   layout.

## Configurar

Creá `mods/herdr-mod/config.local.json` (no va a git) con lo tuyo:

```json
{ "branchPrefix": "usuario/", "projects": ["~/Projects", "~/code"] }
```

- `branchPrefix`: el prefijo de tus ramas. Se saca al mostrarlas, y los issues crean
  ramas `<prefijo>IS-<n>`.
- `projects`: dónde buscar tus clones, para abrir reviews y PRs de repos que no tenés
  abiertos en Herdr.

## Necesita

- macOS (el footer usa el Keychain y `iostat`).
- `python3`, `git` y `gh` logueado.
- Claude Code y/o Codex.
- Para los límites de Claude en el footer: `extras/statusline-limits.sh` en tu statusline.

## Qué hace fuera de su carpeta

- Corre `git`, `gh`, `hc`, `python3`, `open`, `kill` y `security`.
- Lee `~/.claude`, `~/.codex`, tus carpetas de `projects` y `~/.herdr/worktrees`.
- Lee el token OAuth de Claude Code del Keychain para consultar tu uso en la API de
  Anthropic. Lo guarda solo en memoria.
- Los botones de review abren el agente **en modo skip** sobre el código del PR, que es
  ajeno. Para que el PR no pueda darle instrucciones, deja afuera su config de agentes
  (`.claude/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`…) y usa la de la rama principal del
  repo. Igual, el agente puede ejecutar comandos sin preguntar: usalo sabiendo eso.

## Extensiones

`scripts/agentes.py` carga, si existen, extensiones al lado (`<nombre>.py` con
`start(ctx) -> enrich(st, info)`) que agregan datos a cada agente. Este repo no trae
ninguna.
