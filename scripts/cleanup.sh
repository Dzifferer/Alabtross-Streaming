#!/usr/bin/env bash
# Albatross — Library Cleanup
#
# Reclaims disk space by:
#   1. Removing failed downloads and their on-disk files (audit remediation)
#   2. Removing orphaned temp files (.ffmpeg-tmp, stray fragments)
#   3. Optionally removing orphaned video files not tracked by metadata
#   4. Removing empty directories left behind by prior deletes
#   5. Running the dedup script to collapse duplicate-infoHash folders
#
# This script drives the server's built-in audit/remediation API so the
# library metadata stays consistent — do NOT just `rm -rf` under
# /mnt/movies/torrent-cache/library or the UI will show ghosts.
#
# Usage:
#   ./scripts/cleanup.sh                    # dry-run (default, safe)
#   ./scripts/cleanup.sh --apply            # actually delete
#   ./scripts/cleanup.sh --apply --aggressive
#                                           # also remove orphan video files
#                                           # (files on disk the library
#                                           # doesn't know about)
#   ./scripts/cleanup.sh --host http://albatross:8080 --apply
#   ./scripts/cleanup.sh --no-dedup         # skip dedup-library.js
#   ./scripts/cleanup.sh --deep             # ffprobe-verify every file
#                                           # (slow, catches truncated files)
#
# Exit codes:
#   0 — success
#   1 — server unreachable
#   2 — invalid arguments
#   3 — remediation API error
set -u

HOST="http://localhost:8080"
LIBRARY_PATH="${LIBRARY_PATH:-/mnt/movies/torrent-cache/library}"
APPLY=0
AGGRESSIVE=0
DEEP=0
RUN_DEDUP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)       APPLY=1; shift ;;
    --aggressive)  AGGRESSIVE=1; shift ;;
    --deep)        DEEP=1; shift ;;
    --no-dedup)    RUN_DEDUP=0; shift ;;
    --host)        HOST="$2"; shift 2 ;;
    --library)     LIBRARY_PATH="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: 'jq' is required.  sudo apt install -y jq" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: 'curl' is required.  sudo apt install -y curl" >&2
  exit 1
fi

DRY_RUN="true"
MODE_LABEL="DRY RUN (no changes)"
if [[ "$APPLY" -eq 1 ]]; then
  DRY_RUN="false"
  MODE_LABEL="APPLY (deleting files)"
fi

REMOVE_ORPHAN_FILES="false"
if [[ "$AGGRESSIVE" -eq 1 ]]; then
  REMOVE_ORPHAN_FILES="true"
fi

DEEP_FLAG="false"
if [[ "$DEEP" -eq 1 ]]; then
  DEEP_FLAG="true"
fi

echo "=== Albatross Cleanup ==="
echo "Mode:         $MODE_LABEL"
echo "Host:         $HOST"
echo "Deep audit:   $DEEP_FLAG"
echo "Remove orphan video files: $REMOVE_ORPHAN_FILES"
echo "Run dedup:    $RUN_DEDUP"
echo

# ─── 1. Capture before snapshot ─────────────────────────────────────────
BEFORE_BYTES=0
if [[ -d "$LIBRARY_PATH" ]]; then
  BEFORE_BYTES=$(du -sb "$LIBRARY_PATH" 2>/dev/null | awk '{print $1}')
  BEFORE_BYTES="${BEFORE_BYTES:-0}"
fi
echo "Library size before: ${BEFORE_BYTES} bytes"
echo

# ─── 2. Show the audit report ───────────────────────────────────────────
echo "── Auditing library (this can take a moment) ──────────"
AUDIT_URL="/api/library/audit"
if [[ "$DEEP" -eq 1 ]]; then
  AUDIT_URL="${AUDIT_URL}?deep=1"
fi
AUDIT_JSON=$(curl -fsS --max-time 120 "${HOST}${AUDIT_URL}" 2>/dev/null || true)
if [[ -z "$AUDIT_JSON" ]]; then
  echo "ERROR: Cannot reach audit endpoint at ${HOST}${AUDIT_URL}" >&2
  echo "  Is the container running?  sudo docker ps" >&2
  exit 1
fi

echo "$AUDIT_JSON" | jq -r '
  .summary // {} |
  "  ok:                \(.ok                // 0)\n" +
  "  missing files:     \(.missingFile       // 0)\n" +
  "  wrong-size files:  \(.wrongSize         // 0)\n" +
  "  zero-byte files:   \(.zeroByte          // 0)\n" +
  "  corrupt files:     \(.corrupt           // 0)\n" +
  "  stale downloading: \(.staleDownloading  // 0)\n" +
  "  bad metadata:      \(.badMetadata       // 0)\n" +
  "  orphan video:      \(.orphanedFiles     // 0)\n" +
  "  orphan temp:       \(.orphanedTempFiles // 0)\n" +
  "  empty directories: \(.orphanedEmptyDirs // 0)"
'
echo

ISSUE_COUNT=$(echo "$AUDIT_JSON" | jq '(.issues // []) | length')
ORPHAN_COUNT=$(echo "$AUDIT_JSON" | jq '(.orphans // []) | length')
if [[ "$ISSUE_COUNT" -eq 0 && "$ORPHAN_COUNT" -eq 0 ]]; then
  echo "No broken items or orphans — library is clean."
else
  echo "Issues: $ISSUE_COUNT   Orphans: $ORPHAN_COUNT"
fi
echo

# ─── 3. Drive the remediate endpoint ───────────────────────────────────
BODY=$(jq -n \
  --argjson dryRun "$DRY_RUN" \
  --argjson removeOrphanFiles "$REMOVE_ORPHAN_FILES" \
  --argjson deep "$DEEP_FLAG" \
  '{
    action: "remove",
    removeOrphanFiles:      $removeOrphanFiles,
    removeOrphanTempFiles:  true,
    removeEmptyDirectories: true,
    deep:                   $deep,
    dryRun:                 $dryRun
  }')

echo "── Remediation ($MODE_LABEL) ──────────────────────────"
REMEDIATE_JSON=$(curl -fsS --max-time 300 \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "${HOST}/api/library/audit/remediate" 2>/dev/null || true)

if [[ -z "$REMEDIATE_JSON" ]]; then
  echo "ERROR: Remediate endpoint failed" >&2
  exit 3
fi

echo "$REMEDIATE_JSON" | jq -r '
  . as $r |
  (if $r.error then
    "ERROR: " + $r.error
  else
    "  items removed:    \(.removed      // 0)\n" +
    "  items requeued:   \(.requeued     // 0)\n" +
    "  orphans removed:  \(.orphansRemoved // 0)\n" +
    "  temps removed:    \(.tempFilesRemoved // 0)\n" +
    "  dirs removed:     \(.emptyDirsRemoved // 0)\n" +
    "  bytes reclaimed:  \(.bytesReclaimed // 0)"
  end)
'
echo

# ─── 4. Optionally run the dedup script ────────────────────────────────
if [[ "$RUN_DEDUP" -eq 1 ]]; then
  echo "── Dedup pass ─────────────────────────────────────────"
  DEDUP_SCRIPT="$(dirname "$0")/dedup-library.js"
  if [[ ! -f "$DEDUP_SCRIPT" ]]; then
    echo "WARNING: $DEDUP_SCRIPT not found — skipping dedup." >&2
  elif ! command -v node >/dev/null 2>&1; then
    echo "WARNING: 'node' not installed on host — skipping dedup."
    echo "         Run it inside the container instead:"
    echo "         sudo docker exec alabtross-mobile node /app/scripts/dedup-library.js"
  else
    DEDUP_ARGS=("--library" "$LIBRARY_PATH")
    if [[ "$APPLY" -eq 1 ]]; then
      DEDUP_ARGS+=("--apply")
    fi
    echo "Running: node $DEDUP_SCRIPT ${DEDUP_ARGS[*]}"
    node "$DEDUP_SCRIPT" "${DEDUP_ARGS[@]}" || echo "(dedup exited non-zero)"
  fi
  echo
fi

# ─── 5. After snapshot + reclaimed summary ─────────────────────────────
AFTER_BYTES=0
if [[ -d "$LIBRARY_PATH" ]]; then
  AFTER_BYTES=$(du -sb "$LIBRARY_PATH" 2>/dev/null | awk '{print $1}')
  AFTER_BYTES="${AFTER_BYTES:-0}"
fi

RECLAIMED=$((BEFORE_BYTES - AFTER_BYTES))
if [[ "$RECLAIMED" -lt 0 ]]; then RECLAIMED=0; fi

echo "── Summary ────────────────────────────────────────────"
echo "Before:    ${BEFORE_BYTES} bytes"
echo "After:     ${AFTER_BYTES} bytes"
echo "Reclaimed: ${RECLAIMED} bytes"
if [[ "$APPLY" -eq 0 ]]; then
  echo
  echo "This was a DRY RUN. Re-run with --apply to actually delete."
fi
