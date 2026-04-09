#!/usr/bin/env bash
# Albatross — container health check
#
# Checks each Docker container the stack relies on. If a container is not
# running, attempts a restart, then verifies again. Designed to be:
#   - safe to run from cron (the version installed by jetson_setup.sh under
#     /opt/alabtross/health-check.sh is functionally equivalent)
#   - safe to run interactively (colored output, exit codes)
#   - called from the master diagnostics script (./diagnostics.sh)
#
# Exit codes:
#   0  all containers healthy
#   1  one or more containers down and could not be restarted
#
# Usage:
#   sudo ./scripts/healthcheck.sh           # check + auto-restart, log output
#   sudo ./scripts/healthcheck.sh --quiet   # only print warnings/errors
#   sudo ./scripts/healthcheck.sh --no-fix  # report only, never restart

set -u

QUIET=0
NO_FIX=0
for arg in "$@"; do
  case "$arg" in
    --quiet)  QUIET=1 ;;
    --no-fix) NO_FIX=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

LOG="/var/log/alabtross-health.log"
CONTAINERS=("stremio-server" "alabtross-mobile")

# Colors only when stdout is a TTY
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi

ok()   { (( QUIET )) || echo -e "${GREEN}[OK]${NC}   $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[FAIL]${NC} $1"; }

log_line() {
  # Append to /var/log/alabtross-health.log if writable, silently skip otherwise.
  if [[ -w "$(dirname "$LOG")" ]] || [[ -w "$LOG" ]] 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG" 2>/dev/null || true
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  err "docker not installed — cannot health-check containers"
  exit 1
fi

is_running() {
  docker ps --filter "name=^$1$" --filter "status=running" \
    --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

FAILED=0

for name in "${CONTAINERS[@]}"; do
  if is_running "$name"; then
    ok "$name running"
    continue
  fi

  # Container is down — decide whether to fix
  if (( NO_FIX )); then
    err "$name not running"
    log_line "[WARN] $name is down (no-fix mode)"
    FAILED=1
    continue
  fi

  warn "$name is down — attempting restart"
  log_line "[WARN] $name is down — restarting"

  if docker restart "$name" >/dev/null 2>&1 || docker start "$name" >/dev/null 2>&1; then
    sleep 2
    if is_running "$name"; then
      ok "$name restarted successfully"
      log_line "[OK] $name restarted successfully"
    else
      err "$name failed to come back up after restart"
      log_line "[ERROR] $name failed to restart"
      FAILED=1
    fi
  else
    err "$name could not be restarted (does the container exist?)"
    log_line "[ERROR] $name could not be restarted"
    FAILED=1
  fi
done

# Trim log if over 1 MB — same behavior as the cron-installed version
if [[ -f "$LOG" ]] && [[ -w "$LOG" ]]; then
  size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if (( size > 1048576 )); then
    tail -100 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null || true
  fi
fi

exit $FAILED
