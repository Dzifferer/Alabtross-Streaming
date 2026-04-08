#!/usr/bin/env bash
# diagnose.sh — Albatross health check
#
# Read-only inspection of the alabtross-mobile container, the library API,
# the swarm state, and the on-disk torrent cache. Writes a single human-
# readable report to stdout (and optionally a file). Never modifies anything.
#
# Usage:
#   ./diagnose.sh                       # Print report to stdout
#   ./diagnose.sh -o report.txt         # Tee to a file as well as stdout
#   ./diagnose.sh --logs 500            # Include 500 log lines (default 200)
#
# Env overrides:
#   ALBATROSS_API         (default: http://localhost:8080)
#   ALBATROSS_CONTAINER   (default: alabtross-mobile)
#   ALBATROSS_LIBRARY_DIR (default: /mnt/movies/torrent-cache/library)

set -euo pipefail

API="${ALBATROSS_API:-http://localhost:8080}"
CONTAINER="${ALBATROSS_CONTAINER:-alabtross-mobile}"
LIBRARY_DIR="${ALBATROSS_LIBRARY_DIR:-/mnt/movies/torrent-cache/library}"
LOG_LINES=200
OUTFILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUTFILE="$2"; shift 2 ;;
    --logs) LOG_LINES="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Tee output to file if -o was given
if [[ -n "$OUTFILE" ]]; then
  exec > >(tee "$OUTFILE") 2>&1
fi

# ── Helpers ────────────────────────────────────────────────────────────────
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: required command '$1' not found in PATH" >&2; exit 1; }
}
need curl
need jq
need docker

hr()    { printf '%s\n' '────────────────────────────────────────────────────────────────────'; }
title() { printf '\n%s\n' "▌ $*"; hr; }

api_get() {
  local path="$1"
  local out
  if ! out=$(curl -fsS --max-time 10 "${API}${path}" 2>&1); then
    echo "ERROR: curl ${API}${path} failed: $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

# ── Header ─────────────────────────────────────────────────────────────────
printf 'Albatross Diagnostic Report\n'
printf 'Generated: %s\n' "$(date -Iseconds)"
printf 'Host: %s\n' "$(hostname)"
printf 'API: %s\n' "$API"
hr

# ── Container ──────────────────────────────────────────────────────────────
title "Container"
if docker ps --filter "name=^${CONTAINER}\$" --format '{{.Status}}' | grep -q .; then
  docker ps --filter "name=^${CONTAINER}\$" \
    --format 'Name:    {{.Names}}\nStatus:  {{.Status}}\nImage:   {{.Image}}\nPorts:   {{.Ports}}'
else
  echo "❌ Container '${CONTAINER}' is NOT running"
  echo "   Recent stop/exit info:"
  docker ps -a --filter "name=^${CONTAINER}\$" --format '   {{.Status}} ({{.RunningFor}})' || true
fi

# ── Disk ───────────────────────────────────────────────────────────────────
title "Disk space"
df -h "$LIBRARY_DIR" 2>/dev/null || df -h /mnt/movies 2>/dev/null || df -h /
echo
echo "Library footprint:"
if [[ -d "$LIBRARY_DIR" ]]; then
  du -sh "$LIBRARY_DIR" 2>/dev/null || true
  echo "Top 10 directories by size:"
  du -sh "$LIBRARY_DIR"/*/ 2>/dev/null | sort -hr | head -10 | sed 's/^/  /'
else
  echo "  Library dir not found at $LIBRARY_DIR"
fi

# ── Library state ──────────────────────────────────────────────────────────
title "Library status counts"
LIB_JSON=$(api_get /api/library) || { echo "API not reachable; cannot continue."; exit 3; }

printf '%s' "$LIB_JSON" | jq -r '
  .items
  | group_by(.status)
  | map({status: .[0].status, n: length})
  | sort_by(-.n)
  | .[]
  | "  \(.status | . + (" " * (12 - length))) \(.n)"
'
echo
echo "Total items: $(printf '%s' "$LIB_JSON" | jq '.items | length')"
echo "Slots:       $(printf '%s' "$LIB_JSON" | jq -r '.slots | "\(.active)/\(.max) active"')"

# ── Failed items grouped by error ──────────────────────────────────────────
title "Failed items (grouped by error)"
FAILED_COUNT=$(printf '%s' "$LIB_JSON" | jq '[.items[] | select(.status=="failed")] | length')
if [[ "$FAILED_COUNT" == "0" ]]; then
  echo "  None — nothing failed."
else
  printf '%s' "$LIB_JSON" | jq -r '
    [.items[] | select(.status=="failed")]
    | group_by(.error // "(no error)")
    | map({err: (.[0].error // "(no error)"), n: length, sample: (.[0].name)})
    | sort_by(-.n)
    | .[]
    | "  [\(.n)] \(.err)\n      e.g. \(.sample)"
  '
fi

# ── Active downloads (only items actually receiving bytes) ─────────────────
title "Actively downloading (downloadSpeed > 0)"
ACTIVE=$(printf '%s' "$LIB_JSON" | jq '[.items[] | select(.status=="downloading" and .downloadSpeed > 0)] | length')
if [[ "$ACTIVE" == "0" ]]; then
  echo "  Nothing is currently receiving bytes."
  echo "  (If you have items in 'downloading' status with 0 KB/s, the swarm or"
  echo "   metadata fetch is stuck. Check the 'Download in flight' section below.)"
else
  printf '%s' "$LIB_JSON" | jq -r '
    .items
    | map(select(.status=="downloading" and .downloadSpeed > 0))
    | sort_by(-.downloadSpeed)
    | .[]
    | "  \((.downloadSpeed/1024|floor)|tostring + " KB/s") \t \(.progress)% \t peers=\(.numPeers) \t \(.name)"
  '
fi

# ── Pack overview ──────────────────────────────────────────────────────────
title "Pack overview"
printf '%s' "$LIB_JSON" | jq -r '
  .items
  | map(select(.packId != null))
  | group_by(.packId)
  | map({
      packId: .[0].packId,
      show:   .[0].showName // .[0].name,
      total:  length,
      complete: ([.[] | select(.status=="complete" or .status=="converting")] | length),
      downloading: ([.[] | select(.status=="downloading")] | length),
      paused: ([.[] | select(.status=="paused")] | length),
      failed: ([.[] | select(.status=="failed")] | length),
      activeKBs: ([.[] | select(.downloadSpeed > 0) | .downloadSpeed] | add // 0 | . / 1024 | floor),
      activeName: ([.[] | select(.status=="downloading" and .downloadSpeed > 0) | .name] | first // "—")
    })
  | sort_by(.show)
  | .[]
  | "  \(.show)
      packId:     \(.packId)
      progress:   \(.complete)/\(.total) complete  \(.downloading) downloading  \(.paused) paused  \(.failed) failed
      active:     \(.activeKBs) KB/s — \(.activeName)
"'

# ── Download in flight (downloading status, regardless of bytes) ──────────
title "All 'downloading' items"
printf '%s' "$LIB_JSON" | jq -r '
  [.items[] | select(.status=="downloading")]
  | length
  | "  Count: \(.)"
'
printf '%s' "$LIB_JSON" | jq -r '
  .items
  | map(select(.status=="downloading"))
  | sort_by(-.progress)
  | .[0:20]
  | .[]
  | "  \(.progress)% \t \((.downloadSpeed/1024|floor)|tostring + " KB/s") \t \(.name)"
'
DOWNLOADING_TOTAL=$(printf '%s' "$LIB_JSON" | jq '[.items[] | select(.status=="downloading")] | length')
if [[ "$DOWNLOADING_TOTAL" -gt 20 ]]; then
  echo "  ... ($((DOWNLOADING_TOTAL - 20)) more)"
fi

# ── System diagnostics ─────────────────────────────────────────────────────
title "Host + swarm aggregates"
SYS_JSON=$(api_get '/api/diagnostics/system?ms=1500' 2>/dev/null || echo '{}')
if [[ "$SYS_JSON" != "{}" ]]; then
  printf '%s' "$SYS_JSON" | jq -r '
    "  Hint:        \(.hint // "n/a")",
    "  CPU:         \(.host.cpu.usagePct)% (load \(.host.cpu.loadAvg | join(", ")))",
    "  Memory:      \(.host.memory.usedPct)% used",
    "  Disk write:  \((.host.totalDiskWriteBps/1024|floor)) KB/s",
    "  Disk read:   \((.host.totalDiskReadBps/1024|floor)) KB/s",
    "  Net rx:      \((.host.totalNetRxBps/1024|floor)) KB/s",
    "  Net tx:      \((.host.totalNetTxBps/1024|floor)) KB/s",
    "  Active torrents (per library): \(.torrents.active // 0)",
    "  Total peers:                   \(.torrents.totalPeers // 0)"
  '
  echo
  echo "  Note: torrents.totalDownloadBps over-counts pack speed once per"
  echo "  episode, so trust 'Net rx' for true aggregate throughput."
else
  echo "  /api/diagnostics/system unreachable"
fi

# ── Conversion queue ───────────────────────────────────────────────────────
title "Conversions"
printf '%s' "$LIB_JSON" | jq -r '
  [.items[] | select(.status=="converting")] as $cs
  | if ($cs | length) == 0 then
      "  None active."
    else
      $cs
      | sort_by(-.convertProgress)
      | .[]
      | "  \(.convertProgress // 0)% — \(.name)"
    end
'

# ── On-disk pack directories vs metadata ──────────────────────────────────
title "On-disk pack directories"
if [[ -d "$LIBRARY_DIR" ]]; then
  DISK_DIRS=$(find "$LIBRARY_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
  TRACKED_DIRS=$(printf '%s' "$LIB_JSON" \
    | jq -r '.items[] | select(.filePath != null) | .filePath' \
    | awk -F/ '{print $1}' | sort -u | wc -l)
  echo "  Directories on disk:    $DISK_DIRS"
  echo "  Directories referenced in metadata: $TRACKED_DIRS"
  echo
  echo "  Directories on disk NOT referenced by any tracked item:"
  TRACKED_LIST=$(mktemp)
  printf '%s' "$LIB_JSON" \
    | jq -r '.items[] | select(.filePath != null) | .filePath' \
    | awk -F/ '{print $1}' | sort -u > "$TRACKED_LIST"
  ORPHAN_DIRS=0
  while IFS= read -r d; do
    name=$(basename "$d")
    if ! grep -Fxq "$name" "$TRACKED_LIST"; then
      size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
      echo "    $size  $name"
      ORPHAN_DIRS=$((ORPHAN_DIRS + 1))
    fi
  done < <(find "$LIBRARY_DIR" -mindepth 1 -maxdepth 1 -type d)
  rm -f "$TRACKED_LIST"
  if [[ "$ORPHAN_DIRS" == "0" ]]; then
    echo "    (none)"
  fi
fi

# ── Recent log errors ──────────────────────────────────────────────────────
title "Recent container log errors (last $LOG_LINES lines)"
if docker ps --filter "name=^${CONTAINER}\$" --format '{{.Names}}' | grep -q .; then
  docker logs --tail "$LOG_LINES" "$CONTAINER" 2>&1 \
    | grep -iE 'error|fail|timeout|warn|stuck' \
    | tail -30 \
    | sed 's/^/  /' \
    || echo "  No matching log lines."
else
  echo "  Container not running — no logs."
fi

# ── Recommendations ────────────────────────────────────────────────────────
title "Recommendations"
RECS=()

if [[ "$FAILED_COUNT" != "0" ]]; then
  RECS+=("⚠ $FAILED_COUNT items in 'failed' status — run ./cleanup.sh --retry-failed")
fi

DISK_USED=$(df -P "$LIBRARY_DIR" 2>/dev/null | awk 'NR==2 {gsub("%",""); print $5}')
if [[ -n "$DISK_USED" && "$DISK_USED" -gt 90 ]]; then
  RECS+=("⚠ Library disk is ${DISK_USED}% full — free space soon")
fi

DOWNLOADING_NO_BYTES=$(printf '%s' "$LIB_JSON" | jq '[.items[] | select(.status=="downloading" and .downloadSpeed == 0)] | length')
if [[ "$DOWNLOADING_NO_BYTES" -gt 0 ]]; then
  ACTIVE_PACKS=$(printf '%s' "$LIB_JSON" | jq '[.items[] | select(.status=="downloading" and .packId != null) | .packId] | unique | length')
  RECS+=("ℹ $DOWNLOADING_NO_BYTES items show 'downloading' but receive 0 KB/s. With sequential pack mode this is expected — only one episode per pack ($ACTIVE_PACKS packs active) is actually receiving bytes.")
fi

if [[ "$ORPHAN_DIRS" -gt 0 ]]; then
  RECS+=("ℹ $ORPHAN_DIRS pack directories on disk are not referenced by any tracked item. Run ./cleanup.sh --delete-orphan-dirs to reclaim space (it will prompt before each delete).")
fi

if [[ ${#RECS[@]} -eq 0 ]]; then
  echo "  ✅ Nothing to recommend — looks healthy."
else
  for r in "${RECS[@]}"; do
    echo "  $r"
  done
fi

hr
echo "End of report."
