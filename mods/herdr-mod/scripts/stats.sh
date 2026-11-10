#!/bin/sh
# CPU, RAM, disco, carga, bateria, GPU y procesos que mas consumen, como una linea
# JSON. Solo sh, awk y comandos del sistema: corre igual aca (macOS) que en una
# maquina remota (macOS o Linux) por `exec(..., { on })`, sin instalar nada.
export LC_ALL=C LANG=C  # decimales con punto (aca el locale es es_AR)
os=$(uname -s)
host=$(hostname -s 2>/dev/null || hostname)
q() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
if [ "$os" = Darwin ]; then
  ncpu=$(sysctl -n hw.ncpu)
  # iostat y no top: top recorre todos los procesos (casi 1 s de CPU por vuelta).
  idle=$(iostat -n 0 -c 2 -w 1 | awk 'END {print $3+0}')
  cpu=$(awk -v i="$idle" 'BEGIN {printf "%.1f", 100 - i}')
  total=$(sysctl -n hw.memsize)
  used=$(vm_stat | awk -v ps="$(sysctl -n hw.pagesize)" '/Pages active/ {a=$3} /Pages wired/ {w=$4} /occupied by compressor/ {c=$5} END {gsub("\\.","",a); gsub("\\.","",w); gsub("\\.","",c); printf "%.0f", (a+w+c)*ps}')
  free_pct=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/ {sub("%","",$2); print $2+0}')
  disk=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2 {printf "%.0f %.0f", $3*1024, $2*1024}')
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  boot=$(sysctl -n kern.boottime | sed 's/^{ sec = \([0-9]*\).*/\1/')
  up=$(( $(date +%s) - boot ))
  batt=$(pmset -g batt 2>/dev/null | awk -F'\t' 'NR==2 {split($2, a, ";"); gsub("%","",a[1]); gsub(" ","",a[2]); print a[1]+0, a[2]}')
  procs=$(ps -Ao pcpu=,rss=,comm= -r | head -3)
else
  ncpu=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
  s1=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat); sleep 1
  s2=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)
  cpu=$(echo "$s1 $s2" | awk '{t=$3-$1; i=$4-$2; printf "%.1f", t>0 ? 100*(t-i)/t : 0}')
  total=$(awk '/MemTotal/ {printf "%.0f", $2*1024}' /proc/meminfo)
  used=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {printf "%.0f", (t-a)*1024}' /proc/meminfo)
  free_pct=""
  disk=$(df -k / | awk 'NR==2 {printf "%.0f %.0f", $3*1024, $2*1024}')
  load=$(cut -d' ' -f1 /proc/loadavg)
  up=$(cut -d. -f1 /proc/uptime)
  batt=""
  procs=$(ps -eo pcpu=,rss=,comm= --sort=-pcpu | head -3)
fi
gpus=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpus=$(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null |
    awk -F', ' '{printf "%s{\"name\":\"%s\",\"util\":%s,\"mem_used\":%s,\"mem_total\":%s}", NR>1?",":"", $1, $2, $3*1048576, $4*1048576}')
fi
set -- $disk; disk_used=${1:-0}; disk_total=${2:-0}
set -- $batt; batt_pct=${1:-}; batt_state=${2:-}
plist=$(printf '%s\n' "$procs" | awk 'NF {cmd=$3; for (i=4; i<=NF; i++) cmd=cmd" "$i; n=split(cmd, p, "/"); gsub(/"/, "", p[n]); printf "%s{\"cpu\":%s,\"rss\":%.0f,\"name\":\"%s\"}", c++?",":"", $1, $2*1024, p[n]}')
printf '{"host":"%s","os":"%s","ncpu":%s,"cpu":%s,"mem_used":%s,"mem_total":%s,"mem_free_pct":%s,"disk_used":%s,"disk_total":%s,"load":%s,"uptime":%s,"battery":%s,"battery_state":"%s","gpus":[%s],"procs":[%s]}\n' \
  "$(q "$host")" "$os" "${ncpu:-0}" "${cpu:-0}" "${used:-0}" "${total:-0}" "${free_pct:-null}" "$disk_used" "$disk_total" "${load:-0}" "${up:-0}" "${batt_pct:-null}" "$(q "$batt_state")" "$gpus" "$plist"
