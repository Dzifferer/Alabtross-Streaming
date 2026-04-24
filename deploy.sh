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

# Detect whether the Docker daemon has the NVIDIA container runtime wired
# up. Without it, --runtime=nvidia is a hard error on `docker run` and the
# container has no /dev/nvhost-* nodes even if ffmpeg was built with CUDA.
# jetson_setup.sh installs and configures the runtime on fresh Jetsons;
# this fallback keeps deploys working on hosts where that hasn't happened
# (e.g. upgrading an older install that predates this change).
NVIDIA_RUNTIME_ARGS=()
FFMPEG_HWACCEL_DEFAULT=""
if sudo docker info 2>/dev/null | grep -qi 'Runtimes:.*nvidia'; then
  NVIDIA_RUNTIME_ARGS=(--runtime=nvidia)
  # Jetson's libnvcuvid.so / libnvidia-encode.so live in /usr/lib/aarch64-linux-gnu/tegra
  # on the host. The NVIDIA container runtime is supposed to bind-mount them via the
  # CSV files in /etc/nvidia-container-runtime/host-files-for-container.d/, but the CSV
  # mode isn't always wired up after `nvidia-ctk runtime configure` alone — so we also
  # pass the tegra dir through explicitly. Harmless if the runtime already mounted it.
  if [[ -d /usr/lib/aarch64-linux-gnu/tegra ]]; then
    NVIDIA_RUNTIME_ARGS+=(-v /usr/lib/aarch64-linux-gnu/tegra:/usr/lib/aarch64-linux-gnu/tegra:ro)
  fi
  # On some JetPack installs there's also a tegra-egl dir used by NVENC via GL surfaces.
  if [[ -d /usr/lib/aarch64-linux-gnu/tegra-egl ]]; then
    NVIDIA_RUNTIME_ARGS+=(-v /usr/lib/aarch64-linux-gnu/tegra-egl:/usr/lib/aarch64-linux-gnu/tegra-egl:ro)
  fi

  # Only turn on ffmpeg's CUDA path if libnvcuvid.so is actually reachable.
  # JetPack 6 on Orin Nano ships *only* libnvcuvidv4l2.so (a V4L2 shim) and
  # NO libnvcuvid.so, so ffmpeg's hevc_cuvid / h264_cuvid decoders hard-fail
  # at runtime with "Cannot load libnvcuvid.so.1" and every transcode exits
  # 255. Probing here keeps that platform on a working CPU pipeline instead
  # of silently breaking the background conversion queue. Desktop NVIDIA
  # hosts and Orin NX / AGX Orin (which do ship libnvcuvid.so) still get
  # FFMPEG_HWACCEL=cuda on by default.
  CUVID_PATHS=(
    /usr/lib/aarch64-linux-gnu/tegra/libnvcuvid.so*
    /usr/lib/aarch64-linux-gnu/nvidia/libnvcuvid.so*
    /usr/local/cuda/targets/aarch64-linux/lib/libnvcuvid.so*
    /usr/lib/x86_64-linux-gnu/libnvcuvid.so*
  )
  CUVID_FOUND=""
  for p in "${CUVID_PATHS[@]}"; do
    if compgen -G "$p" >/dev/null 2>&1; then CUVID_FOUND="$p"; break; fi
  done
  if [[ -n "$CUVID_FOUND" ]]; then
    FFMPEG_HWACCEL_DEFAULT="cuda"
    echo "==> NVIDIA container runtime + libnvcuvid detected — GPU decode enabled"
  else
    FFMPEG_HWACCEL_DEFAULT=""
    echo "==> NVIDIA container runtime detected, but libnvcuvid.so not present"
    echo "         — JetPack 6 on Orin Nano ships only libnvcuvidv4l2.so, which"
    echo "           upstream ffmpeg's cuvid decoders don't speak."
    echo "         — falling back to libx264 CPU for decode+encode (safe default)."
    echo "         — hardware NVDEC on this platform needs a Jetson-patched ffmpeg"
    echo "           (h264_nvmpi / hevc_nvmpi via L4T Multimedia API); tracked as"
    echo "           a follow-up to the GPU-offload PR."
  fi
else
  echo "==> WARN: NVIDIA container runtime NOT configured on this Docker daemon"
  echo "         — transcodes will run on CPU (libx264). Run jetson_setup.sh to enable."
fi

echo "==> Starting container (bind IP: $BIND_IP)..."
# WORKER_URL / WORKER_SECRET pull through from .env when set — if blank,
# the library manager runs every conversion locally. Without a worker we
# rely on the Jetson's own NVDEC (and NVENC on Orin NX / AGX) to carry as
# much of the pipeline as the SoC supports. See mobile-ui/lib/ffmpeg-hw.js.
#
# FFMPEG_HWACCEL=cuda wires the Jetson's NVDEC + scale_cuda into every
# ffmpeg call. Defaults to 'cuda' when the NVIDIA runtime is present, empty
# otherwise.
#
# FFMPEG_ENCODER defaults to empty (= libx264 CPU encode) because the Orin
# Nano has no NVENC hardware. On an Orin NX / AGX Orin (or when you migrate
# to one), set FFMPEG_ENCODER=h264_nvenc in .env to move the encode side
# onto the GPU too.
sudo docker run -d \
  --name alabtross-mobile \
  "${NVIDIA_RUNTIME_ARGS[@]}" \
  --restart unless-stopped \
  --net=host \
  -e PORT=8080 \
  -e STREMIO_SERVER="http://${BIND_IP}:11470" \
  -e TORRENT_CACHE="/app/torrent-cache" \
  -e LIBRARY_PATH="/app/torrent-cache/library" \
  -e TMDB_API_KEY="${TMDB_API_KEY:?Set TMDB_API_KEY env var before deploying}" \
  -e WORKER_URL="${WORKER_URL:-}" \
  -e WORKER_SECRET="${WORKER_SECRET:-}" \
  -e FFMPEG_HWACCEL="${FFMPEG_HWACCEL:-$FFMPEG_HWACCEL_DEFAULT}" \
  -e FFMPEG_ENCODER="${FFMPEG_ENCODER:-}" \
  -v "/mnt/movies/torrent-cache:/app/torrent-cache" \
  alabtross-mobile

# Ensure Tailscale Serve is still active after container restart
if command -v tailscale &>/dev/null && tailscale status &>/dev/null; then
  tailscale serve --bg --https=443 http://localhost:8080 2>/dev/null || true
fi

echo "==> Done! Albatross is live at https://albatross (and http://localhost:8080)"
