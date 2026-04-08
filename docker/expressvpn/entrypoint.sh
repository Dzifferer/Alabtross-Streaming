#!/bin/bash
#
# ExpressVPN container entrypoint.
#
# Flow:
#   1. Verify the tun device is available.
#   2. Start `expressvpnd` in the background.
#   3. On first boot, feed the activation code in via `expect`.
#   4. Set preferences (protocol, disable telemetry, disable network_lock
#      so ExpressVPN's own iptables rules don't fight Docker's bridge).
#   5. Connect to EXPRESSVPN_LOCATION (default: smart).
#   6. Watch the connection in a loop and reconnect if it drops.
#
# Required env vars:
#   EXPRESSVPN_ACTIVATION_CODE   — activation code from your dashboard
#
# Optional env vars:
#   EXPRESSVPN_LOCATION          — server alias or country (default: smart)
#   EXPRESSVPN_PROTOCOL          — lightway_udp | lightway_tcp | auto
#                                  (default: lightway_udp)
#
# Required Docker run flags:
#   --cap-add=NET_ADMIN
#   --device=/dev/net/tun

set -euo pipefail

log() { echo "[expressvpn] $*"; }
die() { log "FATAL: $*"; exit 1; }

# --- Sanity checks ---------------------------------------------------

[[ -c /dev/net/tun ]] || die "/dev/net/tun is missing. Run the container with --cap-add=NET_ADMIN --device=/dev/net/tun"

if [[ -z "${EXPRESSVPN_ACTIVATION_CODE:-}" ]]; then
  die "EXPRESSVPN_ACTIVATION_CODE env var is not set"
fi

PROTOCOL="${EXPRESSVPN_PROTOCOL:-lightway_udp}"
LOCATION="${EXPRESSVPN_LOCATION:-smart}"

# --- Start daemon ----------------------------------------------------

log "Starting expressvpnd..."
/usr/bin/expressvpnd &
DAEMON_PID=$!

# Wait up to 30 seconds for the daemon socket to respond.
log "Waiting for daemon socket..."
for _ in $(seq 1 30); do
  if expressvpn status &>/dev/null; then
    break
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    die "expressvpnd exited before becoming responsive"
  fi
  sleep 1
done
expressvpn status &>/dev/null || die "expressvpnd did not become responsive in 30s"

# --- Activate --------------------------------------------------------

if expressvpn status 2>&1 | grep -qi "Not Activated"; then
  log "Activating CLI with provided code..."
  # `expressvpn activate` is interactive: it prompts for the code and
  # then asks about sharing anonymous info. Drive both prompts with expect.
  export EXPRESSVPN_ACTIVATION_CODE
  expect <<'EXPECT_EOF' || die "Activation expect script failed"
set timeout 60
set code $env(EXPRESSVPN_ACTIVATION_CODE)
spawn expressvpn activate
expect {
  -nocase -re "activation code" { send "$code\r" }
  timeout { exit 1 }
}
expect {
  -nocase -re "(share|anonymous|diagnostic|analytics|information)" { send "n\r"; exp_continue }
  -nocase -re "activated" { }
  timeout { }
  eof { }
}
expect eof
EXPECT_EOF

  if expressvpn status 2>&1 | grep -qi "Not Activated"; then
    die "Activation failed — double-check EXPRESSVPN_ACTIVATION_CODE"
  fi
  log "Activation successful"
else
  log "CLI already activated — skipping"
fi

# --- Preferences -----------------------------------------------------

# network_lock is ExpressVPN's built-in killswitch. It installs iptables
# rules that block non-VPN traffic — which includes the Docker bridge
# path used by dependent containers' port mappings. Turn it off so those
# port mappings keep working. If the VPN drops, the auto-reconnect loop
# below handles it; for a strict kernel-level killswitch, add custom
# iptables rules outside this script.
log "Applying preferences (network_lock=off, protocol=$PROTOCOL)..."
expressvpn preferences set network_lock off      2>&1 | sed 's/^/[expressvpn] /' || true
expressvpn preferences set preferred_protocol "$PROTOCOL" 2>&1 | sed 's/^/[expressvpn] /' || true
expressvpn preferences set send_diagnostics false 2>&1 | sed 's/^/[expressvpn] /' || true
expressvpn preferences set auto_connect false     2>&1 | sed 's/^/[expressvpn] /' || true

# --- Connect ---------------------------------------------------------

log "Connecting to: $LOCATION"
if ! expressvpn connect "$LOCATION"; then
  log "Initial connect failed — retrying in 5s..."
  sleep 5
  expressvpn connect "$LOCATION" || die "Could not connect to ExpressVPN"
fi

expressvpn status || true
log "VPN up. Daemon PID=$DAEMON_PID"

# --- Signal handling -------------------------------------------------

shutdown() {
  log "Signal received — disconnecting and shutting down"
  expressvpn disconnect 2>/dev/null || true
  kill "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# --- Watchdog --------------------------------------------------------

# Poll connection status. If it drops, try to reconnect. If the daemon
# itself dies, exit non-zero so Docker's restart policy brings us back.
while kill -0 "$DAEMON_PID" 2>/dev/null; do
  sleep 30
  if ! expressvpn status 2>&1 | grep -qi "Connected"; then
    log "VPN appears disconnected — attempting reconnect"
    expressvpn connect "$LOCATION" 2>&1 | sed 's/^/[expressvpn] /' || log "Reconnect attempt failed; will retry"
  fi
done

log "expressvpnd exited unexpectedly — container will restart"
exit 1
