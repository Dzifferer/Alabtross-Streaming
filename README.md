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

### Step 4 — Run the Setup (headless)

11. Plug in your **external USB drive** if using one. Then find the partition name:
    ```bash
    lsblk -o NAME,SIZE,FSTYPE,TYPE
    ```
    Look for your USB drive (e.g. `sda1`). The OS drive is `mmcblk0` or `nvme0n1` — don't use those.

12. Run the setup in fully headless mode:
    ```bash
    sudo apt-get update && sudo apt-get install -y git
    git clone https://github.com/Dzifferer/Alabtross-Streaming.git
    cd Alabtross-Streaming

    # With external drive + DuckDNS:
    sudo HEADLESS=1 \
         DRIVE_PARTITION=sda1 \
         DUCKDNS_SUBDOMAIN=myserver \
         DUCKDNS_AUTH_TOKEN=your-token-here \
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

### Step 5 — Router + VPN Profiles

All from your laptop over SSH:

14. **Port forward** on your router: `51820 UDP` to the Jetson's IP

15. Create a VPN profile for your phone:
    ```bash
    pivpn add
    ```

16. Get the QR code:
    ```bash
    pivpn -qr myphone
    ```
    Scan it with the WireGuard app on your phone.

### Step 6 — Done

17. The Jetson is now running headless. Disconnect the USB cable if you want — everything runs over ethernet.

18. On your phone: connect WireGuard, open `http://<jetson-ip>:8080`

19. To SSH in anytime:
    ```bash
    ssh jetson@192.168.1.XX      # from home network
    ssh jetson@10.6.0.1          # from VPN
    ```

## Quick Start (interactive, with monitor)

If you prefer using a monitor and keyboard on the Jetson:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Dzifferer/Alabtross-Streaming.git
cd Alabtross-Streaming
sudo bash jetson_setup.sh
```

The script asks a few questions upfront (external drive, DuckDNS credentials) then runs fully automatically.

## Headless Mode Environment Variables

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `HEADLESS` | Yes | `1` | Enables unattended mode, skips all prompts |
| `DRIVE_PARTITION` | Yes | `sda1` or `none` | External drive partition, or `none` for local storage |
| `FORMAT_DRIVE` | No | `yes` | Auto-format unformatted drives as ext4 |
| `DUCKDNS_SUBDOMAIN` | No | `myserver` | DuckDNS subdomain (omit to skip DuckDNS) |
| `DUCKDNS_AUTH_TOKEN` | No | `abc123...` | DuckDNS token |

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

**Re-enable desktop GUI (if needed):**
```bash
sudo systemctl set-default graphical.target
sudo reboot
```
