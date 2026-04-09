#!/usr/bin/env bash
# Albatross — Download & Disk Status
#
# SSH-friendly snapshot of what the server is doing right now:
#   1. Active / queued / stalled downloads (from the mobile-ui API)
#   2. Library contents on disk (from /mnt/movies/torrent-cache/library)
#   3. Free space on the cache drive
#
# Usage:
#   ./scripts/status.sh              # human-readable summary
#   ./scripts/status.sh --json       # raw JSON (pipe into jq)
#   ./scripts/status.sh --host URL   # point at a non-local server
#                                    # e.g. --host http://albatross:8080
#
# Exit codes:
#   0 — query succeeded
#   1 — server unreachable
#   2 — invalid arguments
set -u

HOST="http://localhost:8080"
LIBRARY_PATH="${LIBRARY_PATH:-/mnt/movies/torrent-cache/library}"
CACHE_PATH="${TORRENT_CACHE:-/mnt/movies/torrent-cache}"
JSON_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)     JSON_ONLY=1; shift ;;
    --host)     HOST="$2"; shift 2 ;;
    --library)  LIBRARY_PATH="$2"; shift 2 ;;
    --cache)    CACHE_PATH="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ─── Helpers ───────────────────────────────────────────────────────────────
has_jq() { command -v jq >/dev/null 2>&1; }

fetch() {
  # $1 = path, prints body or empty on failure
  curl -fsS --max-time 5 "${HOST}${1}" 2>/dev/null || return 1
}

human_bytes() {
  # $1 = integer bytes — prints e.g. "1.4 GB"
  local b="${1:-0}"
  awk -v b="$b" 'BEGIN {
    split("B KB MB GB TB PB", u, " ");
    i = 1;
    while (b >= 1024 && i < 6) { b /= 1024; i++ }
    if (i == 1) printf "%d %s", b, u[i];
    else        printf "%.1f %s", b, u[i];
  }'
}

human_bps() {
  local s
  s=$(human_bytes "${1:-0}")
  printf "%s/s" "$s"
}

# ─── Fetch API data ────────────────────────────────────────────────────────
LIBRARY_JSON=$(fetch /api/library)
if [[ -z "$LIBRARY_JSON" ]]; then
  echo "ERROR: Cannot reach Albatross server at ${HOST}" >&2
  echo "  Is the container running?  sudo docker ps" >&2
  exit 1
fi

TORRENTS_JSON=$(fetch /api/torrent-status || echo '{"torrents":[]}')
DIAG_JSON=$(fetch '/api/diagnostics/system?ms=300' || echo '{}')

if [[ "$JSON_ONLY" -eq 1 ]]; then
  if has_jq; then
    jq -n \
      --argjson library "$LIBRARY_JSON" \
      --argjson torrents "$TORRENTS_JSON" \
      --argjson diag "$DIAG_JSON" \
      '{library: $library, torrents: $torrents, diag: $diag}'
  else
    printf '{"library":%s,"torrents":%s,"diag":%s}\n' \
      "$LIBRARY_JSON" "$TORRENTS_JSON" "$DIAG_JSON"
  fi
  exit 0
fi

# ─── Human-readable rendering ──────────────────────────────────────────────
if ! has_jq; then
  echo "ERROR: 'jq' is required for the human-readable view." >&2
  echo "  Install it:  sudo apt install -y jq" >&2
  echo "  Or run:      $0 --json" >&2
  exit 1
fi

echo "=== Albatross Status @ $(date '+%Y-%m-%d %H:%M:%S') ==="
echo

# ── 1. Active / queued downloads ──
echo "── Downloads ──────────────────────────────────────────"
SLOTS=$(echo "$LIBRARY_JSON"     | jq -r '.slots    // empty' 2>/dev/null)
ITEMS=$(echo "$LIBRARY_JSON"     | jq '.items      // []')
ACTIVE=$(echo "$ITEMS" | jq '[.[] | select(.status=="downloading")]')
QUEUED=$(echo "$ITEMS" | jq '[.[] | select(.status=="queued")]')
PAUSED=$(echo "$ITEMS" | jq '[.[] | select(.status=="paused")]')
FAILED=$(echo "$ITEMS" | jq '[.[] | select(.status=="failed")]')

ACTIVE_COUNT=$(echo "$ACTIVE" | jq 'length')
QUEUED_COUNT=$(echo "$QUEUED" | jq 'length')
PAUSED_COUNT=$(echo "$PAUSED" | jq 'length')
FAILED_COUNT=$(echo "$FAILED" | jq 'length')

if [[ -n "$SLOTS" && "$SLOTS" != "null" ]]; then
  USED=$(echo "$SLOTS" | jq -r '.used // 0')
  MAX=$( echo "$SLOTS" | jq -r '.max  // 0')
  echo "Slots: ${USED}/${MAX} in use"
fi
echo "Active: $ACTIVE_COUNT   Queued: $QUEUED_COUNT   Paused: $PAUSED_COUNT   Failed: $FAILED_COUNT"

TOTAL_BPS=$(echo "$DIAG_JSON" | jq -r '.torrentDownloadBps // 0')
TOTAL_PEERS=$(echo "$DIAG_JSON" | jq -r '.torrentPeers // 0')
if [[ "$TOTAL_BPS" != "0" || "$TOTAL_PEERS" != "0" ]]; then
  echo "Swarm: $(human_bps "$TOTAL_BPS") across ${TOTAL_PEERS} peers"
fi
echo

if [[ "$ACTIVE_COUNT" -gt 0 ]]; then
  echo "Currently downloading:"
  echo "$ACTIVE" | jq -r '.[] |
    "  \u2022 \(.name // .fileName // .id)" +
    (if .season and .episode then " S\(.season|tostring|if length<2 then "0"+. else . end)E\(.episode|tostring|if length<2 then "0"+. else . end)" else "" end) +
    "\n      \(.progress // 0)%" +
    (if .downloadSpeed then "  @ \(.downloadSpeed) B/s" else "" end) +
    (if .numPeers     then "  peers=\(.numPeers)"     else "" end) +
    (if .fileSize     then "  size=\(.fileSize) B"    else "" end)'
  echo
fi

if [[ "$QUEUED_COUNT" -gt 0 ]]; then
  echo "Queued:"
  echo "$QUEUED" | jq -r '.[] | "  \u2022 \(.name // .fileName // .id)"'
  echo
fi

if [[ "$FAILED_COUNT" -gt 0 ]]; then
  echo "Failed (consider cleanup.sh):"
  echo "$FAILED" | jq -r '.[] | "  \u2022 \(.name // .fileName // .id)   \(.error // "")"'
  echo
fi

# ── 2. On-disk library ──
echo "── On-disk library ────────────────────────────────────"
if [[ ! -d "$LIBRARY_PATH" ]]; then
  echo "Library path not found: $LIBRARY_PATH"
  echo "(set LIBRARY_PATH env var or pass --library)"
else
  COMPLETE_COUNT=$(echo "$ITEMS" | jq '[.[] | select(.status=="complete")] | length')
  COMPLETE_BYTES=$(echo "$ITEMS" | jq '[.[] | select(.status=="complete") | (.fileSize // 0)] | add // 0')
  echo "Tracked complete items: ${COMPLETE_COUNT}  (~$(human_bytes "$COMPLETE_BYTES"))"

  # Actual on-disk footprint (includes partials, temp files, everything)
  if DU_OUT=$(du -sb "$LIBRARY_PATH" 2>/dev/null); then
    DISK_BYTES=$(echo "$DU_OUT" | awk '{print $1}')
    echo "Library dir on disk:    $(human_bytes "$DISK_BYTES")"
  fi

  # Top-level folder count as a rough proxy for how many releases exist
  TOPLEVEL=$(find "$LIBRARY_PATH" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
  echo "Top-level folders:      ${TOPLEVEL}"
fi
echo

# ── 3. Disk free space ──
echo "── Disk free ──────────────────────────────────────────"
if [[ -d "$CACHE_PATH" ]]; then
  df -h "$CACHE_PATH" | awk 'NR==1 || NR==2 {printf "%-20s %6s %6s %6s %5s\n", $1, $2, $3, $4, $5}'
else
  df -h / | awk 'NR==1 || NR==2 {printf "%-20s %6s %6s %6s %5s\n", $1, $2, $3, $4, $5}'
fi
