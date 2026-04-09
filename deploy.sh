#!/usr/bin/env bash
# Quick deploy — pull latest from main and restart Albatross
#
# Usage: ./deploy.sh [--no-cache]
#   --no-cache   Force a clean Docker rebuild (also re-pulls the base image).
#                Use this when a base image or pinned dependency changed.
set -e

cd "$(dirname "$0")"

BUILD_FLAGS=""
if [[ "${1:-}" == "--no-cache" ]]; then
  BUILD_FLAGS="--no-cache --pull"
  echo "==> Clean rebuild requested (--no-cache --pull)"
fi

# Load secrets from .env file (not tracked in git)
if [ -f .env ]; then
  set -a
  . .env
  set +a
fi

if [ -z "$TMDB_API_KEY" ]; then
  echo "ERROR: TMDB_API_KEY not set. Add it to .env file:"
  echo '  echo "TMDB_API_KEY=your_key_here" > .env'
  exit 1
fi

echo "==> Checking repo access..."
if ! git ls-remote --exit-code origin &>/dev/null; then
  echo "ERROR: Cannot reach the remote repository."
  echo "This is a private repo — SSH key or PAT auth must be configured."
  echo "See README.md 'Private Repo Access' for setup instructions."
  exit 1
fi

echo "==> Pulling latest from main..."
git pull origin main

echo "==> Stopping container..."
sudo docker stop alabtross-mobile 2>/dev/null || true
sudo docker rm   alabtross-mobile 2>/dev/null || true

echo "==> Building..."
sudo docker build $BUILD_FLAGS -t alabtross-mobile ./mobile-ui

BIND_IP=$(ip route get 8.8.8.8 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')

# Ensure the torrent-cache host dir is owned by the container's UID (1001 — see
# mobile-ui/Dockerfile). Without this the node process gets EACCES when it tries
# to create /app/torrent-cache/library and the container crash-loops.
sudo mkdir -p /mnt/movies/torrent-cache/library
sudo chown -R 1001:1001 /mnt/movies/torrent-cache

echo "==> Starting container (bind IP: $BIND_IP)..."
sudo docker run -d \
  --name alabtross-mobile \
  --restart unless-stopped \
  --net=host \
  -e PORT=8080 \
  -e STREMIO_SERVER="http://${BIND_IP}:11470" \
  -e TORRENT_CACHE="/app/torrent-cache" \
  -e LIBRARY_PATH="/app/torrent-cache/library" \
  -e TMDB_API_KEY="${TMDB_API_KEY:?Set TMDB_API_KEY env var before deploying}" \
  -v "/mnt/movies/torrent-cache:/app/torrent-cache" \
  alabtross-mobile

# Ensure Tailscale Serve is still active after container restart
if command -v tailscale &>/dev/null && tailscale status &>/dev/null; then
  tailscale serve --bg --https=443 http://localhost:8080 2>/dev/null || true
fi

echo "==> Done! Albatross is live at https://albatross (and http://localhost:8080)"
