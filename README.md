# Albatross Streaming

A fully automated setup that turns an NVIDIA Jetson Orin Nano into a secure home media streaming server with a mobile-friendly interface and VPN access.

## What You Get

- **Albatross Mobile UI** — a lightweight, mobile-first web interface with dual streaming modes, built-in video player, live TV, and a download library
- **Stremio Server** — stream movies and TV shows from anywhere, with content cached to local or external storage
- **Tailscale VPN** — secure peer-to-peer tunnel so your streaming server is never exposed to the public internet (no port forwarding needed, works behind CGNAT)
- **DuckDNS** (optional) — keeps your server reachable when your home IP changes
- **Health Monitoring** — auto-restarts crashed containers every 5 minutes

## Requirements

- NVIDIA Jetson Orin Nano Developer Kit
- JetPack SD card image flashed and booted (Ubuntu 22.04)
- Active ethernet connection (WiFi works but ethernet recommended)
- At least 3GB free disk space
- Optional: external USB hard drive for content caching
- Optional: free [DuckDNS](https://www.duckdns.org) account for dynamic DNS

## Headless Setup (from your laptop)

The entire setup can be done from your laptop over SSH — no monitor or keyboard needed on the Jetson.

### Step 1 — Flash JetPack

On your laptop:

1. Download the [JetPack SD card image](https://developer.nvidia.com/embedded/jetpack) for Orin Nano
2. Flash it to a microSD card using [Etcher](https://etcher.balena.io) or NVIDIA SDK Manager
3. Insert the microSD into the Jetson

### Step 2 — First Boot + Serial Console

4. Connect the Jetson to your router with an **ethernet cable**
5. Connect the Jetson's **USB-C port** to your laptop with a USB cable
6. Plug in the Jetson's **power supply** — it boots automatically
7. On your laptop, connect to the serial console:

   **macOS:**
   ```bash
   ls /dev/tty.usb*           # find the device
   screen /dev/tty.usbmodem* 115200
   ```

   **Linux:**
   ```bash
   ls /dev/ttyACM*            # find the device
   screen /dev/ttyACM0 115200
   ```

   **Windows:** Use PuTTY — connect to the COM port at 115200 baud

8. Walk through the Ubuntu setup in the serial console:
   - Accept the license
   - Pick language, timezone, keyboard
   - **Create your user** (e.g. `jetson`) — remember the password
   - Let it finish and reboot

### Step 3 — SSH In

9. Find the Jetson's IP address. Either:
   - Check your router's admin page for connected devices, or
   - In the serial console after reboot, run: `ip addr show eth0 | grep inet`

10. From your laptop, SSH in:
    ```bash
    ssh jetson@192.168.1.XX
    ```

### Private Repo Access

This is a private repository. You need authentication configured before cloning or pulling.

**Option A — SSH Deploy Key (recommended for Jetson)**

1. On the Jetson, generate a key:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/alabtross_deploy -N ""
   ```
2. Print the public key:
   ```bash
   cat ~/.ssh/alabtross_deploy.pub
   ```
3. Go to **github.com/Dzifferer/Alabtross-Streaming → Settings → Deploy keys → Add deploy key**, paste the public key.
4. Configure SSH to use this key for GitHub:
   ```bash
   cat >> ~/.ssh/config << 'EOF'
   Host github.com
     IdentityFile ~/.ssh/alabtross_deploy
   EOF
   chmod 600 ~/.ssh/config
   ```
5. Clone with SSH:
   ```bash
   git clone git@github.com:Dzifferer/Alabtross-Streaming.git
   ```

**Option B — Personal Access Token (HTTPS)**

1. Go to **github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens**, create a token with `Contents: Read` for this repo.
2. Clone using the token:
   ```bash
   git clone https://<YOUR_TOKEN>@github.com/Dzifferer/Alabtross-Streaming.git
   ```
   Or configure the credential helper so you only enter it once:
   ```bash
   git config --global credential.helper store
   git clone git@github.com:Dzifferer/Alabtross-Streaming.git  # See 'Private Repo Access' above
   # enter username + token when prompted
   ```

**Already cloned via HTTPS?** Switch to SSH:
```bash
cd ~/Alabtross-Streaming
git remote set-url origin git@github.com:Dzifferer/Alabtross-Streaming.git
```

### Step 4 — Run the Setup (headless)

11. Plug in your **external USB drive** if using one. Then find the partition name:
    ```bash
    lsblk -o NAME,SIZE,FSTYPE,TYPE
    ```
    Look for your USB drive (e.g. `sda1`). The OS drive is `mmcblk0` or `nvme0n1` — don't use those.

12. Run the setup in fully headless mode:
    ```bash
    sudo apt-get update && sudo apt-get install -y git
    git clone git@github.com:Dzifferer/Alabtross-Streaming.git  # See 'Private Repo Access' above
    cd Alabtross-Streaming

    # Full setup with external drive, DuckDNS, auto VPN profiles, and UPnP:
    sudo HEADLESS=1 \
         DRIVE_PARTITION=sda1 \
         DUCKDNS_SUBDOMAIN=myserver \
         DUCKDNS_AUTH_TOKEN=your-token-here \
         VPN_PROFILE_NAMES=myphone,laptop \
         ENABLE_UPNP=yes \
         bash jetson_setup.sh

    # Or minimal (no drive, no DuckDNS):
    sudo HEADLESS=1 DRIVE_PARTITION=none bash jetson_setup.sh
    ```

13. If PiVPN triggers a reboot, SSH back in and re-run:
    ```bash
    ssh jetson@192.168.1.XX
    cd Alabtross-Streaming
    sudo HEADLESS=1 DRIVE_PARTITION=sda1 bash jetson_setup.sh
    ```
    It skips completed steps and picks up where it left off.

### Step 5 — Connect Your Devices

The script installs Tailscale automatically. To connect your devices:

14. Install the Tailscale app on your phone/computer
15. Log in with the same account used on the Jetson

No port forwarding or manual configuration needed — Tailscale handles NAT traversal automatically.

### Step 6 — Done

16. The Jetson is now running headless. Disconnect the USB cable if you want — everything runs over ethernet.

17. On your phone: connect Tailscale, open `https://albatross`

18. To SSH in anytime:
    ```bash
    ssh jetson@192.168.1.XX          # from home network
    ssh jetson@<jetson-tailscale-ip> # from Tailscale
    ```

## Quick Start (interactive, with monitor)

If you prefer using a monitor and keyboard on the Jetson:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone git@github.com:Dzifferer/Alabtross-Streaming.git  # See 'Private Repo Access' above
cd Alabtross-Streaming
sudo bash jetson_setup.sh
```

The script asks a few questions upfront (external drive, DuckDNS credentials, VPN profiles, UPnP) then runs fully automatically.

## Headless Mode Environment Variables

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `HEADLESS` | Yes | `1` | Enables unattended mode, skips all prompts |
| `DRIVE_PARTITION` | Yes | `sda1` or `none` | External drive partition, or `none` for local storage |
| `FORMAT_DRIVE` | No | `yes` | Auto-format unformatted drives as ext4 |
| `DUCKDNS_SUBDOMAIN` | No | `myserver` | DuckDNS subdomain (omit to skip DuckDNS) |
| `DUCKDNS_AUTH_TOKEN` | No | `abc123...` | DuckDNS token |
| `VPN_PROFILE_NAMES` | No | `myphone,laptop` | Comma-separated VPN client profiles to auto-create |
| `ENABLE_UPNP` | No | `yes` | Auto-forward port 51820 via UPnP (default: `yes`) |
| `ENABLE_HEALTH` | No | `yes` | Auto-restart crashed containers every 5 min (default: `yes`) |
| `DISABLE_GUI` | No | `yes` | Disable desktop GUI for headless operation (default: `yes`) |
| `EXPRESSVPN_ACTIVATION_CODE` | No | `XXXXXXXXXXXXX` | Enables the ExpressVPN sidecar (see below) |
| `EXPRESSVPN_DEB_PATH` | No* | `/home/jetson/expressvpn_3.x.x_arm64.deb` | *Required when `EXPRESSVPN_ACTIVATION_CODE` is set* — path to the arm64 .deb |
| `EXPRESSVPN_LOCATION` | No | `smart` | Server alias or country (e.g. `usny`, `uk`) — default: `smart` |
| `EXPRESSVPN_PROTOCOL` | No | `lightway_udp` | `lightway_udp`, `lightway_tcp`, or `auto` — default: `lightway_udp` |

## Routing the streaming containers through ExpressVPN (optional)

If you want Stremio and the Mobile UI's torrent scrapers to egress through
ExpressVPN instead of your home IP, the setup script can build a sidecar
container that runs the official ExpressVPN Linux CLI and shares its network
namespace with the two app containers. Tailscale, SSH, and apt keep using
your normal connection — only the streaming containers are affected.

**Trade-off:** Routing the Mobile UI through the VPN means it can no longer
use `--net=host`, so SSDP multicast for local Chromecast / DLNA discovery is
lost. Streaming on the controlling phone or laptop browser still works.

### Steps

1. On your laptop, log in at [expressvpn.com](https://www.expressvpn.com),
   go to **Set Up ExpressVPN → Linux → Raspberry Pi 64-bit**, and download
   the `expressvpn_*_arm64.deb` file. Copy it to the Jetson:
   ```bash
   scp expressvpn_*_arm64.deb jetson@192.168.1.XX:~/
   ```
2. Copy your **activation code** from the same page (looks like a long
   alphanumeric string).
3. Run the setup with the VPN env vars set:
   ```bash
   sudo HEADLESS=1 \
        DRIVE_PARTITION=sda1 \
        EXPRESSVPN_ACTIVATION_CODE=YOUR_CODE_HERE \
        EXPRESSVPN_DEB_PATH=/home/jetson/expressvpn_3.80.0.8_arm64.deb \
        EXPRESSVPN_LOCATION=smart \
        EXPRESSVPN_PROTOCOL=lightway_udp \
        bash jetson_setup.sh
   ```
   Or launch the interactive mode and answer "yes" when prompted for
   ExpressVPN.
4. Verify the VPN is up and hiding the egress IP:
   ```bash
   docker exec expressvpn expressvpn status
   docker exec stremio-server curl -s https://api.ipify.org
   ```
   The second command should print the ExpressVPN server's IP, not your
   home IP.

### Useful VPN commands

```bash
docker logs expressvpn                              # View VPN daemon logs
docker exec expressvpn expressvpn status            # Check connection
docker exec expressvpn expressvpn list              # List server aliases
docker exec expressvpn expressvpn connect usny      # Switch location
docker exec expressvpn expressvpn disconnect        # Stop the tunnel
docker restart expressvpn stremio-server alabtross-mobile  # Full VPN bounce
```

> The dependent containers share the VPN container's network namespace. If
> you restart `expressvpn`, you must also restart `stremio-server` and
> `alabtross-mobile` so they re-attach to the new namespace. The
> `alabtross-health` cron job handles this automatically every 5 minutes.

## Streaming Modes

The Mobile UI supports two streaming modes, switchable in Settings:

### Custom Mode (default)

Streams are fetched directly from torrent sources — no Stremio addons needed:

| Source | Type | Method |
|--------|------|--------|
| The Pirate Bay | Movies & Series | JSON API (fastest) |
| YTS | Movies | JSON API (high quality, small files) |
| EZTV | TV Series | JSON API (episode-level results) |
| 1337x | Both | HTML scraping (general fallback) |

Streams are ranked by format (browser-playable MP4/WebM first) then by seed count. Dead torrents (< 3 seeds) are filtered out.

### Stremio Mode

Uses the Stremio addon ecosystem. After switching to Stremio mode in Settings:

1. Set the server URL to `http://<jetson-ip>:11470`
2. Add the **Torrentio** addon for stream sources
3. Streams are auto speed-tested and ranked by response time

Metadata (movie info, posters, search) always comes from **Cinemeta** regardless of mode.

## After Setup

1. **Connect** your phone/laptop to Tailscale
2. **Open** `https://albatross` in your mobile browser (or `https://albatross.<your-tailnet>.ts.net`)
3. **Add to Home Screen** for an app-like experience (it's a PWA)
4. Browse, search, and stream — the default Custom mode works immediately with no extra configuration

## Ports

| Service | Port | Protocol | Exposed to Internet |
|---------|------|----------|---------------------|
| Albatross (HTTPS) | 443 | TCP | No (Tailscale Serve) |
| Albatross (HTTP) | 8080 | TCP | No (LAN fallback) |
| Stremio Server | 11470 | TCP | No (Tailscale only) |
| SSH | 22 | TCP | No (LAN only) |

> Port 443 is served by Tailscale Serve, which proxies HTTPS traffic to the local Express server on port 8080 with automatic TLS certificates.

## Mobile UI Features

- **Dual streaming modes** — Custom (direct torrent sources) or Stremio (addon-based)
- Browse catalogs, search movies and series
- Season/episode navigation for TV shows
- Auto speed-tests all available streams and picks the fastest source
- **Library** — download movies/episodes to the server for offline playback
- **Live TV** — paste an M3U/M3U8 playlist URL in Settings to browse IPTV channels
- **Share** — Tailscale setup guide for connecting other devices
- VPN detection — warns if you're not connected through Tailscale
- PWA installable — add to home screen for a native app feel
- Built-in video player with range-request support

## Useful Commands

```bash
docker logs stremio-server        # View Stremio logs
docker restart stremio-server     # Restart Stremio
docker stats stremio-server       # CPU/RAM usage
docker logs alabtross-mobile      # View Mobile UI logs
docker restart alabtross-mobile   # Restart Mobile UI
tailscale status                  # Check Tailscale VPN status
tailscale ip                      # Show Tailscale IP address
df -h /mnt/movies                 # Check external drive space
cat /var/log/alabtross-health.log # View health monitor log
```

## Architecture

```
Phone/Laptop
    |
    | Tailscale VPN (encrypted peer-to-peer)
    |
Jetson Orin Nano (home network)
    |
    +-- Albatross Mobile UI (port 8080, Docker)
    |       |
    |       +-- Custom Mode: scrapes TPB/YTS/EZTV/1337x directly
    |       +-- Stremio Mode: proxies API requests to Stremio
    |       +-- Library: downloads torrents to server storage
    |       +-- Live TV: proxies M3U/IPTV streams
    |
    +-- Stremio Server (port 11470, Docker)
    |       |
    |       +-- Fetches streams via addons (Torrentio, etc.)
    |       +-- Caches content to external drive
    |       +-- Serves HLS video to your device
    |
    +-- Health Monitor (cron, every 5 min)
    |       +-- Auto-restarts crashed containers
    |
    +-- DuckDNS (cron, every 5 min, optional)
            +-- Updates dynamic DNS record
```

## Troubleshooting

**Stremio not responding:**
```bash
docker logs stremio-server
docker restart stremio-server
```

**Can't connect via VPN from outside home:**
- Check Tailscale is running: `tailscale status`
- Verify the Jetson appears in your Tailscale admin console
- Try `tailscale ping <jetson-name>` from another device

**Mobile UI not loading:**
```bash
docker logs alabtross-mobile
docker restart alabtross-mobile
```

**HTTPS URL not working (https://albatross):**
```bash
tailscale serve status                                      # check if serve is active
sudo tailscale serve --bg --https=443 http://localhost:8080  # re-enable if needed
tailscale set --hostname=albatross                           # ensure hostname is set
```

**External drive not mounting on reboot:**
```bash
sudo mount /mnt/movies
sudo systemctl status systemd-fsck@dev-sdX.service
```

**Re-enable desktop GUI (if needed):**
```bash
sudo systemctl set-default graphical.target
sudo reboot
```

**View health monitor activity:**
```bash
cat /var/log/alabtross-health.log
```
