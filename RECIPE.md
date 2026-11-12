# herdr-mod

Un Herdr para trabajar con muchos agentes (Claude Code y Codex) en varios repos a la vez,
hecho con **un solo mod** (`mods/herdr-mod`) que se usa en cada lugar de la ventana con un
rol distinto. A la izquierda, los proyectos y los agentes como árbol de ramas. Arriba,
botones para abrir agentes en worktrees. A la derecha, los paneles GitHub (issues, mis PRs,
reviews) y Equipo. Abajo, el uso de Claude y Codex y lo que te está esperando. Los agentes
que no usás hace 2 horas se duermen solos y vuelven donde estaban cuando los mirás. La
interfaz está en español.

## What you see

- **Barra izquierda (rol `spaces` arriba, rol `agents` abajo).**
  - Spaces con avatar de color. Los worktrees van colgados de su repo. Al lado, la rama
    y ↑/↓ contra el remoto. Se reordenan arrastrando.
  - Agents: un título por proyecto y los agentes como árbol de ramas. Cada rama cuelga
    de su base (`branch.<rama>.herdrBase`), los pedidos (`herdrPedido`) son ramas en gris
    sin agente, y los sub-agentes de `hc` van un nivel adentro. Cada fila tiene:
    - el ícono del programa;
    - el nombre: el que le pusiste, si no el de su worktree, si no la rama (sin
      `branchPrefix`);
    - la rama actual, chica, si es otra;
    - el tiempo desde su último cambio;
    - el estado: girando, "Needs you", punto de terminado o "zz" si está dormido.
- **Barra de pestañas (rol `tabs`).**
  - Las pestañas del proyecto.
  - A la derecha: Claude, Codex, Files, Changes, GitHub (con número de pendientes) y
    Equipo.
- **Panel GitHub (rol `github`).** Tres secciones:
  - **Issues** del repo del proyecto, tuyos o todos, con botones Claude / Codex / Pedido.
  - **Mis PRs** de todos tus repos. Arriba, en un recuadro, los del proyecto actual;
    después, agrupados por repo. Chips: cambios pedidos, hilos sin responder,
    comentarios nuevos, CI ✗, conflicto, aprobado, esperando a…, bots.
  - **Reviews.** Todos los PRs abiertos donde sos revisor, en cuatro grupos:
    - Te pidieron review.
    - Te respondieron: después de tu review hubo commits o comentarios.
    - Ya revisaste.
    - Borradores.

    Cada fila dice qué dejaste (comentaste, aprobaste, pediste cambios) y tiene dos
    botones, review cc y review cx.
- **Panel Equipo (rol `equipo`).** Los equipos de Claude (agent teams) del proyecto, con
  una tarjeta por compañero.
- **Footer (rol `uso`, props `bar: true`).** De izquierda a derecha:
  - el uso de Claude y Codex (5 h y semana);
  - CPU y RAM de la máquina;
  - el proyecto › agente enfocado;
  - "N PRs con comentarios" y "N reviews pendientes", que abren la sección del panel
    GitHub.
- **Diálogos.**
  - ⌘J "Esperándote" (rol `waiting`): agentes que esperan y avisos de PR.
  - ⌘K buscar agentes (rol `buscar`).
  - "¿Cerrar…?" (rol `close`).
  - Agente en un worktree nuevo (rol `worktree`).
- **Encabezado de cada panel (rol `pane`).** Su ✕ pregunta antes de cerrar un agente.
- **Tips (rol `tips`).** Un cartelito abajo a la derecha con el atajo de lo que acabás de
  hacer con el mouse.

## How it behaves

- **Estados.** Working = girando; blocked = "Needs you"; done = punto hasta que lo mirás;
  idle = gris; dormido = "zz".
- **Dormir.** Un Claude o Codex sin uso hace 2 h sale con `/exit` o `/quit`. No se duermen:
  - los fijados (📌);
  - los que tienen equipo o sub-agentes vivos;
  - los que corren una revisión.

  Clic o foco lo despierta con `--resume <sesión>` o `codex resume <id>` y los mismos
  flags. Si no tenía conversación, arranca de cero.
- **Reinicios.** El rol `agents` guarda qué agente corre en cada terminal y en qué herdr-core
  (pid de `hc server status`). Si el core cambió, los que estaban andando y ahora son una
  shell pasan a dormidos, con un aviso, y vuelven con su sesión al abrirlos.
- **Nombres.** Un agente creado desde el mod nace con nombre: su pestaña y, en Claude,
  `claude -n <nombre>`. Doble clic o ✎ lo renombra. La sesión de Claude se mantiene con
  el mismo nombre: si no coincide, el mod le manda `/rename`, solo con el agente quieto y
  sin foco.
- **Arrastrar en el árbol.**
  - Un agente sobre otro queda adentro, solo a la vista.
  - Una rama sin agente sobre otra cuelga de esa (`herdrBase`).
  - Soltar sobre el título del proyecto lo saca.
- **Cerrar.** ⌘W y ⌘⇧W cierran el panel con foco, no la pestaña. Si es un agente,
  pregunta (Enter cierra, Esc cancela). La ✕ de la pestaña y la del encabezado también
  preguntan.
- **Cerrar pedido.** Al pasar el mouse por un pedido aparece ✕ → "¿cerrar?". Sus hijas
  pasan a su base, y la rama se borra solo si no tiene worktree ni commits sin mergear.
- **Review de un PR ajeno (botones cc / cx).**
  - Crea el worktree `~/.herdr/worktrees/<repo>/rv-PR-<n>` en la rama `rv/PR-<n>`, con lo
    último del PR.
  - Es código no confiable: sparse-checkout deja afuera `.claude/`, `.mcp.json`,
    `.codex/`, `.agents/`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` y
    `AGENTS.override.md`. Si algo de eso queda a la vista, no lanza el agente.
  - Después copia los `CLAUDE.md` y `AGENTS.md` de la rama principal del repo
    (`origin/HEAD`; nunca la base del PR, que la elige quien lo abre), sin seguir symlinks
    del PR, con `--assume-unchanged` para que `git status` quede limpio. Lo que esos docs
    importan con `@ruta` va adentro del doc, sacado también de la rama principal (hasta 5
    niveles), y sin los `@`: Claude no busca nada en el PR y los archivos del PR no se
    tocan. Si algo de esto falla, no lanza el agente.
  - Abre Claude (`--setting-sources user --dangerously-skip-permissions`) o Codex
    (`--dangerously-bypass-approvals-and-sandbox`), en modo skip.
  - Si la skill `pr-review` está en `~/.claude/skills`, le pide `/pr-review <n>`. Si no,
    una review común que no publica nada sin tu ok.
- **Arreglar tu PR (botón fix).** Abre Claude en la rama del PR, o le escribe al agente
  que ya está ahí. Usa `/pr-fix` si la skill existe; si no, un pedido común.
- **Fetch.** Si el fetch por SSH falla, reintenta por HTTPS con `gh auth git-credential`.
- **Avisos.**
  - Toast cuando llega un comentario a un PR tuyo, una review pedida o una respuesta a
    tu review.
  - Una vez por día, lo que lleva más de 24 h esperando.
- **Panel GitHub.** Sigue al space activo. El ↻ gira mientras trae datos y después dice
  "recién".

## Built from

- **Un mod, varios roles.** `mods/herdr-mod/main.js` lee `props().role` y la copia pasa a
  ser la clase de ese rol (`roles/<rol>.js`). Roles: `agents`, `spaces`, `tabs`, `github`,
  `equipo`, `uso`, `tips`, `pane` (en el layout) y `waiting`, `buscar`, `close`,
  `worktree` (diálogos). Herdr guarda el `localStorage` por copia.
- **Layout.** `layouts/herdr-mod.json` pone el mod con su rol en cada lugar. Usa también
  los mods de Herdr `files`, `changes` y `workspace-chrome` (íconos y spinner).
- **Teclas.** `keys.json`. Los comandos `herdr-mod.<comando>` llegan a todas las copias, y
  los atiende el rol `tabs`:
  - ⌘W y ⌘⇧W → `herdr-mod.close`;
  - ⌘J → `herdr-mod.waiting`;
  - ⌘K → `herdr-mod.buscar`;
  - ⌘⇧C/X/G/E → `herdr-mod.claude|codex|github|equipo`.
- **Datos compartidos (`shared`).** Los escribe el rol `agents` y los leen los demás:
  - `herdr-mod.prs`, `herdr-mod.prs.at` y `herdr-mod.prs.loading`;
  - `herdr-mod.alerts`;
  - `herdr-mod.estado` (el estado de cada agente);
  - `herdr-mod.names`;
  - `herdr-mod.teams`;
  - `herdr-mod.chains.at`;
  - `herdr-mod.skills`.
- **Configuración.** `config.json` (valores por defecto) y `config.local.json` (los tuyos,
  fuera de git):
  - `branchPrefix`: tu prefijo de ramas, por ejemplo `"usuario/"`;
  - `projects`: carpetas donde buscar tus clones;
  - `worktreeRoots`: carpetas con worktrees (`<carpeta>/<repo>/<nombre>`) para limpiar.
- **Scripts (`scripts/`).**
  - `agentes.py` (cada 5 s): pid, argv, sesión, nombre de la sesión y actividad de cada
    agente, leídos de `~/.claude/sessions`, `~/.claude/projects` y `~/.codex/sessions`.
    Acepta extensiones opcionales al lado (`<nombre>.py` con `start(ctx) -> enrich(st,
    info)`).
  - `teams.py`: los equipos de agentes de Claude.
  - `prs.py` (cada 2 min): una consulta GraphQL con `gh api graphql`, más los clones
    encontrados en `projects`.
  - `usage.py`: tokens y costo estimado desde los transcripts.
  - `limits.py`: límites de 5 h y semana.
  - `limpiar.py` (con ⌘⇧K, rol `limpiar`): `list` clasifica los worktrees en se-pueden-borrar
    (sin terminal ni agente, dormidos incluidos por la carpeta de su sesión; sin cambios ni
    commits fuera del remoto o de main), para-revisar y en-uso; `remove` vuelve a chequear
    cada uno y borra con `git worktree remove` sin `--force`.
  - `stats.sh`: CPU, RAM y disco.
- **Comandos de Herdr usados.** `tab.new {space, name, folder, argv, task}`, `space.new`,
  `space.move`, `space.select`, `tab.rename`, `tab.close {confirmed}`,
  `pane.close {pane}`, `pane.focus`, `layout.select` y `layout.show`.

## Watch out

- **Qué programas corre.** Usa `git`, `gh` (logueado), `hc`, `python3`, `open`, `kill` y
  `security`. Este último lee el token OAuth de Claude Code del Keychain de macOS, lo
  guarda solo en memoria y con él consulta la API de uso de Anthropic, o sea que **sale a
  la red**.
- **Qué lee fuera de su carpeta.** `~/.claude`, `~/.codex`, las carpetas de `projects` y
  `~/.herdr/worktrees`.
- **Límites de Claude.** Necesitan que tu statusline de Claude Code guarde `rate_limits`
  en `~/.cache/herdr-limits/claude.json` (ver `extras/statusline-limits.sh`). Sin eso, la
  barra muestra solo los de Codex.
- **El modo skip en reviews ajenas.** El agente puede ejecutar comandos sin preguntar. Lo
  que protege es que no se carga la config ni las instrucciones de agentes del PR.
- **Probar sin romper nada.**
  - `herdr-app check` corre `init` de verdad y sin `props`: muestra el rol "desconocido".
    Para chequear un rol, forzalo temporalmente en `main.js`.
  - El rol `close` sin foco no cierra nada, pero no lo pruebes con un panel enfocado.
  - Herdr no tiene drag & drop genérico: arrastrar está hecho con `on_mouse_down`,
    `on_mouse_move` y `on_mouse_up` por fila.
- **Estado guardado.** Herdr guarda el `localStorage` de cada copia en memoria y en
  `data/herdr-mod/store-<hash>.json`. Escribir esos archivos con Herdr abierto no sirve:
  los pisa.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/herdr-mod` pasa, también forzando cada rol.
- `herdr-app do layout.switch '{"name":"herdr-mod"}'` muestra las barras de arriba.
- `python3 mods/herdr-mod/scripts/agentes.py` imprime un objeto por agente vivo con `pid`,
  `argv` y `session`.
- `python3 mods/herdr-mod/scripts/prs.py ~/Projects` imprime `mine`, `reviews` (con
  `status`) y `clones`, o `{error}`.
- `herdr-app do herdr-mod.buscar` abre el buscador.
- ⌘W en una terminal común la cierra sin preguntar; en un agente, pregunta.
- Arrastrar un agente sobre otro lo muestra adentro; soltarlo en el título del proyecto
  lo saca.
- Un review cc crea `rv/PR-<n>` sin `CLAUDE.md` ni `.claude/` del PR y abre el agente con
  el pedido.
