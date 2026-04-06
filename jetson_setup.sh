#!/bin/bash

# ================================================================
#  JETSON ORIN NANO — STREMIO + WIREGUARD HOME SERVER SETUP
#  jetson_setup.sh
# ================================================================
#
#  PURPOSE
#  -------
#  This script turns a fresh NVIDIA Jetson Orin Nano Developer Kit
#  running JetPack (Ubuntu 22.04) into a home media streaming and
#  VPN server. Once complete you can:
#
#    - Stream movies and TV shows via Stremio from anywhere in
#      the world, with content cached to an external hard drive
#    - Connect securely to your home network from any device using
#      WireGuard VPN (set up via PiVPN)
#    - Access your Stremio server privately through the VPN —
#      the streaming port is never exposed to the public internet
#    - Keep your server reachable even when your home IP changes,
#      using DuckDNS (free dynamic DNS service)
#
#  REQUIREMENTS
#  ------------
#    - NVIDIA Jetson Orin Nano Developer Kit
#    - JetPack SD card image flashed and booted (Ubuntu 22.04)
#    - Active ethernet connection (WiFi works but ethernet recommended)
#    - At least 3GB free disk space on the SD card
#    - Optional: external USB hard drive for movie storage/caching
#    - Optional: free DuckDNS account (https://www.duckdns.org)
#      for remote access when your home IP changes
#
#  HOW TO RUN
#  ----------
#  Copy this file to the Jetson, then in a terminal run:
#
#    sudo bash jetson_setup.sh
#
#  The script will ask a few questions upfront (external drive,
#  DuckDNS credentials) then run fully automatically. The only
#  manual step is the PiVPN wizard which launches mid-way through.
#
#  If PiVPN requests a reboot at the end of its wizard, let it
#  reboot — then run this script again. It detects completed steps
#  and skips them, picking up where it left off.
#
#  WHAT IT DOES (Step by Step)
#  ---------------------------
#  Pre-flight:
#    - Verifies internet connection (ping + wget fallback)
#    - Asks about external drive and DuckDNS upfront so the rest
#      runs without interruption
#    - Checks free disk space and warns if under 3GB
#
#  [1/9] Installing prerequisites
#    - Runs apt-get update and installs: curl, wget, gnupg2,
#      ca-certificates, ntfs-3g (NTFS drive support), bc
#
#  [2/9] Updating system
#    - Runs apt-get upgrade with non-interactive dpkg options
#      so config file conflicts never pause the script
#
#  [3/9] Setting up SSH
#    - Installs openssh-server and enables it on boot
#    - Detects whether the service is called 'ssh' or 'sshd'
#    - After this step you can manage the Jetson remotely:
#      ssh yourusername@<jetson-ip>
#
#  [4/9] Setting up storage
#    - If an external USB drive was selected:
#        * Detects filesystem type (ext4, ntfs, vfat, exfat)
#        * Offers to format unformatted drives as ext4
#        * Checks mkfs exit code — won't proceed on format failure
#        * Warns before formatting whole disks vs partitions
#        * Backs up /etc/fstab before modifying it
#        * Adds drive to fstab with 'nofail' so a missing drive
#          never prevents the system from booting
#        * Mounts the drive at /mnt/movies
#    - If no external drive: uses ~/.stremio-data as local cache
#    - All failures degrade gracefully to local storage rather
#      than aborting the rest of the setup
#
#  [5/9] Installing Docker
#    - Downloads Docker install script to a temp file (not piped
#      directly to shell — catches download failures properly)
#    - Validates the script is non-empty before running it
#    - Waits up to 20 seconds for the Docker daemon to start
#    - Adds the real user (not root) to the docker group
#    - Verifies Docker is responding before continuing
#
#  [6/9] Configuring firewall
#    - If UFW is active, opens port 51820/UDP for WireGuard
#      and 22/TCP for SSH
#    - Stremio port 11470 is intentionally NOT opened — it is
#      only accessible through the VPN tunnel
#
#  [7/9] Starting Stremio Server
#    - Checks if Stremio is already running and healthy first
#      (skips restart if so — safe to re-run after reboot)
#    - Pulls the official ARM64 Stremio server Docker image
#    - Runs the container with:
#        * --restart unless-stopped (auto-starts on reboot)
#        * NO_CORS=1 (allows web client connections)
#        * Volume mapped to your storage path
#        * Ports 11470 and 12470 bound to the LAN IP only
#          (not 0.0.0.0 — UFW blocks external access, VPN clients
#          route through the LAN IP so they can still connect)
#    - Waits up to 30 seconds confirming server responds on 11470
#
#  [8/9] Installing WireGuard VPN
#    - Checks if PiVPN is already installed (skips if so)
#    - Downloads PiVPN installer to a temp file and validates it
#    - Pauses and shows you exactly what options to choose in the
#      PiVPN wizard before launching it
#    - Handles PiVPN reboot requests gracefully
#    - After PiVPN is set up, add client devices with:
#        pivpn add          (creates a profile)
#        pivpn -qr <name>   (shows QR code for mobile)
#
#  [9/9] Setting up DuckDNS (optional)
#    - Creates /opt/duckdns/duck.sh with your credentials
#    - Restricts the script to chmod 700 (token is embedded)
#    - Adds a crontab entry for the real user running every 5 mins
#    - Tests the update immediately and reports OK/fail
#    - Errors from cron runs are logged to ~/.duckdns.log
#
#  Summary:
#    - Prints your local IP, Stremio URL, storage info, VPN port
#    - Lists the manual steps still needed (router port forward,
#      adding VPN client profiles, connecting Stremio web app)
#
#  AFTER SETUP — CONNECTING STREMIO
#  ---------------------------------
#  1. Connect your phone/laptop to WireGuard VPN
#  2. Open https://web.stremio.com in a browser
#  3. Go to Settings → Advanced → Streaming Server URL
#  4. Set it to: http://<your-jetson-ip>:11470
#  5. Install the Torrentio addon from the Stremio addon catalog
#  6. Search for any movie and press play
#
#  ROUTER SETUP (required for remote access)
#  ------------------------------------------
#  Log into your router admin panel and add a port forward:
#    External port : 51820
#    Internal IP   : <your jetson LAN IP>
#    Protocol      : UDP
#
#  FILES CREATED BY THIS SCRIPT
#  -----------------------------
#    /var/log/jetson_setup.log   — full setup log (root-readable only)
#    /etc/fstab                  — modified to auto-mount external drive
#    /etc/fstab.bak.*            — timestamped backup of original fstab
#    /opt/duckdns/duck.sh        — DuckDNS IP update script (chmod 700)
#    ~/.duckdns.log              — DuckDNS update results log
#
#  USEFUL COMMANDS AFTER SETUP
#  ----------------------------
#    docker logs stremio-server     — view Stremio server logs
#    docker restart stremio-server  — restart Stremio
#    docker stats stremio-server    — live CPU/RAM usage
#    pivpn add                      — add a new VPN client device
#    pivpn -c                       — list connected VPN clients
#    pivpn -qr <name>               — show QR code for a client
#    df -h /mnt/movies              — check external drive space
#    cat /var/log/jetson_setup.log  — review this setup log
#
#  TROUBLESHOOTING
#  ---------------
#  Stremio not responding:
#    docker logs stremio-server
#    docker restart stremio-server
#
#  Can't connect via VPN from outside home:
#    - Confirm port 51820 UDP is forwarded on your router
#    - Check your DuckDNS hostname resolves: ping yourdomain.duckdns.org
#    - Check WireGuard is running: sudo systemctl status wg-quick@wg0
#
#  External drive not mounting on reboot:
#    - Check: sudo systemctl status systemd-fsck@dev-sdX.service
#    - The 'nofail' fstab option means a bad drive won't prevent boot
#    - Run manually: sudo mount /mnt/movies
#
#  Script failed mid-way:
#    - Check the log: cat /var/log/jetson_setup.log
#    - Re-run the script — completed steps are detected and skipped
#
# ================================================================

# Don't use set -e globally — handle errors per-command instead
# so one failing step doesn't silently kill the whole script

# ---------------------------------------------------------------
# HEADLESS MODE — set these env vars to skip all interactive prompts
# ---------------------------------------------------------------
#   HEADLESS=1                          — enable unattended mode
#   DRIVE_PARTITION=sda1                — external drive partition (or "none")
#   FORMAT_DRIVE=yes                    — auto-format unformatted drives
#   DUCKDNS_SUBDOMAIN=albatrossburt    — DuckDNS subdomain (or empty to skip)
#   DUCKDNS_AUTH_TOKEN=xxx             — DuckDNS token
#   VPN_PROFILE_NAMES=myphone,laptop   — comma-separated VPN profiles to create
#   ENABLE_HEALTH=yes                  — auto-restart crashed services (default: yes)
#   ENABLE_UPNP=yes                    — auto port forward via UPnP (default: yes)
#   DISABLE_GUI=yes                    — disable desktop for headless (default: yes)
#
# Example (fully headless over SSH):
#   sudo HEADLESS=1 DRIVE_PARTITION=sda1 \
#        VPN_PROFILE_NAMES=myphone,laptop \
#        DUCKDNS_SUBDOMAIN=albatrossburt \
#        DUCKDNS_AUTH_TOKEN=your-token \
#        bash jetson_setup.sh
#
# Example (minimal, no external drive, no DuckDNS):
#   sudo HEADLESS=1 DRIVE_PARTITION=none bash jetson_setup.sh
# ---------------------------------------------------------------

# Prevent apt from showing interactive prompts
export DEBIAN_FRONTEND=noninteractive

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${YELLOW}[..] $1${NC}"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }
die()  { echo -e "${RED}[FATAL]${NC} $1"; exit 1; }
hdr()  { echo -e "\n${BLUE}==== $1 ====${NC}"; }

# Track temp files for cleanup on any exit
TEMP_FILES=()
cleanup() {
  for f in "${TEMP_FILES[@]}"; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------
# Must be run as root
# ---------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
  die "Please run as root:  sudo bash jetson_setup.sh"
fi

# Log everything to file — run after root check so we can write to /var/log
# Pre-create with restricted permissions BEFORE tee opens it
LOG_FILE="/var/log/jetson_setup.log"
mkdir -p /var/log
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
# Strip ANSI color codes from the log so it's readable with cat/grep
exec > >(tee >(sed 's/\x1b\[[0-9;]*m//g' >> "$LOG_FILE")) 2>&1
echo "========================================"
echo "Setup started at $(date)"
echo "========================================"

# Capture the real user who invoked sudo
REAL_USER=${SUDO_USER:-$(logname 2>/dev/null || echo "$USER")}
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
REAL_HOME=${REAL_HOME:-/home/$REAL_USER}  # fallback if getent fails
# Warn if we're running everything as root (no sudo user found)
if [[ "$REAL_USER" == "root" ]]; then
  echo -e "${YELLOW}[WARN] Could not detect a non-root user. Running as root.${NC}"
  REAL_HOME=/root
fi

echo ""
echo "=============================================="
echo "  Jetson Orin Nano — Stremio + VPN Setup"
echo "=============================================="
echo ""

# ---------------------------------------------------------------
# STEP 0 — Internet check
# ---------------------------------------------------------------
hdr "Checking internet connection"
if ! ping -c 2 -W 3 8.8.8.8 &>/dev/null; then
  info "Ping blocked — trying wget fallback..."
  if ! wget -q --spider --timeout=5 https://google.com 2>/dev/null; then
    die "No internet connection detected. Check your ethernet cable and try again."
  fi
fi
ok "Internet connection confirmed"

# ---------------------------------------------------------------
# STEP 1 — Collect info upfront
# ---------------------------------------------------------------
hdr "Configuration"

DRIVE_PART=""
MOUNT_POINT=""
DUCKDNS_DOMAIN=""
DUCKDNS_TOKEN=""
HAS_DUCKDNS="no"

if [[ "${HEADLESS:-0}" == "1" ]]; then
  # ── Headless mode — use env vars, no prompts ──
  info "Running in headless mode (HEADLESS=1)"

  # Drive
  if [[ -n "$DRIVE_PARTITION" && "$DRIVE_PARTITION" != "none" ]]; then
    if [[ -b "/dev/$DRIVE_PARTITION" ]]; then
      DRIVE_PART="$DRIVE_PARTITION"
      MOUNT_POINT="/mnt/movies"
      ok "Using drive /dev/$DRIVE_PART"
    else
      err "/dev/$DRIVE_PARTITION not found — falling back to local storage"
      MOUNT_POINT="$REAL_HOME/.stremio-data"
    fi
  else
    info "No external drive configured — Stremio will cache locally"
    MOUNT_POINT="$REAL_HOME/.stremio-data"
  fi

  # DuckDNS
  if [[ -n "$DUCKDNS_SUBDOMAIN" && -n "$DUCKDNS_AUTH_TOKEN" ]]; then
    DUCKDNS_DOMAIN=$(echo "${DUCKDNS_SUBDOMAIN%.duckdns.org}" | tr '[:upper:]' '[:lower:]')
    DUCKDNS_TOKEN="$DUCKDNS_AUTH_TOKEN"
    HAS_DUCKDNS="yes"
    ok "DuckDNS configured: ${DUCKDNS_DOMAIN}.duckdns.org"
  else
    info "DuckDNS not configured — skipping"
  fi

  # VPN profiles (comma-separated: VPN_PROFILES="myphone,laptop")
  VPN_PROFILES=()
  if [[ -n "$VPN_PROFILE_NAMES" ]]; then
    IFS=',' read -ra VPN_PROFILES <<< "$VPN_PROFILE_NAMES"
  fi

  # Features default to yes in headless mode
  ENABLE_HEALTH="${ENABLE_HEALTH:-yes}"
  DISABLE_GUI="${DISABLE_GUI:-yes}"
  ENABLE_UPNP="${ENABLE_UPNP:-yes}"

else
  # ── Interactive mode — prompt the user ──
  echo "A few quick questions before we start:"
  echo ""

  # ── External drive (auto-detect) ──
  # Find USB block devices that are NOT the boot drive
  BOOT_DISK=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)" 2>/dev/null || echo "")
  USB_PARTS=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    DEV_NAME=$(echo "$line" | awk '{print $1}')
    DEV_SIZE=$(echo "$line" | awk '{print $2}')
    DEV_TYPE=$(echo "$line" | awk '{print $4}')
    DEV_FS=$(echo "$line" | awk '{print $3}')
    # Skip the boot disk and its partitions
    PARENT=$(lsblk -no PKNAME "/dev/$DEV_NAME" 2>/dev/null || echo "")
    [[ "$PARENT" == "$BOOT_DISK" || "$DEV_NAME" == "$BOOT_DISK" ]] && continue
    # Only list partitions (type=part) or whole disks with filesystems
    [[ "$DEV_TYPE" == "part" || (-n "$DEV_FS" && "$DEV_TYPE" == "disk") ]] || continue
    # Skip tiny partitions (<1GB)
    DEV_BYTES=$(lsblk -bno SIZE "/dev/$DEV_NAME" 2>/dev/null || echo "0")
    [[ "$DEV_BYTES" -lt 1073741824 ]] 2>/dev/null && continue
    USB_PARTS+=("$DEV_NAME|$DEV_SIZE|${DEV_FS:-unformatted}")
  done < <(lsblk -o NAME,SIZE,FSTYPE,TYPE --noheadings 2>/dev/null)

  if [[ ${#USB_PARTS[@]} -gt 0 ]]; then
    echo -e "${GREEN}  Detected external drive(s):${NC}"
    echo ""
    for i in "${!USB_PARTS[@]}"; do
      IFS='|' read -r _name _size _fs <<< "${USB_PARTS[$i]}"
      echo "    [$((i+1))] /dev/$_name  — $_size  ($_fs)"
    done
    echo "    [0] Skip — use local storage instead"
    echo ""
    read -p "Select a drive [1]: " DRIVE_CHOICE
    DRIVE_CHOICE=${DRIVE_CHOICE:-1}

    if [[ "$DRIVE_CHOICE" == "0" ]]; then
      echo "No problem — Stremio will cache locally."
      MOUNT_POINT="$REAL_HOME/.stremio-data"
    elif [[ "$DRIVE_CHOICE" =~ ^[0-9]+$ ]] && [[ $DRIVE_CHOICE -ge 1 ]] && [[ $DRIVE_CHOICE -le ${#USB_PARTS[@]} ]]; then
      IFS='|' read -r DRIVE_PART _size _fs <<< "${USB_PARTS[$((DRIVE_CHOICE-1))]}"
      ok "Selected /dev/$DRIVE_PART ($_size, $_fs)"
      MOUNT_POINT="/mnt/movies"
    else
      err "Invalid choice — using local storage"
      MOUNT_POINT="$REAL_HOME/.stremio-data"
    fi
  else
    echo "No external USB drives detected."
    read -p "Enter a partition manually, or press Enter to skip: " DRIVE_PART
    if [[ -n "$DRIVE_PART" && -b "/dev/$DRIVE_PART" ]]; then
      ok "Drive /dev/$DRIVE_PART found"
      MOUNT_POINT="/mnt/movies"
    else
      [[ -n "$DRIVE_PART" ]] && err "/dev/$DRIVE_PART not found"
      echo "Stremio will cache locally. Re-run this script later to add a drive."
      MOUNT_POINT="$REAL_HOME/.stremio-data"
      DRIVE_PART=""
    fi
  fi

  # ── DuckDNS ──
  echo ""
  echo -e "${BLUE}  DuckDNS keeps your server reachable when your home IP changes."
  echo -e "  It's free — sign up at https://www.duckdns.org"
  echo -e "  Your token is shown at the top of the page after login.${NC}"
  echo ""
  read -p "Do you have a DuckDNS account? (yes/no) [no]: " HAS_DUCKDNS
  HAS_DUCKDNS=$(echo "${HAS_DUCKDNS:-no}" | tr '[:upper:]' '[:lower:]')
  [[ "$HAS_DUCKDNS" == "y" ]] && HAS_DUCKDNS="yes"
  [[ "$HAS_DUCKDNS" == "n" ]] && HAS_DUCKDNS="no"

  if [[ "$HAS_DUCKDNS" == "yes" ]]; then
    read -p  "Enter your DuckDNS subdomain (e.g. albatrossburt): " DUCKDNS_DOMAIN
    echo ""
    echo -e "${YELLOW}  Your token is the long string at the top of duckdns.org"
    echo -e "  It looks like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx${NC}"
    read -sp "Paste your DuckDNS token (hidden): " DUCKDNS_TOKEN
    echo ""

    DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN%.duckdns.org}"
    DUCKDNS_DOMAIN=$(echo "$DUCKDNS_DOMAIN" | tr '[:upper:]' '[:lower:]')

    if [[ -n "$DUCKDNS_DOMAIN" && ! "$DUCKDNS_DOMAIN" =~ ^[a-z0-9-]+$ ]]; then
      err "Invalid DuckDNS subdomain '$DUCKDNS_DOMAIN' — only lowercase letters, numbers, hyphens allowed."
      HAS_DUCKDNS="no"
    fi

    if [[ -z "$DUCKDNS_DOMAIN" || -z "$DUCKDNS_TOKEN" ]]; then
      err "DuckDNS domain or token was empty — skipping DuckDNS setup."
      HAS_DUCKDNS="no"
    fi
  fi

  # ── VPN client profiles ──
  echo ""
  echo -e "${BLUE}  Create VPN profiles now so you can connect immediately after setup."
  echo -e "  You can always add more later with: pivpn add${NC}"
  echo ""
  VPN_PROFILES=()
  read -p "How many VPN device profiles to create? (0-10) [1]: " VPN_COUNT
  VPN_COUNT=${VPN_COUNT:-1}
  if [[ "$VPN_COUNT" =~ ^[0-9]+$ ]] && [[ $VPN_COUNT -gt 0 ]] && [[ $VPN_COUNT -le 10 ]]; then
    for i in $(seq 1 "$VPN_COUNT"); do
      read -p "  Name for device $i (e.g. myphone, laptop, tablet): " PROFILE_NAME
      PROFILE_NAME=$(echo "$PROFILE_NAME" | tr -cd '[:alnum:]-_')
      if [[ -n "$PROFILE_NAME" ]]; then
        VPN_PROFILES+=("$PROFILE_NAME")
      else
        err "  Invalid name — skipping"
      fi
    done
  fi

  # ── Health monitoring ──
  echo ""
  read -p "Enable auto health monitoring? (restarts crashed services) [yes]: " ENABLE_HEALTH
  ENABLE_HEALTH=$(echo "${ENABLE_HEALTH:-yes}" | tr '[:upper:]' '[:lower:]')
  [[ "$ENABLE_HEALTH" == "y" ]] && ENABLE_HEALTH="yes"

  # ── Headless mode ──
  echo ""
  read -p "Disable desktop GUI for headless operation? (saves RAM) [yes]: " DISABLE_GUI
  DISABLE_GUI=$(echo "${DISABLE_GUI:-yes}" | tr '[:upper:]' '[:lower:]')
  [[ "$DISABLE_GUI" == "y" ]] && DISABLE_GUI="yes"

  # ── UPnP auto port forward ──
  echo ""
  echo -e "${BLUE}  The script can try to auto-forward port 51820 on your router"
  echo -e "  using UPnP. This saves you from logging into your router manually.${NC}"
  read -p "Try automatic router port forwarding (UPnP)? [yes]: " ENABLE_UPNP
  ENABLE_UPNP=$(echo "${ENABLE_UPNP:-yes}" | tr '[:upper:]' '[:lower:]')
  [[ "$ENABLE_UPNP" == "y" ]] && ENABLE_UPNP="yes"
fi

STEP=0
TOTAL_STEPS=9
step() { STEP=$((STEP+1)); hdr "[$STEP/$TOTAL_STEPS] $1"; }

echo ""
info "Starting setup. This will take several minutes..."

# ---------------------------------------------------------------
# Pre-flight: disk space check
# ---------------------------------------------------------------
hdr "Pre-flight checks"
ROOT_FREE_KB=$(df -k / 2>/dev/null | awk 'NR==2{print $4}')
ROOT_FREE_GB=$(echo "scale=1; ${ROOT_FREE_KB:-0} / 1048576" | bc 2>/dev/null || echo "?")
if [[ -n "$ROOT_FREE_KB" && "$ROOT_FREE_KB" -lt 3145728 ]]; then
  err "Low disk space: only ${ROOT_FREE_GB}GB free on /. Need at least 3GB for Docker + updates."
  if [[ "${HEADLESS:-0}" == "1" ]]; then
    err "Continuing anyway (headless mode)..."
  else
    err "Free up space before continuing or the installation may fail mid-way."
    read -p "Continue anyway? (yes/no): " CONTINUE_LOW
    CONTINUE_LOW=$(echo "$CONTINUE_LOW" | tr '[:upper:]' '[:lower:]')
    [[ "$CONTINUE_LOW" != "yes" && "$CONTINUE_LOW" != "y" ]] && die "Aborted. Free up disk space and re-run."
  fi
else
  ok "Disk space OK — ${ROOT_FREE_GB}GB free on /"
fi

# ---------------------------------------------------------------
# STEP 1/9 — Install prerequisites (including curl)
# ---------------------------------------------------------------
step "Installing prerequisites"
# Skip if all prerequisites are already present (saves time on re-runs)
PREREQS_MISSING=false
for cmd in curl wget bc; do
  command -v "$cmd" &>/dev/null || { PREREQS_MISSING=true; break; }
done
dpkg -s ntfs-3g &>/dev/null || PREREQS_MISSING=true

if $PREREQS_MISSING; then
  apt-get update || die "apt-get update failed. Check your internet connection and try again."
  apt-get install -y curl wget gnupg2 ca-certificates ntfs-3g bc \
    || die "Failed to install prerequisites. Check the errors above."
  ok "Prerequisites installed"
else
  ok "Prerequisites already installed — skipping"
fi

# ---------------------------------------------------------------
# STEP 2/9 — System update
# ---------------------------------------------------------------
step "Updating system"
info "Running apt upgrade (this may take a few minutes)..."
apt-get upgrade -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  || err "apt-get upgrade had warnings — continuing, but check the log if issues arise"
ok "System updated"

# ---------------------------------------------------------------
# STEP 3/9 — Enable SSH
# ---------------------------------------------------------------
step "Setting up SSH"
# Service name is 'ssh' on Ubuntu, 'sshd' on some other distros
SSH_SVC="ssh"
systemctl list-unit-files --type=service 2>/dev/null | grep -q "^sshd" && SSH_SVC="sshd"

if systemctl is-active --quiet "$SSH_SVC" 2>/dev/null; then
  ok "SSH already running — skipping"
else
  apt-get install -y openssh-server \
    || die "Failed to install openssh-server. Check the errors above."
  systemctl enable "$SSH_SVC" || err "Could not enable SSH on boot"
  systemctl start  "$SSH_SVC" || err "Could not start SSH service"
  ok "SSH enabled — connect via: ssh $REAL_USER@<this-device-ip>"
fi

# ---------------------------------------------------------------
# STEP 4/9 — External drive setup
# ---------------------------------------------------------------
step "Setting up storage"

SKIP_DRIVE=false

if [[ -n "$DRIVE_PART" ]]; then
  DRIVE_PATH="/dev/$DRIVE_PART"
  info "Inspecting $DRIVE_PATH..."

  FS_TYPE=$(blkid -s TYPE -o value "$DRIVE_PATH" 2>/dev/null || true)
  info "Detected filesystem: ${FS_TYPE:-none}"

  # Offer to format if unformatted
  if [[ -z "$FS_TYPE" ]]; then
    echo ""
    echo -e "${RED}WARNING: Drive appears unformatted. Formatting will ERASE ALL DATA on it.${NC}"
    if [[ "${HEADLESS:-0}" == "1" ]]; then
      FORMAT_DRIVE="${FORMAT_DRIVE:-no}"
      info "Headless mode: FORMAT_DRIVE=$FORMAT_DRIVE"
    else
      read -p "Format /dev/$DRIVE_PART as ext4? (yes/no): " FORMAT_DRIVE
      FORMAT_DRIVE=$(echo "$FORMAT_DRIVE" | tr '[:upper:]' '[:lower:]')
    fi
    if [[ "$FORMAT_DRIVE" == "yes" || "$FORMAT_DRIVE" == "y" ]]; then
      info "Formatting drive as ext4..."
      if mkfs.ext4 -F "$DRIVE_PATH"; then
        FS_TYPE="ext4"
        ok "Drive formatted"
      else
        err "mkfs.ext4 failed — drive may be locked or have hardware errors."
        SKIP_DRIVE=true
        MOUNT_POINT="$REAL_HOME/.stremio-data"
        mkdir -p "$MOUNT_POINT"
      fi
    else
      err "Drive skipped — Stremio will cache locally instead."
      SKIP_DRIVE=true
      MOUNT_POINT="$REAL_HOME/.stremio-data"
      mkdir -p "$MOUNT_POINT"
    fi
  fi

  if ! $SKIP_DRIVE; then
    # Pick correct fstab filesystem type
    case "$FS_TYPE" in
      ext4)   FSTAB_TYPE="ext4" ;;
      ntfs*)  FSTAB_TYPE="ntfs-3g" ;;
      vfat)   FSTAB_TYPE="vfat" ;;
      exfat)  FSTAB_TYPE="exfat"
              apt-get install -y exfatprogs 2>/dev/null \
                || apt-get install -y exfat-utils 2>/dev/null || true ;;
      *)      info "Unknown filesystem '$FS_TYPE' — using auto"
              FSTAB_TYPE="auto" ;;
    esac

    # Unmount if already mounted elsewhere
    ALREADY_MOUNTED=$(findmnt -n -o TARGET "$DRIVE_PATH" 2>/dev/null || true)
    if [[ -n "$ALREADY_MOUNTED" ]]; then
      info "Drive already at $ALREADY_MOUNTED — unmounting to remount at $MOUNT_POINT"
      umount "$DRIVE_PATH" || true
    fi

    mkdir -p "$MOUNT_POINT"

    # Get UUID — retry once after a fresh format
    DRIVE_UUID=$(blkid -s UUID -o value "$DRIVE_PATH" 2>/dev/null || true)
    if [[ -z "$DRIVE_UUID" ]]; then
      info "UUID not found — retrying in 2 seconds..."
      sleep 2
      DRIVE_UUID=$(blkid -s UUID -o value "$DRIVE_PATH" 2>/dev/null || true)
    fi

    if [[ -z "$DRIVE_UUID" ]]; then
      err "Could not read UUID from $DRIVE_PATH — falling back to local storage."
      MOUNT_POINT="$REAL_HOME/.stremio-data"
      mkdir -p "$MOUNT_POINT"
    else
      # Add to fstab if not already there
      if ! grep -q "$DRIVE_UUID" /etc/fstab; then
        FSTAB_BAK="/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
        if cp /etc/fstab "$FSTAB_BAK"; then
          ok "fstab backed up to $FSTAB_BAK"
        else
          err "Could not back up fstab — skipping drive auto-mount to protect system."
          MOUNT_POINT="$REAL_HOME/.stremio-data"
          mkdir -p "$MOUNT_POINT"
          SKIP_DRIVE=true
        fi
        if ! $SKIP_DRIVE; then
          echo "UUID=$DRIVE_UUID  $MOUNT_POINT  $FSTAB_TYPE  defaults,nofail  0  2" >> /etc/fstab
          ok "Drive added to /etc/fstab (auto-mounts on boot)"
        fi
      else
        ok "Drive already in /etc/fstab"
      fi

      # Mount via mount point — lets the kernel use the UUID-based fstab
      # entry rather than the device path, which can drift between reboots
      if mount "$MOUNT_POINT" 2>/dev/null; then
        ok "Drive mounted at $MOUNT_POINT"
      else
        err "Mount failed — possible filesystem errors. Try: sudo fsck $DRIVE_PATH"
        MOUNT_POINT="$REAL_HOME/.stremio-data"
        mkdir -p "$MOUNT_POINT"
        info "Falling back to local storage at $MOUNT_POINT"
      fi
    fi
  fi

else
  mkdir -p "$MOUNT_POINT"
  info "No external drive — Stremio will cache to $MOUNT_POINT"
fi


# ---------------------------------------------------------------
# STEP 5/9 — Install Docker
# ---------------------------------------------------------------
step "Installing Docker"

if command -v docker &>/dev/null; then
  ok "Docker already installed — skipping"
else
  info "Downloading Docker install script..."
  DOCKER_SCRIPT=$(mktemp /tmp/docker-install-XXXXXX.sh) || die "Failed to create temp file"
  TEMP_FILES+=("$DOCKER_SCRIPT")
  if ! curl -fsSL https://get.docker.com -o "$DOCKER_SCRIPT"; then
    die "Failed to download Docker install script. Check your internet connection."
  fi
  if [[ ! -s "$DOCKER_SCRIPT" ]]; then
    die "Docker install script downloaded but is empty. Try again."
  fi
  info "Running Docker install script..."
  sh "$DOCKER_SCRIPT" || die "Docker installation failed. Check the errors above."
  systemctl enable docker || err "Could not enable Docker on boot — you may need to start it manually after reboot"
  systemctl start docker  || die "Docker service failed to start. Check: sudo systemctl status docker"

  # Wait for Docker socket to be ready (up to 20 seconds)
  info "Waiting for Docker daemon..."
  DOCKER_READY=false
  for i in {1..10}; do
    if docker info &>/dev/null; then
      DOCKER_READY=true
      break
    fi
    sleep 2
  done
  if ! $DOCKER_READY; then
    die "Docker daemon failed to start. Try: sudo systemctl status docker"
  fi

  usermod -aG docker "$REAL_USER"
  ok "Docker installed"
fi

# Ensure daemon is running even if Docker was pre-installed
systemctl start docker 2>/dev/null || true

# Verify Docker is actually responding before continuing
if ! docker info &>/dev/null; then
  die "Docker is installed but not responding. Try: sudo systemctl status docker"
fi

# ---------------------------------------------------------------
# STEP 6/9 — Firewall rules
# ---------------------------------------------------------------
step "Configuring firewall"
if command -v ufw &>/dev/null; then
  UFW_STATUS=$(ufw status 2>/dev/null | head -1)
  if echo "$UFW_STATUS" | grep -qi "active"; then
    info "UFW is active — adding port rules..."
    ufw allow 51820/udp  comment 'WireGuard VPN'  || true
    ufw allow 22/tcp     comment 'SSH'             || true
    # Stremio on 11470 is intentionally NOT opened to internet
    # — access via WireGuard VPN only
    ok "Firewall rules added (51820/UDP WireGuard, 22/TCP SSH)"
    info "Note: Stremio port 11470 is NOT opened to internet — access via VPN only"
  else
    info "UFW is inactive — skipping firewall rules"
  fi
else
  info "UFW not found — skipping firewall rules"
fi


# ---------------------------------------------------------------
# STEP 7/9 — Run Stremio Server
# ---------------------------------------------------------------
step "Starting Stremio Server"

# Check if already running and healthy BEFORE touching anything
# Detect LAN IP early so the health check uses the right address
STREMIO_BIND_IP=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
STREMIO_BIND_IP=${STREMIO_BIND_IP:-0.0.0.0}
# Validate IP format to prevent injection
if ! [[ "$STREMIO_BIND_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  err "Invalid bind IP '$STREMIO_BIND_IP' — falling back to 0.0.0.0"
  STREMIO_BIND_IP="0.0.0.0"
fi
STREMIO_ALREADY_OK=false
if docker ps --filter "name=stremio-server" --filter "status=running" \
   --format '{{.Names}}' 2>/dev/null | grep -q "stremio-server"; then
  if curl -s --max-time 3 "http://${STREMIO_BIND_IP}:11470/" &>/dev/null; then
    ok "Stremio Server already running and healthy — skipping restart"
    STREMIO_ALREADY_OK=true
  fi
fi

if [[ "$STREMIO_ALREADY_OK" != "true" ]]; then
  docker stop stremio-server 2>/dev/null || true
  docker rm   stremio-server 2>/dev/null || true

  info "Pulling Stremio Server image (ARM64)..."
  docker pull --platform linux/arm64 stremio/server:latest \
    || die "Failed to pull Stremio image. Check internet and that Docker is running."

  # STREMIO_BIND_IP was detected above (before the health check).
  # Bind to LAN IP only — not 0.0.0.0 (exposes to everyone) and not
  # 127.0.0.1 (blocks VPN clients). LAN binding lets WireGuard VPN
  # clients reach Stremio while UFW keeps port 11470 off the internet.
  if [[ "$STREMIO_BIND_IP" == "0.0.0.0" ]]; then
    info "Could not detect LAN IP — binding Stremio to all interfaces as fallback"
  else
    info "Binding Stremio to LAN IP $STREMIO_BIND_IP"
  fi

  info "Starting Stremio container..."
  docker run -d \
    --name stremio-server \
    --restart unless-stopped \
    --platform linux/arm64 \
    -p "${STREMIO_BIND_IP}:11470:11470" \
    -p "${STREMIO_BIND_IP}:12470:12470" \
    -e NO_CORS=1 \
    -v "$MOUNT_POINT:/root/.stremio-server" \
    stremio/server:latest \
    || die "Failed to start Stremio container. Run: docker logs stremio-server"

  # Wait for Stremio to actually respond on port 11470
  # Use the bind IP for the health check (localhost won't work if bound to LAN IP)
  info "Waiting for Stremio to respond..."
  STREMIO_OK=false
  for i in {1..15}; do
    if curl -s --max-time 3 "http://${STREMIO_BIND_IP}:11470/" &>/dev/null; then
      STREMIO_OK=true
      break
    fi
    sleep 2
  done

  if $STREMIO_OK; then
    ok "Stremio Server is live on port 11470"
  else
    err "Stremio didn't respond in time. Check: docker logs stremio-server"
  fi
fi

# ---------------------------------------------------------------
# STEP 7b — Alabtross Mobile UI
# ---------------------------------------------------------------
step "Setting up Alabtross Mobile UI"

MOBILE_UI_DIR="$(cd "$(dirname "$0")" && pwd)/mobile-ui"
MOBILE_ALREADY_OK=false

if docker ps --filter "name=alabtross-mobile" --filter "status=running" \
   --format '{{.Names}}' 2>/dev/null | grep -q "alabtross-mobile"; then
  if curl -s --max-time 3 "http://${STREMIO_BIND_IP}:8080/" &>/dev/null; then
    ok "Alabtross Mobile UI already running — skipping"
    MOBILE_ALREADY_OK=true
  fi
fi

if [[ "$MOBILE_ALREADY_OK" != "true" ]]; then
  if [[ -d "$MOBILE_UI_DIR" ]]; then
    docker stop alabtross-mobile 2>/dev/null || true
    docker rm   alabtross-mobile 2>/dev/null || true

    info "Building Alabtross Mobile UI container..."
    docker build -t alabtross-mobile "$MOBILE_UI_DIR" \
      || die "Failed to build Mobile UI. Check: ls $MOBILE_UI_DIR"

    # Create library directory on host for persistent movie storage
    LIBRARY_HOST_DIR="${MOUNT_POINT:-$HOME/.stremio-data}/alabtross-library"
    mkdir -p "$LIBRARY_HOST_DIR"

    info "Starting Alabtross Mobile UI..."
    docker run -d \
      --name alabtross-mobile \
      --restart unless-stopped \
      -p "${STREMIO_BIND_IP}:8080:8080" \
      -e STREMIO_SERVER="http://${STREMIO_BIND_IP}:11470" \
      -e LIBRARY_PATH="/app/library" \
      -v "${LIBRARY_HOST_DIR}:/app/library" \
      alabtross-mobile \
      || die "Failed to start Mobile UI container."

    ok "Alabtross Mobile UI is live on port 8080"
  else
    err "Mobile UI directory not found at $MOBILE_UI_DIR — skipping"
  fi
fi

# Allow port 8080 through firewall (same LAN-only binding as Stremio)
ufw allow 8080/tcp comment "Alabtross Mobile UI" 2>/dev/null || true


# ---------------------------------------------------------------
# STEP 8/9 — WireGuard via PiVPN
# ---------------------------------------------------------------
step "Installing WireGuard VPN"

if command -v pivpn &>/dev/null; then
  ok "PiVPN already installed — skipping wizard"
else
  PIVPN_SCRIPT=$(mktemp /tmp/pivpn-install-XXXXXX.sh) || die "Failed to create temp file"
  TEMP_FILES+=("$PIVPN_SCRIPT")

  if [[ "${HEADLESS:-0}" == "1" ]]; then
    # ── Headless: generate PiVPN config and run unattended ──
    info "Setting up PiVPN in unattended mode..."

    # Determine public-facing address
    if [[ "$HAS_DUCKDNS" == "yes" && -n "$DUCKDNS_DOMAIN" ]]; then
      PIVPN_HOST="${DUCKDNS_DOMAIN}.duckdns.org"
      PIVPN_HOST_TYPE="DNS"
    else
      PIVPN_HOST=$(curl -s https://api.ipify.org || curl -s https://ifconfig.me || echo "")
      PIVPN_HOST_TYPE="IP"
      if [[ -z "$PIVPN_HOST" ]]; then
        err "Could not detect public IP — PiVPN may need reconfiguration"
        PIVPN_HOST="0.0.0.0"
      fi
    fi

    # Write PiVPN unattended setup config
    PIVPN_CONF=$(mktemp /tmp/pivpn-unattended-XXXXXX.conf) || die "Failed to create temp file"
    chmod 600 "$PIVPN_CONF"
    TEMP_FILES+=("$PIVPN_CONF")
    cat > "$PIVPN_CONF" << PIVPNEOF
USING_DASHBOARD=0
IPv4dev=$(ip route get 8.8.8.8 | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')
install_user=${REAL_USER}
install_home=${REAL_HOME}
VPN=wireguard
pivpnNET=10.6.0.0
subnetClass=24
ALLOWED_IPS="0.0.0.0/0,::0/0"
pivpnMTU=1420
pivpnPORT=51820
pivpnDNS1=1.1.1.1
pivpnDNS2=1.0.0.1
pivpnHOST=${PIVPN_HOST}
pivpnPERSISTENTKEEPALIVE=25
UNATTUPG=1
PIVPNEOF

    info "Downloading PiVPN installer..."
    if ! curl -fsSL https://install.pivpn.io -o "$PIVPN_SCRIPT"; then
      err "Failed to download PiVPN installer."
      PIVPN_EXIT=1
    elif [[ ! -s "$PIVPN_SCRIPT" ]]; then
      err "PiVPN installer is empty."
      PIVPN_EXIT=1
    else
      bash "$PIVPN_SCRIPT" --unattended "$PIVPN_CONF"
      PIVPN_EXIT=$?
    fi

  else
    # ── Interactive: show instructions and launch wizard ──
    echo ""
    echo "---------------------------------------------"
    echo "  PiVPN setup wizard is about to launch."
    echo ""
    echo "  Choose these options when asked:"
    echo "  - VPN type :  WireGuard"
    echo "  - Port     :  51820  (press Enter for default)"
    echo "  - DNS      :  1.1.1.1  (Cloudflare)"
    if [[ "$HAS_DUCKDNS" == "yes" && -n "$DUCKDNS_DOMAIN" ]]; then
    echo "  - Public   :  ${DUCKDNS_DOMAIN}.duckdns.org"
    else
    echo "  - Public   :  your current public IP"
    fi
    echo ""
    echo "  NOTE: PiVPN may ask to REBOOT at the end."
    echo "  If it reboots, run this script again —"
    echo "  already-completed steps will be skipped."
    echo "---------------------------------------------"
    echo ""
    read -p "Press ENTER to launch PiVPN..."

    info "Downloading PiVPN installer..."
    if ! curl -fsSL https://install.pivpn.io -o "$PIVPN_SCRIPT"; then
      err "Failed to download PiVPN installer. Check your internet connection."
      PIVPN_EXIT=1
    elif [[ ! -s "$PIVPN_SCRIPT" ]]; then
      err "PiVPN installer downloaded but is empty. Try again later."
      PIVPN_EXIT=1
    else
      bash "$PIVPN_SCRIPT"
      PIVPN_EXIT=$?
    fi
  fi

  if [[ $PIVPN_EXIT -eq 0 ]]; then
    ok "WireGuard installed"
  else
    err "PiVPN exited with code $PIVPN_EXIT — it may have requested a reboot."
    err "If rebooted, re-run this script to finish the remaining steps."
  fi
fi

# ---------------------------------------------------------------
# STEP 9/9 — DuckDNS
# ---------------------------------------------------------------
step "Setting up DuckDNS"

if [[ "$HAS_DUCKDNS" == "yes" && -n "$DUCKDNS_DOMAIN" ]]; then
  DUCKDNS_DIR="/opt/duckdns"
  DUCKDNS_LOG="$REAL_HOME/.duckdns.log"
  mkdir -p "$DUCKDNS_DIR"
  # Pre-create log file with restricted permissions before writing
  touch "$DUCKDNS_LOG"
  chmod 600 "$DUCKDNS_LOG"
  chown "$REAL_USER:$REAL_USER" "$DUCKDNS_LOG"

  # Write the update script — uses a temp config file for curl so the token
  # never appears in process arguments (ps/top can't see it)
  (
    cat > "$DUCKDNS_DIR/duck.sh" << DUCKEOF
#!/bin/bash
CONF=\$(mktemp /tmp/duckdns-XXXXXX.conf)
chmod 600 "\$CONF"
printf 'url=https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=\n' > "\$CONF"
curl -s -o "${DUCKDNS_LOG}" -K "\$CONF"
rm -f "\$CONF"
DUCKEOF
  ) >/dev/null 2>&1

  # Restrict permissions — token is embedded, must not be world-readable
  chmod 700 "$DUCKDNS_DIR"
  chmod 700 "$DUCKDNS_DIR/duck.sh"
  chown -R "$REAL_USER:$REAL_USER" "$DUCKDNS_DIR"

  # Add to REAL user's crontab (not root's)
  # Log errors to DUCKDNS_LOG instead of swallowing them with /dev/null
  CRON_JOB="*/5 * * * * ${DUCKDNS_DIR}/duck.sh >> ${DUCKDNS_LOG} 2>&1"
  ( crontab -u "$REAL_USER" -l 2>/dev/null | grep -v "duck.sh"; echo "$CRON_JOB" ) \
    | crontab -u "$REAL_USER" -

  # Test it — run as real user so file permissions are correct
  info "Testing DuckDNS update..."
  sudo -u "$REAL_USER" bash "$DUCKDNS_DIR/duck.sh" || true
  DUCK_RESULT=$(cat "$DUCKDNS_LOG" 2>/dev/null | tr -d '[:space:]' || true)
  if echo "$DUCK_RESULT" | grep -q "^OK"; then
    ok "DuckDNS live — ${DUCKDNS_DOMAIN}.duckdns.org is active"
  else
    err "DuckDNS returned: '$DUCK_RESULT' — check your token and domain"
  fi
else
  info "Skipping DuckDNS"
fi

# Clear sensitive token from shell memory
unset DUCKDNS_TOKEN
unset DUCKDNS_AUTH_TOKEN

# ---------------------------------------------------------------
# UPnP auto port forwarding (skips need for router admin page)
# ---------------------------------------------------------------
LOCAL_IP=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
LOCAL_IP=${LOCAL_IP:-$(hostname -I | awk '{print $1}')}

UPNP_OK=false
if [[ "${ENABLE_UPNP:-no}" == "yes" ]]; then
  hdr "UPnP Port Forwarding"
  # Install miniupnpc if not present
  if ! command -v upnpc &>/dev/null; then
    info "Installing UPnP client..."
    apt-get install -y miniupnpc 2>/dev/null || true
  fi

  if command -v upnpc &>/dev/null; then
    info "Attempting to forward port 51820 UDP via UPnP..."
    # Remove old mapping first (ignore errors)
    upnpc -d 51820 UDP 2>/dev/null || true
    # Add new mapping: external 51820 → internal 51820 on this IP
    if upnpc -e "Alabtross WireGuard VPN" -a "$LOCAL_IP" 51820 51820 UDP 0 2>/dev/null; then
      ok "Port 51820 UDP forwarded via UPnP — no router config needed!"
      UPNP_OK=true
    else
      err "UPnP port forward failed — your router may not support UPnP"
      info "You'll need to forward port 51820 UDP manually in your router settings"
    fi

    # Also try to verify it worked
    if $UPNP_OK; then
      EXT_IP=$(upnpc -s 2>/dev/null | grep "ExternalIPAddress" | awk '{print $NF}' || echo "")
      if [[ -n "$EXT_IP" ]]; then
        ok "Your external IP: $EXT_IP"
      fi
    fi
  else
    err "Could not install miniupnpc — manual router port forward required"
  fi
fi

# ---------------------------------------------------------------
# Create VPN client profiles
# ---------------------------------------------------------------
if command -v pivpn &>/dev/null && [[ ${#VPN_PROFILES[@]} -gt 0 ]]; then
  hdr "Creating VPN Profiles"
  CREATED_PROFILES=()
  for PROFILE in "${VPN_PROFILES[@]}"; do
    PROFILE=$(echo "$PROFILE" | tr -cd '[:alnum:]-_')
    [[ -z "$PROFILE" ]] && continue

    # Check if profile already exists
    if pivpn list 2>/dev/null | grep -q "$PROFILE"; then
      ok "Profile '$PROFILE' already exists — skipping"
      CREATED_PROFILES+=("$PROFILE")
      continue
    fi

    info "Creating VPN profile: $PROFILE"
    # pivpn add creates the profile non-interactively with -n flag
    if pivpn add -n "$PROFILE" 2>/dev/null; then
      ok "Created profile: $PROFILE"
      CREATED_PROFILES+=("$PROFILE")
    else
      # Fallback: try without -n flag using expect-style input
      echo "$PROFILE" | pivpn add 2>/dev/null && {
        ok "Created profile: $PROFILE"
        CREATED_PROFILES+=("$PROFILE")
      } || err "Failed to create profile: $PROFILE"
    fi
  done

  # Show QR codes for created profiles
  if [[ ${#CREATED_PROFILES[@]} -gt 0 ]]; then
    echo ""
    echo -e "${GREEN}  ---- VPN QR CODES ----${NC}"
    echo "  Scan these with the WireGuard app on your phone/tablet"
    echo ""
    for PROFILE in "${CREATED_PROFILES[@]}"; do
      echo -e "${BLUE}  ── $PROFILE ──${NC}"
      pivpn -qr "$PROFILE" 2>/dev/null || info "QR code not available for $PROFILE — use: pivpn -qr $PROFILE"
      echo ""
    done
  fi
fi

# ---------------------------------------------------------------
# Health monitoring — auto-restart crashed services
# ---------------------------------------------------------------
if [[ "${ENABLE_HEALTH:-no}" == "yes" ]]; then
  hdr "Health Monitoring"
  HEALTH_SCRIPT="/opt/alabtross/health-check.sh"
  mkdir -p /opt/alabtross

  cat > "$HEALTH_SCRIPT" << 'HEALTHEOF'
#!/bin/bash
# Alabtross health check — restarts containers if they crash
LOG="/var/log/alabtross-health.log"

check_container() {
  local name=$1
  if ! docker ps --filter "name=$name" --filter "status=running" \
       --format '{{.Names}}' 2>/dev/null | grep -q "$name"; then
    echo "$(date) [WARN] $name is down — restarting" >> "$LOG"
    docker restart "$name" 2>/dev/null || docker start "$name" 2>/dev/null
    if docker ps --filter "name=$name" --filter "status=running" \
         --format '{{.Names}}' 2>/dev/null | grep -q "$name"; then
      echo "$(date) [OK] $name restarted successfully" >> "$LOG"
    else
      echo "$(date) [ERROR] $name failed to restart" >> "$LOG"
    fi
  fi
}

check_container "stremio-server"
check_container "alabtross-mobile"

# Trim log if over 1MB
if [[ -f "$LOG" ]] && [[ $(stat -c%s "$LOG" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  tail -100 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
HEALTHEOF

  chmod 755 "$HEALTH_SCRIPT"

  # Add to root crontab — runs every 5 minutes
  HEALTH_CRON="*/5 * * * * $HEALTH_SCRIPT"
  ( crontab -l 2>/dev/null | grep -v "health-check.sh"; echo "$HEALTH_CRON" ) | crontab -

  ok "Health monitoring enabled — checks every 5 minutes"
  info "Log: /var/log/alabtross-health.log"
fi

# ---------------------------------------------------------------
# Disable desktop GUI for headless operation
# ---------------------------------------------------------------
if [[ "${DISABLE_GUI:-no}" == "yes" ]]; then
  if systemctl get-default 2>/dev/null | grep -q "graphical"; then
    info "Disabling desktop GUI for headless operation..."
    systemctl set-default multi-user.target
    ok "Desktop GUI disabled — system will boot to console only"
    info "To re-enable later: sudo systemctl set-default graphical.target"
  fi
fi

# ---------------------------------------------------------------
# DONE — Summary
# ---------------------------------------------------------------
# Determine storage label for summary
if [[ -n "$DRIVE_PART" ]] && mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  STORAGE_SIZE=$(df -h "$MOUNT_POINT" 2>/dev/null | awk 'NR==2{print $2}' || echo "?")
  STORAGE_LABEL="External drive ($STORAGE_SIZE) → $MOUNT_POINT"
else
  STORAGE_LABEL="Local fallback → $MOUNT_POINT"
fi

echo ""
echo "=============================================="
echo -e "${GREEN}  SETUP COMPLETE!${NC}"
echo "=============================================="
echo ""
echo "  Local IP:        $LOCAL_IP"
echo "  Stremio Server:  http://$LOCAL_IP:11470"
echo "  Mobile UI:       http://$LOCAL_IP:8080"
echo "  Storage:         $STORAGE_LABEL"
echo "  WireGuard VPN:   port 51820 UDP"
if [[ "$HAS_DUCKDNS" == "yes" && -n "$DUCKDNS_DOMAIN" ]]; then
  echo "  DuckDNS:         ${DUCKDNS_DOMAIN}.duckdns.org"
fi
if $UPNP_OK; then
  echo -e "  Port Forward:    ${GREEN}Auto-configured via UPnP${NC}"
else
  echo -e "  Port Forward:    ${YELLOW}Manual — forward 51820 UDP on your router${NC}"
fi
if [[ "${ENABLE_HEALTH:-no}" == "yes" ]]; then
  echo -e "  Health Monitor:  ${GREEN}Active (every 5 min)${NC}"
fi
echo ""

# Show next steps — adjusted based on what's already done
NEXT_STEP=1
echo "  ---- NEXT STEPS ----"
echo ""
if ! $UPNP_OK; then
  echo "  $NEXT_STEP. On your ROUTER: forward port 51820 UDP → $LOCAL_IP"
  echo ""
  NEXT_STEP=$((NEXT_STEP+1))
fi
if [[ ${#CREATED_PROFILES[@]:-0} -eq 0 ]]; then
  echo "  $NEXT_STEP. Add a VPN device profile:"
  echo "     pivpn add"
  echo ""
  NEXT_STEP=$((NEXT_STEP+1))
  echo "  $NEXT_STEP. Show QR code for WireGuard app:"
  echo "     pivpn -qr <profilename>"
  echo ""
  NEXT_STEP=$((NEXT_STEP+1))
fi
echo "  $NEXT_STEP. On your phone: connect WireGuard VPN, then open:"
echo "     http://$LOCAL_IP:8080"
echo "     Tip: Add to Home Screen for an app-like experience"
echo ""
NEXT_STEP=$((NEXT_STEP+1))
echo "  $NEXT_STEP. In the mobile UI Settings, verify server URL:"
echo "     http://$LOCAL_IP:11470"
echo "     Then add Torrentio addon for streams"
echo ""
echo "  ---- USEFUL COMMANDS ----"
echo ""
echo "  docker logs stremio-server     — view Stremio logs"
echo "  docker restart stremio-server  — restart Stremio"
echo "  docker stats stremio-server    — CPU/RAM usage"
echo "  pivpn -c                       — list VPN connections"
echo "  pivpn add                      — add new VPN client"
echo "  pivpn -qr <name>              — show QR code"
echo "  df -h \"$MOUNT_POINT\"           — check drive space"
echo "  cat $LOG_FILE                  — view setup log"
echo ""
echo -e "${YELLOW}  IMPORTANT: Log out and back in so Docker"
echo -e "  permissions apply to your account.${NC}"
echo "=============================================="

# Flush the log — the tee subprocess needs a moment to finish writing
sleep 1
wait
