# Alabtross Streaming

A fully automated setup that turns an NVIDIA Jetson Orin Nano into a secure home media streaming server with a mobile-friendly interface and VPN access.

## What You Get

- **Stremio Server** — stream movies and TV shows from anywhere, with content cached to local or external storage
- **Alabtross Mobile UI** — a lightweight, mobile-first web interface (replaces web.stremio.com) with auto stream speed testing
- **WireGuard VPN** — secure tunnel so your streaming server is never exposed to the public internet
- **DuckDNS** (optional) — keeps your server reachable when your home IP changes

## Requirements

- NVIDIA Jetson Orin Nano Developer Kit
- JetPack SD card image flashed and booted (Ubuntu 22.04)
- Active ethernet connection (WiFi works but ethernet recommended)
- At least 3GB free disk space
- Optional: external USB hard drive for content caching
- Optional: free [DuckDNS](https://www.duckdns.org) account for dynamic DNS

## Quick Start

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Dzifferer/Alabtross-Streaming.git
cd Alabtross-Streaming
sudo bash jetson_setup.sh
```

The script asks a few questions upfront (external drive, DuckDNS credentials) then runs fully automatically. If PiVPN requests a reboot, re-run the script afterward — it detects completed steps and picks up where it left off.

## After Setup

1. **Router:** Forward port `51820 UDP` to your Jetson's LAN IP
2. **Create a VPN profile:**
   ```bash
   pivpn add
   ```
3. **Get QR code for your phone:**
   ```bash
   pivpn -qr <profilename>
   ```
4. **Connect** with the WireGuard app on your phone
5. **Open** `http://<jetson-ip>:8080` in your mobile browser
6. **Add to Home Screen** for an app-like experience
7. In the mobile UI, go to **Settings** and add the **Torrentio** addon for streams

## Ports

| Service | Port | Protocol | Exposed to Internet |
|---------|------|----------|---------------------|
| Stremio Server | 11470 | TCP | No (VPN only) |
| Alabtross Mobile UI | 8080 | TCP | No (VPN only) |
| WireGuard VPN | 51820 | UDP | Yes (encrypted tunnel) |
| SSH | 22 | TCP | No (LAN only) |

## Mobile UI Features

- Browse catalogs, search movies and series
- Season/episode navigation for TV shows
- Auto speed-tests all available streams and picks the fastest source
- VPN detection — warns if you're not connected through WireGuard
- PWA installable — add to home screen for a native app feel
- Built-in video player

## Useful Commands

```bash
docker logs stremio-server        # View Stremio logs
docker restart stremio-server     # Restart Stremio
docker stats stremio-server       # CPU/RAM usage
docker restart alabtross-mobile   # Restart Mobile UI
pivpn -c                          # List VPN connections
pivpn add                         # Add a new VPN client
pivpn -qr <name>                  # Show QR code for a client
df -h /mnt/movies                 # Check external drive space
```

## Architecture

```
Phone/Laptop
    |
    | WireGuard VPN (port 51820, encrypted)
    |
Jetson Orin Nano (home network)
    |
    +-- Alabtross Mobile UI (port 8080, Docker)
    |       |
    |       +-- Proxies API requests to Stremio
    |
    +-- Stremio Server (port 11470, Docker)
            |
            +-- Fetches streams via addons (Torrentio, etc.)
            +-- Caches content to external drive
            +-- Serves HLS video to your device
```

## Troubleshooting

**Stremio not responding:**
```bash
docker logs stremio-server
docker restart stremio-server
```

**Can't connect via VPN from outside home:**
- Confirm port 51820 UDP is forwarded on your router
- Check your DuckDNS hostname resolves: `ping yourdomain.duckdns.org`
- Check WireGuard is running: `sudo systemctl status wg-quick@wg0`

**Mobile UI not loading:**
```bash
docker logs alabtross-mobile
docker restart alabtross-mobile
```

**External drive not mounting on reboot:**
```bash
sudo mount /mnt/movies
sudo systemctl status systemd-fsck@dev-sdX.service
```
