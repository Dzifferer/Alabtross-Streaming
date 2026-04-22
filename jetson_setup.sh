#!/bin/bash

# ================================================================
#  JETSON ORIN NANO — STREMIO + TAILSCALE HOME SERVER SETUP
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
#      Tailscale VPN (no port forwarding needed, works behind CGNAT)
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
#  DuckDNS credentials) then run fully automatically.
#  It detects completed steps and skips them, so it's safe to re-run.
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
#    - If UFW is active, opens 22/TCP for SSH
#    - Stremio port 11470 is intentionally NOT opened — it is
#      only accessible through the Tailscale VPN tunnel
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
#  [8/9] Installing Tailscale VPN
#    - Installs Tailscale (no port forwarding needed, works behind CGNAT)
#    - Enables and starts the tailscaled service
#    - Prompts to authenticate (interactive mode)
#    - Install Tailscale on your phone/laptop and sign in with same account
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
#  1. Install Tailscale on your phone/laptop (https://tailscale.com/download)
#  2. Sign in with the same account used on the Jetson
#  3. Open http://<tailscale-ip>:8080 in a browser
#  4. Search for any movie and press play
#
#  No port forwarding or router setup needed — Tailscale handles it.
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
#    tailscale status               — check Tailscale VPN status
#    tailscale ip                   — show Tailscale IP
#    df -h /mnt/movies              — check external drive space
#    cat /var/log/jetson_setup.log  — review this setup log
#
#  TROUBLESHOOTING
#  ---------------
#  Stremio not responding:
#    docker logs stremio-server
#    docker restart stremio-server
#
#  Can't connect via Tailscale:
#    - Check Tailscale is running: sudo tailscale status
#    - Re-authenticate: sudo tailscale up
#    - Make sure both devices use the same Tailscale account
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
#   DUCKDNS_SUBDOMAIN=myalbatross    — DuckDNS subdomain (or empty to skip)
#   DUCKDNS_AUTH_TOKEN=xxx             — DuckDNS token
#   ENABLE_HEALTH=yes                  — auto-restart crashed services (default: yes)
#   DISABLE_GUI=yes                    — disable desktop for headless (default: yes)
#
# Example (fully headless over SSH):
#   sudo HEADLESS=1 DRIVE_PARTITION=sda1 \
#        DUCKDNS_SUBDOMAIN=myalbatross \
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

# TMDB_API_KEY is required for movie/show metadata — check early to avoid late failure
if [[ -z "${TMDB_API_KEY:-}" ]]; then
  echo ""
  echo "  TMDB_API_KEY is required for movie/TV metadata lookups."
  echo "  Get a free key at: https://www.themoviedb.org/settings/api"
  echo ""
  if [[ "${HEADLESS:-0}" == "1" ]]; then
    die "Set TMDB_API_KEY env var before running setup in headless mode."
  else
    read -rp "  Enter your TMDB API key: " TMDB_API_KEY
    [[ -z "$TMDB_API_KEY" ]] && die "TMDB_API_KEY is required. Exiting."
    export TMDB_API_KEY
    ok "TMDB API key set"
  fi
fi

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

  # Features default to yes in headless mode
  ENABLE_HEALTH="${ENABLE_HEALTH:-yes}"
  DISABLE_GUI="${DISABLE_GUI:-yes}"

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
    read -p  "Enter your DuckDNS subdomain (e.g. myalbatross): " DUCKDNS_DOMAIN
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

# Install yt-dlp (used by the Music tab as a non-torrent audio source). The
# Ubuntu-packaged yt-dlp lags months behind and frequently breaks against
# YouTube's API changes, so prefer the official standalone binary from GitHub.
# Idempotent: skips if already present and less than 30 days old.
if ! command -v yt-dlp &>/dev/null \
   || [ -z "$(find "$(command -v yt-dlp)" -mtime -30 2>/dev/null)" ]; then
  info "Installing / refreshing yt-dlp..."
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && ok "yt-dlp installed ($(yt-dlp --version 2>/dev/null || echo '?'))" \
    || err "yt-dlp install failed — Music tab's YouTube source will be unavailable"
else
  ok "yt-dlp already installed — skipping"
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
    ufw allow 22/tcp     comment 'SSH'             || true
    # Stremio on 11470 is intentionally NOT opened to internet
    # — access via Tailscale VPN only
    ok "Firewall rules added (22/TCP SSH)"
    info "Note: Stremio port 11470 is NOT opened to internet — access via Tailscale only"
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
  # 127.0.0.1 (blocks VPN clients). LAN binding lets Tailscale VPN
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
# STEP 7b — Albatross Mobile UI
# ---------------------------------------------------------------
step "Setting up Albatross Mobile UI"

MOBILE_UI_DIR="$(cd "$(dirname "$0")" && pwd)/mobile-ui"
MOBILE_ALREADY_OK=false

if docker ps --filter "name=alabtross-mobile" --filter "status=running" \
   --format '{{.Names}}' 2>/dev/null | grep -q "alabtross-mobile"; then
  if curl -s --max-time 3 "http://${STREMIO_BIND_IP}:8080/" &>/dev/null; then
    ok "Albatross Mobile UI already running — skipping"
    MOBILE_ALREADY_OK=true
  fi
fi

if [[ "$MOBILE_ALREADY_OK" != "true" ]]; then
  if [[ -d "$MOBILE_UI_DIR" ]]; then
    docker stop alabtross-mobile 2>/dev/null || true
    docker rm   alabtross-mobile 2>/dev/null || true

    info "Building Albatross Mobile UI container..."
    docker build -t alabtross-mobile "$MOBILE_UI_DIR" \
      || die "Failed to build Mobile UI. Check: ls $MOBILE_UI_DIR"

    # Create torrent cache and library directories on host for persistent storage
    TORRENT_CACHE_HOST_DIR="${MOUNT_POINT:-$HOME/.stremio-data}/torrent-cache"
    LIBRARY_HOST_DIR="${TORRENT_CACHE_HOST_DIR}/library"
    mkdir -p "$LIBRARY_HOST_DIR"

    info "Starting Albatross Mobile UI..."
    # --net=host is required for SSDP multicast (local device discovery for
    # casting over VPN). Port 8080 is exposed directly on the host.
    docker run -d \
      --name alabtross-mobile \
      --restart unless-stopped \
      --net=host \
      -e PORT=8080 \
      -e STREMIO_SERVER="http://${STREMIO_BIND_IP}:11470" \
      -e TORRENT_CACHE="/app/torrent-cache" \
      -e LIBRARY_PATH="/app/torrent-cache/library" \
      -e TMDB_API_KEY="${TMDB_API_KEY:?Set TMDB_API_KEY env var before running setup}" \
      -v "${TORRENT_CACHE_HOST_DIR}:/app/torrent-cache" \
      alabtross-mobile \
      || die "Failed to start Mobile UI container."

    ok "Albatross Mobile UI is live on port 8080"
  else
    err "Mobile UI directory not found at $MOBILE_UI_DIR — skipping"
  fi
fi

# Allow port 8080 through firewall (same LAN-only binding as Stremio)
ufw allow 8080/tcp comment "Albatross Mobile UI" 2>/dev/null || true

# Install systemd service for on-boot startup
SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_SRC="$SETUP_DIR/alabtross-mobile.service"
if [[ -f "$SERVICE_SRC" ]]; then
  cp "$SERVICE_SRC" /etc/systemd/system/alabtross-mobile.service
  systemctl daemon-reload
  systemctl enable alabtross-mobile.service
  ok "Albatross Mobile UI will start automatically on boot"
else
  info "Service file not found — on-boot startup not configured"
fi


# ---------------------------------------------------------------
# STEP 8/9 — Tailscale VPN
# ---------------------------------------------------------------
step "Installing Tailscale VPN"

if command -v tailscale &>/dev/null; then
  ok "Tailscale already installed"
  # Check if already connected
  if tailscale status &>/dev/null; then
    TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
    ok "Tailscale is connected — IP: ${TAILSCALE_IP:-unknown}"
  else
    info "Tailscale is installed but not connected."
    info "Run: sudo tailscale up"
  fi
else
  info "Installing Tailscale..."
  if curl -fsSL https://tailscale.com/install.sh | sh; then
    ok "Tailscale installed"

    info "Starting Tailscale..."
    systemctl enable tailscaled 2>/dev/null || true
    systemctl start tailscaled 2>/dev/null || true

    echo ""
    echo "---------------------------------------------"
    echo "  Tailscale needs to be authenticated."
    echo ""
    echo "  Run this command and follow the link:"
    echo ""
    echo "    sudo tailscale up"
    echo ""
    echo "  Then install Tailscale on your phone/laptop"
    echo "  and sign in with the same account."
    echo ""
    echo "  After setup completes, access Albatross at:"
    echo "    https://albatross  (short name, requires MagicDNS)"
    echo "    https://albatross.<your-tailnet>.ts.net  (full name)"
    echo "---------------------------------------------"
    echo ""

    if [[ "${HEADLESS:-0}" != "1" ]]; then
      read -p "Authenticate Tailscale now? (yes/no) [yes]: " TS_AUTH
      TS_AUTH=$(echo "${TS_AUTH:-yes}" | tr '[:upper:]' '[:lower:]')
      if [[ "$TS_AUTH" == "yes" || "$TS_AUTH" == "y" ]]; then
        tailscale up
        TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
        if [[ -n "$TAILSCALE_IP" ]]; then
          ok "Tailscale connected — IP: $TAILSCALE_IP"
        fi
      fi
    fi
  else
    err "Failed to install Tailscale. Install manually: https://tailscale.com/download"
  fi
fi

# ---------------------------------------------------------------
# STEP 8b — Tailscale Serve (HTTPS proxy)
# ---------------------------------------------------------------
step "Configuring Tailscale Serve (HTTPS access)"

if tailscale status &>/dev/null; then
  # Rename machine to "albatross" for clean MagicDNS URL
  info "Setting Tailscale hostname to 'albatross'..."
  tailscale set --hostname=albatross

  # Enable HTTPS proxy: tailscale serve proxies port 443 -> localhost:8080
  info "Enabling Tailscale Serve (HTTPS on port 443 → localhost:8080)..."
  tailscale serve --bg --https=443 http://localhost:8080

  # Get the full MagicDNS name
  TS_FQDN=$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')
  if [[ -n "$TS_FQDN" ]]; then
    ok "Tailscale Serve active — https://$TS_FQDN"
    ok "Short URL (MagicDNS):  https://albatross"
  else
    ok "Tailscale Serve configured — https://albatross"
  fi
else
  info "Tailscale not connected — skipping Tailscale Serve setup."
  info "After authenticating, run:"
  info "  sudo tailscale set --hostname=albatross"
  info "  sudo tailscale serve --bg --https=443 http://localhost:8080"
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
# Get local IP for summary
# ---------------------------------------------------------------
LOCAL_IP=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
LOCAL_IP=${LOCAL_IP:-$(hostname -I | awk '{print $1}')}

# ---------------------------------------------------------------
# Health monitoring — auto-restart crashed services
# ---------------------------------------------------------------
if [[ "${ENABLE_HEALTH:-no}" == "yes" ]]; then
  hdr "Health Monitoring"
  HEALTH_SCRIPT="/opt/alabtross/health-check.sh"
  mkdir -p /opt/alabtross

  cat > "$HEALTH_SCRIPT" << 'HEALTHEOF'
#!/bin/bash
# Albatross health check — restarts containers if they crash
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
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "not connected")
echo "  Local IP:        $LOCAL_IP"
echo "  Tailscale IP:    $TAILSCALE_IP"
echo "  Stremio Server:  http://$LOCAL_IP:11470"
echo "  Albatross:       https://albatross (via Tailscale Serve)"
echo "  Albatross (LAN): http://$LOCAL_IP:8080"
echo "  Storage:         $STORAGE_LABEL"
echo "  VPN:             Tailscale (no port forwarding needed)"
if [[ "$HAS_DUCKDNS" == "yes" && -n "$DUCKDNS_DOMAIN" ]]; then
  echo "  DuckDNS:         ${DUCKDNS_DOMAIN}.duckdns.org"
fi
if [[ "${ENABLE_HEALTH:-no}" == "yes" ]]; then
  echo -e "  Health Monitor:  ${GREEN}Active (every 5 min)${NC}"
fi
echo ""

# Show next steps
NEXT_STEP=1
echo "  ---- NEXT STEPS ----"
echo ""
if ! tailscale status &>/dev/null; then
  echo "  $NEXT_STEP. Authenticate Tailscale:"
  echo "     sudo tailscale up"
  echo ""
  NEXT_STEP=$((NEXT_STEP+1))
fi
echo "  $NEXT_STEP. Install Tailscale on your phone/laptop:"
echo "     https://tailscale.com/download"
echo "     Sign in with the same account"
echo ""
NEXT_STEP=$((NEXT_STEP+1))
echo "  $NEXT_STEP. Access Albatross from anywhere via Tailscale:"
echo "     https://albatross"
echo "     (or https://albatross.<your-tailnet>.ts.net)"
echo "     Tip: Add to Home Screen for an app-like experience"
echo ""
NEXT_STEP=$((NEXT_STEP+1))
echo "  $NEXT_STEP. On LAN, access directly (fallback):"
echo "     http://$LOCAL_IP:8080"
echo ""
echo "  ---- USEFUL COMMANDS ----"
echo ""
echo "  docker logs stremio-server     — view Stremio logs"
echo "  docker restart stremio-server  — restart Stremio"
echo "  docker stats stremio-server    — CPU/RAM usage"
echo "  tailscale status               — check Tailscale connection"
echo "  tailscale ip                   — show Tailscale IP"
echo "  tailscale serve status         — check HTTPS proxy status"
echo "  df -h \"$MOUNT_POINT\"           — check drive space"
echo "  cat $LOG_FILE                  — view setup log"
echo ""
echo -e "${YELLOW}  IMPORTANT: Log out and back in so Docker"
echo -e "  permissions apply to your account.${NC}"
echo "=============================================="

# Flush the log — the tee subprocess needs a moment to finish writing
sleep 1
wait
