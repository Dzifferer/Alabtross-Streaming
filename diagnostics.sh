#!/usr/bin/env bash
# ================================================================
#  Albatross Streaming — Master Diagnostics
#  diagnostics.sh
# ================================================================
#
# One-stop diagnostic for the entire Albatross stack. Replaces the
# scattered ad-hoc commands in CHEATSHEET.md / README.md "Useful
# Commands" / Troubleshooting sections with a single runnable script.
#
# Run alongside deploy.sh:
#   ./diagnostics.sh                 # full report, colored, exit non-zero on FAIL
#   ./diagnostics.sh --quiet         # only print warnings + failures
#   ./diagnostics.sh --no-fix        # never restart anything (read-only)
#
# deploy.sh invokes this automatically at the end of a deploy. To skip
# the post-deploy run pass --skip-diagnostics to deploy.sh.
#
# What it checks (each item: OK / WARN / FAIL):
#   System
#     - Jetson model + kernel + uptime
#     - CPU load
#     - Memory usage
#     - Root filesystem free space
#     - SoC temperature (Jetson tegra zones)
#   Storage
#     - /mnt/movies mounted (external USB drive)
#     - Free space on the cache mount
#   Network
#     - Default route + LAN IP
#     - DNS resolution
#     - Internet reachability
#   Docker
#     - Docker daemon up
#     - Containers running (delegates restart logic to scripts/healthcheck.sh)
#     - HTTP endpoints respond:
#         http://localhost:8080            (Albatross Mobile UI)
#         http://<lan-ip>:11470            (Stremio Server)
#     - /api/diagnostics/system bottleneck hint
#   Tailscale
#     - tailscaled service active
#     - tailscale status connected
#     - Tailscale IP present
#     - tailscale serve active on :443 -> :8080
#   Cron / monitoring
#     - Health-check cron entry installed
#     - Recent activity in /var/log/alabtross-health.log
#     - DuckDNS cron entry (if configured) + last update result
#   SSH
#     - sshd / ssh service active
#
# Exit codes:
#   0  no failures (warnings allowed)
#   1  one or more critical checks FAILED
# ================================================================

set -u

QUIET=0
NO_FIX=0
for arg in "$@"; do
  case "$arg" in
    --quiet)  QUIET=1 ;;
    --no-fix) NO_FIX=1 ;;
    -h|--help)
      sed -n '2,55p' "$0"
      exit 0
      ;;
  esac
done

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"

# Colors only when stdout is a TTY
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
  BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BLUE=''; BOLD=''; DIM=''; NC=''
fi

OK_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

ok()   { (( QUIET )) || echo -e "  ${GREEN}[OK]${NC}   $1"; OK_COUNT=$((OK_COUNT+1)); }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; WARN_COUNT=$((WARN_COUNT+1)); }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
info() { (( QUIET )) || echo -e "  ${DIM}$1${NC}"; }
hdr()  { (( QUIET )) || echo -e "\n${BLUE}${BOLD}== $1 ==${NC}"; }

# Try several places for an LAN IP — same logic deploy.sh / jetson_setup.sh use.
detect_lan_ip() {
  local ip
  ip=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
  [[ -z "$ip" ]] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "${ip:-127.0.0.1}"
}
LAN_IP=$(detect_lan_ip)

echo -e "${BOLD}Albatross diagnostics${NC} — $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "${DIM}host=$(hostname)  lan=${LAN_IP}${NC}"

# ---------------------------------------------------------------
# System
# ---------------------------------------------------------------
hdr "System"

if [[ -r /proc/device-tree/model ]]; then
  MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null)
  info "model: ${MODEL}"
  if echo "$MODEL" | grep -qi "jetson"; then
    ok "Jetson hardware detected"
  else
    warn "Not running on a Jetson — diagnostics still apply but tegra checks will be skipped"
  fi
fi
info "kernel: $(uname -sr)"
info "uptime: $(uptime -p 2>/dev/null || uptime)"

# CPU load vs core count
if [[ -r /proc/loadavg ]]; then
  read -r L1 L5 L15 _ < /proc/loadavg
  CORES=$(nproc 2>/dev/null || echo 1)
  info "load: ${L1} ${L5} ${L15}  cores: ${CORES}"
  # Warn if 5-min load is > 2x cores (sustained overload)
  if awk -v l="$L5" -v c="$CORES" 'BEGIN{exit !(l > c*2)}'; then
    warn "5-min load average ${L5} exceeds 2x core count (${CORES})"
  else
    ok "CPU load within normal range"
  fi
fi

# Memory
if command -v free >/dev/null 2>&1; then
  read -r _ MTOTAL MUSED _ _ _ _ < <(free -m | awk '/^Mem:/{print}')
  if [[ -n "${MTOTAL:-}" && "$MTOTAL" -gt 0 ]]; then
    USED_PCT=$(( MUSED * 100 / MTOTAL ))
    info "memory: ${MUSED}MB / ${MTOTAL}MB (${USED_PCT}%)"
    if (( USED_PCT >= 95 )); then
      fail "Memory usage at ${USED_PCT}% — system close to OOM"
    elif (( USED_PCT >= 85 )); then
      warn "Memory usage at ${USED_PCT}%"
    else
      ok "Memory usage healthy (${USED_PCT}%)"
    fi
  fi
fi

# Root filesystem free space (jetson sd card / nvme)
ROOT_AVAIL_KB=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')
ROOT_USE_PCT=$(df -Pk / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
if [[ -n "${ROOT_AVAIL_KB:-}" ]]; then
  ROOT_AVAIL_GB=$(awk -v k="$ROOT_AVAIL_KB" 'BEGIN{printf "%.1f", k/1024/1024}')
  info "root fs: ${ROOT_AVAIL_GB} GB free (${ROOT_USE_PCT}% used)"
  if awk -v g="$ROOT_AVAIL_GB" 'BEGIN{exit !(g < 1)}'; then
    fail "Root filesystem has only ${ROOT_AVAIL_GB} GB free"
  elif awk -v g="$ROOT_AVAIL_GB" 'BEGIN{exit !(g < 3)}'; then
    warn "Root filesystem has ${ROOT_AVAIL_GB} GB free (README requires ≥ 3 GB)"
  else
    ok "Root filesystem has enough free space"
  fi
fi

# SoC temperature — Jetson exposes thermal zones under /sys/class/thermal
HOTTEST_C=""
if compgen -G "/sys/class/thermal/thermal_zone*/temp" >/dev/null; then
  HOTTEST_C=$(for f in /sys/class/thermal/thermal_zone*/temp; do
    cat "$f" 2>/dev/null
  done | awk 'BEGIN{m=0}{if($1+0>m)m=$1}END{print m/1000}')
  info "max thermal zone: ${HOTTEST_C}°C"
  if awk -v t="$HOTTEST_C" 'BEGIN{exit !(t >= 85)}'; then
    fail "SoC temperature ${HOTTEST_C}°C — thermal throttling imminent"
  elif awk -v t="$HOTTEST_C" 'BEGIN{exit !(t >= 75)}'; then
    warn "SoC temperature ${HOTTEST_C}°C — running hot"
  else
    ok "Thermals OK (${HOTTEST_C}°C)"
  fi
fi

# ---------------------------------------------------------------
# Storage
# ---------------------------------------------------------------
hdr "Storage"

CACHE_MOUNT="/mnt/movies"
if mountpoint -q "$CACHE_MOUNT" 2>/dev/null; then
  CACHE_DEV=$(findmnt -no SOURCE "$CACHE_MOUNT" 2>/dev/null || echo "?")
  CACHE_SIZE=$(df -h "$CACHE_MOUNT" 2>/dev/null | awk 'NR==2 {print $2}')
  CACHE_AVAIL=$(df -h "$CACHE_MOUNT" 2>/dev/null | awk 'NR==2 {print $4}')
  CACHE_USE=$(df -h "$CACHE_MOUNT" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
  ok "${CACHE_MOUNT} mounted from ${CACHE_DEV} (${CACHE_SIZE}, ${CACHE_AVAIL} free, ${CACHE_USE}% used)"
  if [[ -n "${CACHE_USE:-}" ]] && (( CACHE_USE >= 95 )); then
    fail "External drive ${CACHE_USE}% full — torrent cache will fail"
  elif [[ -n "${CACHE_USE:-}" ]] && (( CACHE_USE >= 85 )); then
    warn "External drive ${CACHE_USE}% full"
  fi
else
  warn "${CACHE_MOUNT} not mounted — falling back to local cache (degraded mode)"
  info "to mount: sudo mount ${CACHE_MOUNT}"
fi

# ---------------------------------------------------------------
# Network
# ---------------------------------------------------------------
hdr "Network"

if [[ -n "$LAN_IP" && "$LAN_IP" != "127.0.0.1" ]]; then
  ok "LAN IP detected: ${LAN_IP}"
else
  fail "Could not detect a LAN IP — Stremio binding will fall back to 0.0.0.0"
fi

GW=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
if [[ -n "${GW:-}" ]]; then
  ok "Default gateway: ${GW}"
else
  fail "No default route configured"
fi

if command -v getent >/dev/null 2>&1 && getent hosts github.com >/dev/null 2>&1; then
  ok "DNS resolves github.com"
else
  warn "DNS lookup for github.com failed — git pull / docker pull may break"
  info "fix: echo 'nameserver 8.8.8.8' | sudo tee /etc/resolv.conf"
fi

if curl -fsS --max-time 5 -o /dev/null https://www.google.com 2>/dev/null; then
  ok "Internet reachable (https://www.google.com)"
else
  warn "Could not reach https://www.google.com in 5s"
fi

# ---------------------------------------------------------------
# Docker + containers (delegates restart logic to healthcheck.sh)
# ---------------------------------------------------------------
hdr "Docker"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker not installed"
elif ! docker info >/dev/null 2>&1; then
  fail "docker daemon not responding (try: sudo systemctl status docker)"
else
  ok "Docker daemon up ($(docker --version 2>/dev/null | awk '{print $3}' | tr -d ','))"

  HEALTHCHECK="${SCRIPT_DIR}/scripts/healthcheck.sh"
  if [[ -x "$HEALTHCHECK" ]]; then
    info "delegating container checks to scripts/healthcheck.sh"
    HC_ARGS=()
    (( QUIET )) && HC_ARGS+=(--quiet)
    (( NO_FIX )) && HC_ARGS+=(--no-fix)
    if "$HEALTHCHECK" "${HC_ARGS[@]}"; then
      ok "All Albatross containers healthy"
    else
      fail "scripts/healthcheck.sh reported a container failure"
    fi
  else
    warn "scripts/healthcheck.sh not found or not executable — falling back to inline checks"
    for c in stremio-server alabtross-mobile; do
      if docker ps --filter "name=^${c}$" --filter "status=running" \
           --format '{{.Names}}' | grep -qx "$c"; then
        ok "container ${c} running"
      else
        fail "container ${c} not running"
      fi
    done
  fi
fi

# ---------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------
hdr "Endpoints"

check_http() {
  local label=$1 url=$2
  local code
  # curl always prints %{http_code} (000 on connection failure) — don't add a
  # fallback echo here or we end up with "000000" when curl also exits non-zero.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
  [[ -z "$code" ]] && code="000"
  if [[ "$code" =~ ^(200|301|302|401|403|404)$ ]]; then
    ok "${label} responding (HTTP ${code}) — ${url}"
  elif [[ "$code" == "000" ]]; then
    fail "${label} not reachable — ${url}"
  else
    warn "${label} returned HTTP ${code} — ${url}"
  fi
}

check_http "Mobile UI"      "http://localhost:8080/"
check_http "Stremio Server" "http://${LAN_IP}:11470/"

# Mobile UI's own diagnostics endpoint — gives us the bottleneck hint.
DIAG_JSON=$(curl -s --max-time 5 "http://localhost:8080/api/diagnostics/system?ms=500" 2>/dev/null || echo "")
if [[ -n "$DIAG_JSON" ]]; then
  HINT=$(echo "$DIAG_JSON" | sed -n 's/.*"hint":"\([^"]*\)".*/\1/p' | head -1)
  if [[ -n "${HINT:-}" ]]; then
    case "$HINT" in
      cpu_bound|memory_pressure)
        warn "download bottleneck hint: ${HINT}" ;;
      swarm_or_protocol|network_or_swarm)
        info "download bottleneck hint: ${HINT}"
        ok "diagnostics endpoint healthy" ;;
      *)
        ok "diagnostics endpoint hint: ${HINT}" ;;
    esac
  else
    ok "diagnostics endpoint reachable (no hint parsed)"
  fi
else
  warn "/api/diagnostics/system did not respond"
fi

# ---------------------------------------------------------------
# Tailscale
# ---------------------------------------------------------------
hdr "Tailscale VPN"

if ! command -v tailscale >/dev/null 2>&1; then
  warn "tailscale not installed — remote access will not work"
else
  if systemctl is-active --quiet tailscaled 2>/dev/null; then
    ok "tailscaled service active"
  else
    fail "tailscaled service not active"
  fi

  if tailscale status >/dev/null 2>&1; then
    TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
    if [[ -n "${TS_IP:-}" ]]; then
      ok "Tailscale connected (IP: ${TS_IP})"
    else
      warn "Tailscale running but no IPv4 assigned"
    fi
  else
    fail "Tailscale not connected — run: sudo tailscale up"
  fi

  # Tailscale Serve — HTTPS proxy on :443 → :8080
  if tailscale serve status 2>/dev/null | grep -q "https://"; then
    ok "Tailscale Serve active (HTTPS → http://localhost:8080)"
  else
    warn "Tailscale Serve not active — https://albatross will be unreachable"
    info "fix: sudo tailscale serve --bg --https=443 http://localhost:8080"
  fi
fi

# ---------------------------------------------------------------
# Cron / monitoring
# ---------------------------------------------------------------
hdr "Cron / monitoring"

# Health-check cron — installed by jetson_setup.sh under root crontab
HEALTH_CRON=$(crontab -l 2>/dev/null | grep -F "health-check.sh" || true)
if [[ -n "$HEALTH_CRON" ]]; then
  ok "health-check cron installed (${HEALTH_CRON%% *} ...)"
else
  warn "no health-check.sh cron entry found in root's crontab"
  info "to install: re-run sudo bash jetson_setup.sh with ENABLE_HEALTH=yes"
fi

HEALTH_LOG="/var/log/alabtross-health.log"
if [[ -r "$HEALTH_LOG" ]]; then
  LAST_LINE=$(tail -1 "$HEALTH_LOG" 2>/dev/null)
  info "last health log: ${LAST_LINE:-<empty>}"
  # Surface recent ERROR / WARN lines from the last 24 hours.
  RECENT_ERR=$(tail -200 "$HEALTH_LOG" 2>/dev/null | grep -c "\[ERROR\]" || true)
  RECENT_WARN=$(tail -200 "$HEALTH_LOG" 2>/dev/null | grep -c "\[WARN\]" || true)
  if (( RECENT_ERR > 0 )); then
    warn "${RECENT_ERR} ERROR lines in recent health log — see ${HEALTH_LOG}"
  elif (( RECENT_WARN > 0 )); then
    info "${RECENT_WARN} WARN lines in recent health log"
  else
    ok "no recent errors in health log"
  fi
else
  info "health log not yet created (${HEALTH_LOG})"
fi

# DuckDNS — only relevant if user configured it
if [[ -x /opt/duckdns/duck.sh ]]; then
  if crontab -l 2>/dev/null | grep -q "duck.sh" \
     || sudo -n crontab -u "${SUDO_USER:-$USER}" -l 2>/dev/null | grep -q "duck.sh"; then
    ok "DuckDNS cron entry installed"
  else
    warn "DuckDNS script present but no cron entry found"
  fi
  DUCK_LOG="${HOME}/.duckdns.log"
  [[ -n "${SUDO_USER:-}" ]] && DUCK_LOG="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.duckdns.log"
  if [[ -r "$DUCK_LOG" ]]; then
    DUCK_RESULT=$(tr -d '[:space:]' < "$DUCK_LOG" 2>/dev/null)
    if [[ "$DUCK_RESULT" == OK* ]]; then
      ok "DuckDNS last update: OK"
    elif [[ -z "$DUCK_RESULT" ]]; then
      info "DuckDNS log empty — no run yet"
    else
      warn "DuckDNS last result: ${DUCK_RESULT}"
    fi
  fi
else
  info "DuckDNS not configured (optional)"
fi

# ---------------------------------------------------------------
# SSH
# ---------------------------------------------------------------
hdr "SSH"

if systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; then
  ok "SSH service active"
else
  warn "SSH service not active — remote management disabled"
fi

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo
echo -e "${BOLD}Summary${NC}: ${GREEN}${OK_COUNT} OK${NC}  ${YELLOW}${WARN_COUNT} WARN${NC}  ${RED}${FAIL_COUNT} FAIL${NC}"

if (( FAIL_COUNT > 0 )); then
  echo -e "${RED}One or more critical checks failed.${NC} Review the output above."
  exit 1
fi

if (( WARN_COUNT > 0 )); then
  echo -e "${YELLOW}Diagnostics finished with warnings.${NC}"
fi

exit 0
