#!/bin/sh
# Para el footer de herdr-mod: guarda los límites de uso de Claude Code (5 h y semana)
# que Claude le pasa a tu statusline. Pegá esto al principio de tu statusline
# (~/.claude/statusline.sh), que recibe el JSON de Claude por stdin. Necesita jq.
input=$(cat)
lim_dir="$HOME/.cache/herdr-limits"
if printf '%s' "$input" | jq -e '.rate_limits' >/dev/null 2>&1; then
  mkdir -p "$lim_dir" && printf '%s' "$input" | jq -c '{rate_limits, at: now}' > "$lim_dir/claude.json.tmp" 2>/dev/null \
    && mv "$lim_dir/claude.json.tmp" "$lim_dir/claude.json"
fi
# ...y después lo que ya imprimía tu statusline, leyendo "$input" en vez de stdin.
