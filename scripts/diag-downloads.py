#!/usr/bin/env python3
"""
Albatross — Download Bottleneck Diagnostic

Hits the server's /api/diagnostics/system endpoint and pretty-prints:
  * the bottleneck hint
  * host CPU / memory / NIC rx / disk I/O
  * the gap between host NIC rx and torrent-accounted throughput
    (a big gap usually means a stream-playback engine is pulling
     bytes that don't show up in the Downloads panel, or another
     process on the host is using the NIC)
  * a per-torrent table sorted by speed

Pure stdlib — runs on the Jetson host directly (no node, no pip).

Usage:
  python3 scripts/diag-downloads.py                  # http://localhost:8080
  python3 scripts/diag-downloads.py --host 10.0.0.5
  python3 scripts/diag-downloads.py --port 8081
  python3 scripts/diag-downloads.py --ms 2000        # sample window (200-5000)
  python3 scripts/diag-downloads.py --json           # raw payload, no formatting
  python3 scripts/diag-downloads.py --watch          # re-sample every 3s

Exits non-zero if the server is unreachable or returns an error.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

RESET = "\x1b[0m"
DIM = "\x1b[2m"
BOLD = "\x1b[1m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
GREEN = "\x1b[32m"


def fmt_bps(bps):
    if not bps or bps < 1:
        return "    0 B/s"
    if bps < 1024:
        return f"{bps:5.0f} B/s"
    if bps < 1024 * 1024:
        return f"{bps / 1024:5.1f} KB/s"
    if bps < 1024 * 1024 * 1024:
        return f"{bps / 1024 / 1024:5.2f} MB/s"
    return f"{bps / 1024 / 1024 / 1024:5.2f} GB/s"


def fmt_pct(n):
    if n is None:
        return "  ?"
    try:
        return f"{float(n):3.0f}%"
    except (TypeError, ValueError):
        return "  ?"


def truncate(s, n):
    s = "" if s is None else str(s)
    return s.ljust(n) if len(s) <= n else s[: n - 1] + "…"


def hint_color(hint):
    if not hint:
        return ""
    if any(k in hint for k in ("cpu_bound", "memory_pressure", "host_has_headroom")):
        return RED
    if any(k in hint for k in ("swarm_or_protocol", "network_or_swarm")):
        return YELLOW
    return GREEN


def fetch_diag(host, port, ms, timeout=15):
    url = f"http://{host}:{port}/api/diagnostics/system?ms={ms}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} from {url}")
        return json.loads(resp.read().decode("utf-8"))


def render(d):
    lines = []
    hint = d.get("hint") or "unknown"
    c = hint_color(hint)

    sample_ms = d.get("sampleMs", "?")
    lines.append(f"{BOLD}── Albatross Download Diagnostic ──{RESET}  (sampled {sample_ms}ms)")
    lines.append("")
    lines.append(f"{BOLD}Bottleneck{RESET}: {c}{hint}{RESET}")
    lines.append("")

    # Host
    host = d.get("host") or {}
    cpu = host.get("cpu") or {}
    mem = host.get("memory") or {}
    lines.append(f"{BOLD}Host{RESET}")
    load_str = ""
    load_avg = cpu.get("loadAvg")
    if isinstance(load_avg, list) and load_avg:
        load_str = "   load " + " ".join(f"{float(n):.2f}" for n in load_avg)
    lines.append(f"  cpu    {fmt_pct(cpu.get('usagePct'))}{load_str}")
    lines.append(f"  memory {fmt_pct(mem.get('usedPct'))}")
    lines.append(
        f"  net    rx {fmt_bps(host.get('totalNetRxBps') or 0)}   "
        f"tx {fmt_bps(host.get('totalNetTxBps') or 0)}"
    )
    lines.append(
        f"  disk   rd {fmt_bps(host.get('totalDiskReadBps') or 0)}   "
        f"wr {fmt_bps(host.get('totalDiskWriteBps') or 0)}"
    )
    lines.append("")

    # Accounted-vs-host gap. Key number for "UI says X, device says Y".
    torrents = d.get("torrents") or {}
    acc = torrents.get("totalDownloadBps") or 0
    rx = host.get("totalNetRxBps") or 0
    gap = max(0, rx - acc)
    accounted_pct = (acc / rx * 100) if rx > 0 else None

    active = torrents.get("active") or 0
    total_peers = torrents.get("totalPeers") or 0
    lines.append(f"{BOLD}Torrents{RESET}  ({active} active, {total_peers} peers total)")
    lines.append(f"  accounted:   {fmt_bps(acc)}")
    lines.append(f"  host nic rx: {fmt_bps(rx)}")
    gap_line = f"  unaccounted: {fmt_bps(gap)}"
    if accounted_pct is not None:
        gap_line += f"   {DIM}({accounted_pct:.0f}% of rx attributed to torrents){RESET}"
    lines.append(gap_line)

    if gap > 500 * 1024 and gap > acc * 0.5:
        lines.append(
            f"  {c}⚠ large gap — likely a stream-playback engine is pulling bytes not"
            f" shown in Downloads UI,{RESET}"
        )
        lines.append(
            f"  {c}  or another process on the host is using the NIC"
            f" (check with: iftop / nethogs){RESET}"
        )
    lines.append("")

    # Per-torrent table
    rows = list(torrents.get("perTorrent") or [])
    rows.sort(key=lambda r: r.get("downloadBps") or 0, reverse=True)
    if not rows:
        lines.append(f"{DIM}(no active torrents){RESET}")
    else:
        lines.append(f"{BOLD}Per-torrent{RESET}")
        lines.append(
            f"  {'source':<8} {'name':<42} {'speed':>10}  {'peers':>5}"
        )
        lines.append(
            f"  {DIM}{'-' * 8} {'-' * 42} {'-' * 10}  {'-' * 5}{RESET}"
        )
        for row in rows:
            speed = fmt_bps(row.get("downloadBps") or 0)
            peers = str(row.get("peers") or 0)
            lines.append(
                f"  {truncate(row.get('source'), 8)} "
                f"{truncate(row.get('name'), 42)} "
                f"{speed:>10}  {peers:>5}"
            )

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Albatross download bottleneck diagnostic",
    )
    parser.add_argument("--host", default=os.environ.get("ALBATROSS_HOST", "localhost"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    parser.add_argument(
        "--ms",
        type=int,
        default=1000,
        help="diagnostic sample window in ms (200-5000)",
    )
    parser.add_argument("--json", action="store_true", help="print raw JSON payload")
    parser.add_argument("--watch", action="store_true", help="re-sample every 3s")
    args = parser.parse_args()

    def run_once():
        d = fetch_diag(args.host, args.port, args.ms)
        if args.json:
            sys.stdout.write(json.dumps(d, indent=2) + "\n")
        else:
            if args.watch:
                sys.stdout.write("\x1b[2J\x1b[H")
            sys.stdout.write(render(d) + "\n")
        sys.stdout.flush()

    try:
        run_once()
        while args.watch:
            try:
                time.sleep(3)
                run_once()
            except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
                sys.stderr.write(f"[diag] {e}\n")
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
        sys.stderr.write(f"[diag] failed: {e}\n")
        sys.stderr.write(
            f"[diag] is the server running on http://{args.host}:{args.port}?\n"
        )
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
