# syntax=docker/dockerfile:1.6
#
# Jetson-aware build.
#
# Multi-stage: compile libnvmpi against JetPack's L4T Multimedia API,
# apply Keylost's nvmpi patch to ffmpeg so it picks up h264_nvmpi /
# hevc_nvmpi / etc., then copy the resulting binaries onto a slim L4T
# runtime. End result: /usr/local/bin/ffmpeg talks to NVDEC on the SoC
# via libnvmpi → libnvv4l2 → kernel driver, and also keeps cuvid /
# scale_cuda / h264_nvenc available for desktop NVIDIA hosts and Orin
# NX / AGX Orin. lib/ffmpeg-hw.js picks the right path at runtime based
# on FFMPEG_HWACCEL.
#
# Why NVMPI instead of CUVID on Orin Nano: JetPack 6 on Orin Nano ships
# libnvv4l2.so (NVIDIA's V4L2 wrapper around the multimedia API) but
# NOT libnvcuvid.so. ffmpeg's cuvid decoders dlopen libnvcuvid.so.1
# and hard-fail with "Cannot load libnvcuvid.so.1" when it's absent.
# libnvmpi wraps the same hardware NVDEC block through the L4T API
# instead, so we get hardware decode on the Nano where cuvid can't.
#
# First build on Orin Nano: ~20-25 min (libnvmpi + ffmpeg compile).
# Subsequent rebuilds hit Docker layer cache and finish in seconds
# unless FFMPEG_VERSION / L4T_TAG change.
#
# Override knobs (all optional):
#   --build-arg L4T_TAG=r35.4.1                # JetPack 5.x host
#   --build-arg FFMPEG_VERSION=n6.1.1          # pin a different ffmpeg tag
#   --build-arg FFMPEG_PATCH_PATH=ffmpeg_patches/ffmpeg6.1_nvmpi.patch
#   --build-arg JETSON_FFMPEG_REPO=https://github.com/Keylost/jetson-ffmpeg.git
#   --build-arg JETSON_FFMPEG_REF=master
#   --build-arg NV_CODEC_HEADERS_TAG=n12.1.14.0

ARG L4T_TAG=r36.4.0
ARG FFMPEG_VERSION=n6.1.1
ARG FFMPEG_PATCH_PATH=ffmpeg_patches/ffmpeg6.1_nvmpi.patch
ARG JETSON_FFMPEG_REPO=https://github.com/Keylost/jetson-ffmpeg.git
ARG JETSON_FFMPEG_REF=master
ARG NV_CODEC_HEADERS_TAG=n12.1.14.0

# ──────────────────────────────────────────────────────────────────────────
# Stage 1 — build libnvmpi + patched ffmpeg
# ──────────────────────────────────────────────────────────────────────────
FROM nvcr.io/nvidia/l4t-jetpack:${L4T_TAG} AS ffmpeg-build

ARG FFMPEG_VERSION
ARG FFMPEG_PATCH_PATH
ARG JETSON_FFMPEG_REPO
ARG JETSON_FFMPEG_REF
ARG NV_CODEC_HEADERS_TAG
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates git pkg-config yasm nasm cmake \
      libx264-dev libx265-dev libvpx-dev libopus-dev libmp3lame-dev \
      libass-dev libfreetype6-dev libnuma-dev zlib1g-dev libv4l-dev \
 && rm -rf /var/lib/apt/lists/*

# The l4t-jetpack image has CUDA / cuDNN / TensorRT but NOT the L4T
# Multimedia API runtime libs (libnvbufsurface / libnvbufsurftransform /
# libnvjpeg — verified by listing /usr/lib/aarch64-linux-gnu/nvidia/).
# Those come from the nvidia-l4t-jetson-multimedia-api package in
# NVIDIA's apt repo, which the base image already configures but doesn't
# preinstall. Post-install scripts on nvidia-l4t-* sometimes fail inside
# a container (they poke at host-only paths / kernel modules); we catch
# the failure with `|| dpkg --configure -a` so the layer still succeeds
# as long as the .so files were unpacked, which is all we need to link
# libnvmpi against.
RUN apt-get update \
 && ( apt-get install -y --no-install-recommends nvidia-l4t-jetson-multimedia-api \
      || dpkg --configure -a || true ) \
 && rm -rf /var/lib/apt/lists/*

# 1) nv-codec-headers — ffmpeg's configure needs these to accept
#    --enable-cuvid / --enable-nvenc. They're harmless on Orin Nano at
#    runtime (cuvid just won't load), and essential for desktop NVIDIA.
RUN git clone --depth 1 --branch ${NV_CODEC_HEADERS_TAG} \
      https://git.videolan.org/git/ffmpeg/nv-codec-headers.git /src/nv-codec-headers \
 && make -C /src/nv-codec-headers install PREFIX=/usr/local

# 2) libnvmpi + ffmpeg patch from a maintained Jetson fork. libnvmpi is
#    a small C wrapper around the L4T Multimedia API (NvVideoDecoder,
#    NvBuffer, ...) that exposes the same hardware NVDEC block cuvid
#    would use on desktop NVIDIA. Installs as /usr/local/lib/libnvmpi.so.
#
#    CMake needs help finding the Jetson libs — libnvbufsurface /
#    libnvbufsurftransform / libnvjpeg all live in the Jetson-specific
#    /usr/lib/aarch64-linux-gnu/{tegra,nvidia} dirs which aren't on the
#    default linker path. Without CMAKE_LIBRARY_PATH the configure step
#    fails with "LIB_NVBUFSURFACE NOTFOUND" and friends.
#
#    The diagnostic block dumps the relevant lib directories BEFORE cmake
#    runs so any future "NOTFOUND" error shows exactly what was available
#    to search — if a lib ships only as a versioned .so.N, find_library()
#    misses it and we need to symlink the unversioned name back in.
RUN git clone ${JETSON_FFMPEG_REPO} /src/jetson-ffmpeg \
 && git -C /src/jetson-ffmpeg checkout ${JETSON_FFMPEG_REF} \
 && echo "=====  libs available at build time  =====" \
 && (dpkg -l | grep -E 'nvidia-l4t|multimedia' || true) \
 && echo "----- files in nvidia-l4t-jetson-multimedia-api -----" \
 && (dpkg -L nvidia-l4t-jetson-multimedia-api 2>/dev/null | grep -E '\.so($|\.)' || echo "  package not installed") \
 && echo "----- nvbufsurface / nvjpeg anywhere on / -----" \
 && (find / -name 'libnvbufsurface*' -o -name 'libnvbufsurftransform*' -o -name 'libnvjpeg*' 2>/dev/null || true) \
 && echo "----- libv4l2 -----" \
 && (ls -la /usr/lib/aarch64-linux-gnu/libv4l2* 2>&1 || true) \
 && echo "==========================================" \
 && cmake -S /src/jetson-ffmpeg -B /src/jetson-ffmpeg/build \
      -DCMAKE_LIBRARY_PATH="/usr/lib/aarch64-linux-gnu/tegra;/usr/lib/aarch64-linux-gnu/nvidia" \
 && cmake --build /src/jetson-ffmpeg/build -j"$(nproc)" \
 && cmake --install /src/jetson-ffmpeg/build \
 && ldconfig

# 3) ffmpeg source — clone upstream at the pinned tag.
RUN git clone --depth 1 --branch ${FFMPEG_VERSION} \
      https://git.ffmpeg.org/ffmpeg.git /src/ffmpeg

# 4) Apply Keylost's nvmpi patch. Fails fast with a directory listing if
#    the patch file isn't where FFMPEG_PATCH_PATH points — makes it easy
#    to pick the right file name when bumping ffmpeg versions.
WORKDIR /src/ffmpeg
RUN if [ ! -f "/src/jetson-ffmpeg/${FFMPEG_PATCH_PATH}" ]; then \
      echo "==> patch not found at /src/jetson-ffmpeg/${FFMPEG_PATCH_PATH}"; \
      echo "==> available patches in fork:"; \
      find /src/jetson-ffmpeg -name '*.patch' -type f | sort; \
      exit 1; \
    fi \
 && echo "==> applying /src/jetson-ffmpeg/${FFMPEG_PATCH_PATH}" \
 && git apply --whitespace=nowarn "/src/jetson-ffmpeg/${FFMPEG_PATCH_PATH}"

# 5) Configure + build ffmpeg. --enable-nvmpi is added by Keylost's patch.
#    The cuvid / nvenc flags stay enabled so desktop NVIDIA hosts and
#    future Orin NX / AGX deploys of the same image get GPU encode too.
RUN PATH="/usr/local/cuda/bin:${PATH}" ./configure \
      --prefix=/opt/ffmpeg \
      --extra-cflags="-I/usr/local/cuda/include -I/usr/local/include" \
      --extra-ldflags="-L/usr/local/cuda/lib64 -L/usr/local/lib" \
      --extra-libs="-lpthread -lm -lnvmpi" \
      --enable-gpl --enable-nonfree --enable-version3 \
      --enable-libx264 --enable-libx265 --enable-libvpx \
      --enable-libopus --enable-libmp3lame --enable-libass --enable-libfreetype \
      --enable-nvmpi \
      --enable-cuda-nvcc --enable-cuvid --enable-nvenc --enable-libnpp \
      --disable-debug --disable-doc --disable-ffplay \
 && make -j"$(nproc)" \
 && make install

# ──────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime: L4T base + Node 20 + compiled ffmpeg + libnvmpi
# ──────────────────────────────────────────────────────────────────────────
FROM nvcr.io/nvidia/l4t-jetpack:${L4T_TAG}

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
    NVIDIA_VISIBLE_DEVICES=all \
    LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu/tegra:/usr/lib/aarch64-linux-gnu/nvidia:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

# Runtime shared libs ffmpeg links against, plus Node.js 20 (from NodeSource
# — the distro package on Ubuntu 22.04 is too old for modern Express) and
# yt-dlp for the Music tab's YouTube fallback source.
# libv4l-0 is required by libnvmpi at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-pip \
      libx264-163 libx265-199 libvpx7 libopus0 libmp3lame0 \
      libass9 libfreetype6 libnuma1 libv4l-0 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && (python3 -m pip install --no-cache-dir yt-dlp \
     || python3 -m pip install --no-cache-dir --break-system-packages yt-dlp) \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Compiled ffmpeg + the libnvmpi shim it loads at runtime. libnvmpi in turn
# dlopens libnvv4l2 / libnvbuf_utils from the host (bind-mounted by
# deploy.sh), which talk to the NVDEC kernel driver through /dev/nvhost-*.
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg    /usr/local/bin/ffmpeg
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffprobe   /usr/local/bin/ffprobe
COPY --from=ffmpeg-build /usr/local/lib/libnvmpi.* /usr/local/lib/
RUN ldconfig

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production && \
    npm cache clean --force

COPY . .

# Create library directory for downloaded content
RUN mkdir -p /app/library

# Run as non-root. 'video' group is added so NVIDIA container runtime's
# /dev/nvhost-* pass-throughs are accessible from a non-root UID.
RUN groupadd -g 1001 nodejs \
 && useradd -u 1001 -g nodejs -G video -m -s /bin/bash nodejs \
 && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (r) => { r.resume(); r.statusCode === 200 ? process.exit(0) : process.exit(1); }).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
