#!/usr/bin/env bash
# Quick download diagnostic — shows whether slow downloads are the Jetson,
# the swarm, or (most often) a stream-playback engine pulling bytes that
# don't show up in the Downloads panel.
#
# Usage: ./diag.sh [--host H] [--port P] [--ms N] [--json] [--watch]
#   --host H    server host (default: localhost)
#   --port P    server port (default: 8080)
#   --ms N      diagnostic sample window in ms, 200-5000 (default: 1000)
#   --json      print raw JSON payload instead of formatted output
#   --watch     re-sample every 3s until ctrl-c
#
# Runs against http://localhost:8080/api/diagnostics/system by default,
# which is the port the container binds on the host.
set -e

cd "$(dirname "$0")"

if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found on this host." >&2
  echo "On the Jetson, install with: sudo apt install python3" >&2
  exit 1
fi

exec python3 scripts/diag-downloads.py "$@"
