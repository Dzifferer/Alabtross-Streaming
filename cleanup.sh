#!/usr/bin/env bash
# cleanup.sh — Albatross interactive cleanup
#
# Performs the remediations diagnose.sh suggests. Safe by default: with no
# flags it runs in dry-run mode and only shows what it would do. Pass action
# flags (or --all) to actually do something. Pass -y to skip per-action
# confirmations.
#
# Actions:
#   --retry-failed              Retry all items in 'failed' status
#   --pause-pack PACKID         Pause every downloading item in this pack
#   --pause-all-but PACKID      Pause every downloading pack EXCEPT this one
#   --delete-orphan-dirs        Delete on-disk pack dirs not referenced by metadata
#   --restart-container         docker stop && docker start the container
#   --recover-pack MAGNET IMDB  Re-add a wiped pack via /api/library/add-pack
#                               (use this if a pack vanished from the UI after a
#                               failed restartPack — pre-bug-fix only)
#   --all                       --retry-failed + --delete-orphan-dirs (no pauses,
#                               no container restart, no pack recovery)
#
# Flags:
#   -y, --yes                   Don't prompt — assume yes
#   -n, --dry-run               Print actions but don't execute (default)
#   --execute                   Run for real (opposite of --dry-run)
#
# Env overrides:
#   ALBATROSS_API         (default: http://localhost:8080)
#   ALBATROSS_CONTAINER   (default: alabtross-mobile)
#   ALBATROSS_LIBRARY_DIR (default: /mnt/movies/torrent-cache/library)
#
# Examples:
#   ./cleanup.sh                                # dry run, show what's available
#   ./cleanup.sh --retry-failed --execute       # actually retry failed items
#   ./cleanup.sh --pause-all-but pack_b43df67a... --execute -y
#   ./cleanup.sh --recover-pack 'magnet:?xt=urn:btih:...' tt0903747 --execute

set -euo pipefail

API="${ALBATROSS_API:-http://localhost:8080}"
CONTAINER="${ALBATROSS_CONTAINER:-alabtross-mobile}"
LIBRARY_DIR="${ALBATROSS_LIBRARY_DIR:-/mnt/movies/torrent-cache/library}"

RETRY_FAILED=0
PAUSE_PACK=""
PAUSE_ALL_BUT=""
DELETE_ORPHAN_DIRS=0
RESTART_CONTAINER=0
RECOVER_MAGNET=""
RECOVER_IMDB=""
ASSUME_YES=0
DRY_RUN=1
ANY_ACTION=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --retry-failed)        RETRY_FAILED=1; ANY_ACTION=1; shift ;;
    --pause-pack)          PAUSE_PACK="$2"; ANY_ACTION=1; shift 2 ;;
    --pause-all-but)       PAUSE_ALL_BUT="$2"; ANY_ACTION=1; shift 2 ;;
    --delete-orphan-dirs)  DELETE_ORPHAN_DIRS=1; ANY_ACTION=1; shift ;;
    --restart-container)   RESTART_CONTAINER=1; ANY_ACTION=1; shift ;;
    --recover-pack)
      RECOVER_MAGNET="$2"
      RECOVER_IMDB="$3"
      ANY_ACTION=1
      shift 3 ;;
    --all)
      RETRY_FAILED=1
      DELETE_ORPHAN_DIRS=1
      ANY_ACTION=1
      shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    --execute) DRY_RUN=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────────
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found in PATH" >&2; exit 1; }
}
need curl
need jq
need docker

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" == "1" ]]; then
    echo "$prompt [auto-yes]"
    return 0
  fi
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  [dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

api_get() {
  curl -fsS --max-time 10 "${API}$1"
}

api_post() {
  local path="$1"
  local body="${2:-}"
  if [[ -n "$body" ]]; then
    curl -fsS --max-time 30 -X POST -H 'Content-Type: application/json' -d "$body" "${API}${path}"
  else
    curl -fsS --max-time 30 -X POST "${API}${path}"
  fi
}

# ── Header ─────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "1" ]]; then
  echo "═══ DRY RUN — no changes will be made (pass --execute to apply) ═══"
else
  echo "═══ EXECUTING — changes will be applied ═══"
fi
echo

if [[ "$ANY_ACTION" == "0" ]]; then
  echo "No action flags given. Run with --help to see what's available."
  echo
  echo "Most common workflows:"
  echo "  ./cleanup.sh --retry-failed --execute"
  echo "  ./cleanup.sh --pause-all-but pack_<infoHash> --execute -y"
  echo "  ./cleanup.sh --delete-orphan-dirs --execute"
  exit 0
fi

# Confirm API is reachable before doing anything
if ! api_get /api/library >/dev/null 2>&1; then
  echo "ERROR: Cannot reach Albatross API at $API" >&2
  exit 3
fi

# ── Action: retry failed ───────────────────────────────────────────────────
if [[ "$RETRY_FAILED" == "1" ]]; then
  echo "▌ Retry failed items"
  FAILED_IDS=$(api_get /api/library | jq -r '.items[] | select(.status=="failed") | .id')
  COUNT=$(printf '%s\n' "$FAILED_IDS" | grep -c . || true)
  if [[ "$COUNT" == "0" ]]; then
    echo "  Nothing to retry."
  else
    echo "  Found $COUNT failed item(s)."
    if confirm "  Retry all $COUNT items?"; then
      while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "  [dry-run] POST /api/library/$id/retry"
        else
          if api_post "/api/library/$id/retry" >/dev/null; then
            echo "  ✓ retried $id"
          else
            echo "  ✗ failed to retry $id"
          fi
        fi
      done <<<"$FAILED_IDS"
    fi
  fi
  echo
fi

# ── Action: pause a specific pack ──────────────────────────────────────────
if [[ -n "$PAUSE_PACK" ]]; then
  echo "▌ Pause every downloading item in pack: $PAUSE_PACK"
  IDS=$(api_get /api/library \
    | jq -r --arg pid "$PAUSE_PACK" '.items[] | select(.packId==$pid and .status=="downloading") | .id')
  COUNT=$(printf '%s\n' "$IDS" | grep -c . || true)
  if [[ "$COUNT" == "0" ]]; then
    echo "  Nothing downloading in that pack."
  else
    echo "  Will pause $COUNT items."
    if confirm "  Proceed?"; then
      while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "  [dry-run] POST /api/library/$id/pause"
        else
          api_post "/api/library/$id/pause" >/dev/null && echo "  ✓ paused $id"
        fi
      done <<<"$IDS"
    fi
  fi
  echo
fi

# ── Action: pause all packs except one ─────────────────────────────────────
if [[ -n "$PAUSE_ALL_BUT" ]]; then
  echo "▌ Pause every downloading pack EXCEPT: $PAUSE_ALL_BUT"
  IDS=$(api_get /api/library \
    | jq -r --arg keep "$PAUSE_ALL_BUT" '
      .items[]
      | select(.status=="downloading" and .packId != null and .packId != $keep)
      | .id
    ')
  COUNT=$(printf '%s\n' "$IDS" | grep -c . || true)
  if [[ "$COUNT" == "0" ]]; then
    echo "  Nothing to pause — only $PAUSE_ALL_BUT is active."
  else
    echo "  Will pause $COUNT items across other packs."
    if confirm "  Proceed?"; then
      while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "  [dry-run] POST /api/library/$id/pause"
        else
          api_post "/api/library/$id/pause" >/dev/null && echo "  ✓ paused $id"
        fi
      done <<<"$IDS"
    fi
  fi
  echo
fi

# ── Action: delete orphan pack directories ────────────────────────────────
if [[ "$DELETE_ORPHAN_DIRS" == "1" ]]; then
  echo "▌ Delete orphan pack directories under $LIBRARY_DIR"
  if [[ ! -d "$LIBRARY_DIR" ]]; then
    echo "  Library dir not found — skipping."
  else
    TRACKED=$(mktemp)
    api_get /api/library \
      | jq -r '.items[] | select(.filePath != null) | .filePath' \
      | awk -F/ '{print $1}' | sort -u > "$TRACKED"

    ORPHAN_COUNT=0
    while IFS= read -r d; do
      name=$(basename "$d")
      if ! grep -Fxq "$name" "$TRACKED"; then
        size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
        echo "  Orphan: $size  $name"
        ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
        if confirm "    Delete $name ($size)?"; then
          if [[ "$DRY_RUN" == "1" ]]; then
            echo "    [dry-run] rm -rf $d"
          else
            rm -rf "$d" && echo "    ✓ deleted"
          fi
        fi
      fi
    done < <(find "$LIBRARY_DIR" -mindepth 1 -maxdepth 1 -type d)
    rm -f "$TRACKED"

    if [[ "$ORPHAN_COUNT" == "0" ]]; then
      echo "  No orphan directories found."
    fi
  fi
  echo
fi

# ── Action: recover a wiped pack ──────────────────────────────────────────
if [[ -n "$RECOVER_MAGNET" ]]; then
  echo "▌ Recover wiped pack via add-pack"
  if [[ -z "$RECOVER_IMDB" ]]; then
    echo "  ERROR: --recover-pack requires both MAGNET and IMDB args" >&2
    exit 2
  fi
  # Extract infoHash from magnet
  INFOHASH=$(printf '%s' "$RECOVER_MAGNET" | grep -oE 'btih:[a-f0-9]{40}' | head -1 | sed 's/^btih://')
  if [[ -z "$INFOHASH" ]]; then
    echo "  ERROR: could not extract infoHash from magnet" >&2
    exit 2
  fi
  # Try to read a display name from dn=
  NAME=$(printf '%s' "$RECOVER_MAGNET" | grep -oE 'dn=[^&]*' | head -1 | sed 's/^dn=//' | sed 's/+/ /g; s/%20/ /g; s/%28/(/g; s/%29/)/g')
  [[ -z "$NAME" ]] && NAME="$RECOVER_IMDB"
  echo "  imdbId:    $RECOVER_IMDB"
  echo "  infoHash:  $INFOHASH"
  echo "  name:      $NAME"
  echo "  season:    0 (complete pack mode)"
  if confirm "  Re-add this pack to the library?"; then
    BODY=$(jq -n \
      --arg imdbId "$RECOVER_IMDB" \
      --arg name "$NAME" \
      --arg magnetUri "$RECOVER_MAGNET" \
      --arg infoHash "$INFOHASH" \
      '{imdbId: $imdbId, name: $name, magnetUri: $magnetUri, infoHash: $infoHash, season: 0}')
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "  [dry-run] POST /api/library/add-pack"
      echo "  body: $BODY"
    else
      RESP=$(api_post /api/library/add-pack "$BODY")
      echo "  Response: $RESP"
    fi
  fi
  echo
fi

# ── Action: restart container ─────────────────────────────────────────────
if [[ "$RESTART_CONTAINER" == "1" ]]; then
  echo "▌ Restart container '$CONTAINER'"
  if confirm "  This will interrupt all running downloads. Proceed?"; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "  [dry-run] sudo docker restart $CONTAINER"
    else
      sudo docker restart "$CONTAINER" && echo "  ✓ restarted"
    fi
  fi
  echo
fi

echo "Done."
