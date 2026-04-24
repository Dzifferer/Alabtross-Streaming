# syntax=docker/dockerfile:1.6
#
# Jetson-aware build. The image is split into a "ffmpeg-build" stage that
# compiles ffmpeg against the JetPack CUDA / NVDEC / NVENC headers, and a
# runtime stage that just copies the resulting binaries onto a slim L4T
# base. End result: /usr/local/bin/ffmpeg knows about h264_cuvid /
# hevc_cuvid / scale_cuda / h264_nvenc, which is what lib/ffmpeg-hw.js
# needs when FFMPEG_HWACCEL=cuda (and optionally FFMPEG_ENCODER=h264_nvenc).
#
# The first build on an Orin Nano takes ~15-20 min for the ffmpeg compile.
# Subsequent rebuilds hit the Docker layer cache and finish in seconds
# unless FFMPEG_VERSION / L4T_TAG actually change.
#
# Override knobs (all optional):
#   --build-arg L4T_TAG=r35.4.1          # JetPack 5.x host (default is 6.2 = r36.4.0)
#   --build-arg FFMPEG_VERSION=n6.1.1    # pin a different ffmpeg tag
#   --build-arg NV_CODEC_HEADERS_TAG=n12.1.14.0

ARG L4T_TAG=r36.4.0
ARG FFMPEG_VERSION=n6.1.1
ARG NV_CODEC_HEADERS_TAG=n12.1.14.0

# ──────────────────────────────────────────────────────────────────────────
# Stage 1 — compile ffmpeg with CUDA / CUVID / NVENC
# ──────────────────────────────────────────────────────────────────────────
FROM nvcr.io/nvidia/l4t-jetpack:${L4T_TAG} AS ffmpeg-build

ARG FFMPEG_VERSION
ARG NV_CODEC_HEADERS_TAG
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates git pkg-config yasm nasm \
      libx264-dev libx265-dev libvpx-dev libopus-dev libmp3lame-dev \
      libass-dev libfreetype6-dev libnuma-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

# ffmpeg's nvenc / cuvid / npp support is gated on NVIDIA's header shim —
# these headers describe the driver ABI without requiring the closed-source
# driver at build time.
RUN git clone --depth 1 --branch ${NV_CODEC_HEADERS_TAG} \
      https://git.videolan.org/git/ffmpeg/nv-codec-headers.git /src/nv-codec-headers \
 && make -C /src/nv-codec-headers install PREFIX=/usr/local

RUN git clone --depth 1 --branch ${FFMPEG_VERSION} \
      https://git.ffmpeg.org/ffmpeg.git /src/ffmpeg

WORKDIR /src/ffmpeg
RUN PATH="/usr/local/cuda/bin:${PATH}" ./configure \
      --prefix=/opt/ffmpeg \
      --extra-cflags="-I/usr/local/cuda/include -I/usr/local/include" \
      --extra-ldflags="-L/usr/local/cuda/lib64 -L/usr/local/lib" \
      --extra-libs="-lpthread -lm" \
      --enable-gpl --enable-nonfree --enable-version3 \
      --enable-libx264 --enable-libx265 --enable-libvpx \
      --enable-libopus --enable-libmp3lame --enable-libass --enable-libfreetype \
      --enable-cuda-nvcc --enable-cuvid --enable-nvenc --enable-libnpp \
      --disable-debug --disable-doc --disable-ffplay \
 && make -j"$(nproc)" \
 && make install

# ──────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime image: L4T base + Node 20 + the compiled ffmpeg
# ──────────────────────────────────────────────────────────────────────────
FROM nvcr.io/nvidia/l4t-jetpack:${L4T_TAG}

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
    NVIDIA_VISIBLE_DEVICES=all

# Runtime shared libs that ffmpeg links to, plus Node.js 20 (from NodeSource
# — the distro package on Ubuntu 20.04/22.04 is too old for modern Express)
# and Python 3 + yt-dlp for the Music tab's YouTube fallback source.
# curl is needed by the NodeSource installer; ca-certificates by npm.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-pip \
      libx264-163 libx265-199 libvpx7 libopus0 libmp3lame0 \
      libass9 libfreetype6 libnuma1 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe

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
