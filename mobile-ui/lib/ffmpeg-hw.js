/**
 * Centralized ffmpeg hardware-acceleration plumbing.
 *
 * All three local ffmpeg call sites (HLS live session, /stream/transcode
 * live path, library background conversion) used to carry their own copy of
 * the "maybe add -hwaccel" dance. That made it impossible to roll out a real
 * GPU pipeline — scale_cuda and hwdownload have to be threaded through the
 * filter graph in lockstep with the decoder choice, not bolted on as a
 * prefix. This module owns the whole decision so each call site just asks
 * for "decode args", "scale filter", and "encoder args" and gets a consistent
 * pipeline back.
 *
 * Two environment variables drive the behavior:
 *
 *   FFMPEG_HWACCEL   — '' (default), 'nvmpi', 'cuda' / 'nvdec', or 'v4l2m2m'
 *                      '' — CPU everything (libx264 decode + encode).
 *                      'nvmpi' — Jetson L4T Multimedia API hardware decode
 *                        (via libnvmpi + libnvv4l2). Needed on Orin Nano
 *                        because JetPack 6 on that SoC doesn't ship
 *                        libnvcuvid.so, so cuvid is a dead end.
 *                      'cuda' / 'nvdec' — classic NVDEC via libnvcuvid.
 *                        Works on desktop NVIDIA cards and Orin NX / AGX.
 *
 *   FFMPEG_ENCODER   — '' (default = libx264), or 'h264_nvenc'
 *                      Opt-in GPU encode. Orin Nano has no NVENC hardware,
 *                      so leave unset there. Orin NX / AGX Orin / any
 *                      desktop NVIDIA card: set to 'h264_nvenc'. NVENC is
 *                      only compatible with the 'cuda' decode path because
 *                      scale_cuda keeps frames on the GPU; nvmpi frames
 *                      come back to system memory after decode, so pairing
 *                      nvmpi with nvenc doesn't give a zero-copy pipeline
 *                      and usually isn't worth it vs libx264.
 *
 * Defaults are conservative on purpose — unset both and you get byte-for-byte
 * the same libx264 pipeline the code ran before this module existed, which
 * matters because a stock ffmpeg build without the Jetson patch / cuvid
 * support would hard-fail every transcode if we flipped these on by default.
 */

const FFMPEG_HWACCEL = (process.env.FFMPEG_HWACCEL || '').trim().toLowerCase();
const FFMPEG_ENCODER = (process.env.FFMPEG_ENCODER || '').trim().toLowerCase();

// ffprobe-reported codec names → the matching CUVID decoder. Unknown codecs
// fall back to software decode; -hwaccel cuda alone will still route common
// formats through NVDEC automatically, but we don't get the full GPU filter
// chain without an explicit -c:v X_cuvid and -hwaccel_output_format=cuda.
const CUVID_DECODERS = {
  h264:       'h264_cuvid',
  hevc:       'hevc_cuvid',
  h265:       'hevc_cuvid',
  vp9:        'vp9_cuvid',
  av1:        'av1_cuvid',
  mpeg2video: 'mpeg2_cuvid',
  vc1:        'vc1_cuvid',
};

// ffprobe-reported codec names → the matching NVMPI decoder (from Keylost's
// jetson-ffmpeg patch). Orin Nano's NVDEC block supports H.264, HEVC, VP8,
// VP9, MPEG-2, MPEG-4 and VC-1 via the L4T Multimedia API; AV1 is NOT
// supported on Ampere NVDEC (Orin is Ampere-based), so av1 falls through to
// software decode. Any codec not in this map also falls through.
const NVMPI_DECODERS = {
  h264:       'h264_nvmpi',
  hevc:       'hevc_nvmpi',
  h265:       'hevc_nvmpi',
  vp8:        'vp8_nvmpi',
  vp9:        'vp9_nvmpi',
  mpeg2video: 'mpeg2_nvmpi',
  mpeg4:      'mpeg4_nvmpi',
};

// Pixel formats Keylost's libnvmpi can actually ingest. Orin Nano's NVDEC
// hardware supports Main 10 HEVC (yuv420p10le) just fine, but libnvmpi only
// wires up 8-bit 4:2:0 — attempting 10-bit produces
// "Invalid Pix_FMT for NVMPI: Only YUV420P and YUVJ420P are supported" and
// the whole decode hard-fails. When the probed pix_fmt isn't in this set we
// fall through to software decode so 10-bit x265 rips still play.
const NVMPI_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);

function _isNvmpi() {
  return FFMPEG_HWACCEL === 'nvmpi';
}

function _isCudaLike() {
  return FFMPEG_HWACCEL === 'cuda' || FFMPEG_HWACCEL === 'nvdec';
}

function _useNvenc() {
  // NVENC only makes sense paired with the CUDA decode path (zero-copy via
  // scale_cuda). With nvmpi, frames are already on the CPU after decode, so
  // we stay on libx264 regardless of the encoder request.
  return (FFMPEG_ENCODER === 'h264_nvenc' || FFMPEG_ENCODER === 'nvenc')
    && _isCudaLike();
}

function _cuvidFor(sourceCodec) {
  if (!sourceCodec || !_isCudaLike()) return null;
  return CUVID_DECODERS[String(sourceCodec).toLowerCase()] || null;
}

function _nvmpiFor(sourceCodec, sourcePixFmt) {
  if (!sourceCodec || !_isNvmpi()) return null;
  const decoder = NVMPI_DECODERS[String(sourceCodec).toLowerCase()] || null;
  if (!decoder) return null;
  // When the pix_fmt is known, require it to be one libnvmpi accepts.
  // Unknown pix_fmt (null/undefined) means "live transcode, no probe" —
  // optimistically let the decoder try and fall back at runtime.
  if (sourcePixFmt && !NVMPI_PIX_FMTS.has(String(sourcePixFmt).toLowerCase())) {
    return null;
  }
  return decoder;
}

/**
 * Decode/input args. Returns the list that goes BEFORE `-i <path>`.
 *
 * The three modes produce very different prefixes:
 *   nvmpi — just `-c:v hevc_nvmpi` (no -hwaccel flag). libnvmpi talks to the
 *     L4T Multimedia API directly; frames are delivered to ffmpeg's filter
 *     chain in system memory as if decoded by libavcodec.
 *   cuda + known cuvid codec — pin the decoder and keep frames in CUDA
 *     memory (-hwaccel_output_format=cuda), which is required for scale_cuda
 *     downstream. Desktop NVIDIA / Orin NX / AGX only.
 *   cuda + unknown codec — `-hwaccel X` alone so ffmpeg picks the decoder
 *     and downloads to system memory. Still a win vs libx264 decode.
 *
 * With the codec hint missing and nvmpi selected, we fall through to
 * software decode rather than blindly guessing, because nvmpi is strictly
 * per-codec (no generic "-hwaccel nvmpi" flag exists in the patch).
 */
function buildDecodeArgs(sourceCodec, sourcePixFmt) {
  if (!FFMPEG_HWACCEL) return [];

  if (_isNvmpi()) {
    const nvmpi = _nvmpiFor(sourceCodec, sourcePixFmt);
    return nvmpi ? ['-c:v', nvmpi] : [];
  }

  if (_isCudaLike()) {
    const cuvid = _cuvidFor(sourceCodec);
    if (cuvid) {
      return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', cuvid];
    }
    return ['-hwaccel', FFMPEG_HWACCEL];
  }

  // v4l2m2m / future modes — pass through and let ffmpeg interpret.
  return ['-hwaccel', FFMPEG_HWACCEL];
}

/**
 * Scale-to-max-width filter string. Picks scale_cuda only when the CUDA
 * decoder kept frames on the GPU and tacks on hwdownload when the encoder
 * is a CPU one; otherwise returns a plain CPU scale.
 *
 * nvmpi frames are already in system memory after decode, so nvmpi+libx264
 * uses the CPU scale path exactly like no-hwaccel does. That's not as good
 * as a fully-GPU pipeline but the decode win is still large — and on Orin
 * Nano it's the only hardware decode path that works at all.
 */
function buildScaleFilter(maxWidth, sourceCodec, sourcePixFmt) {
  // sourcePixFmt currently only narrows the NVMPI decision; the CUDA/cuvid
  // scale path doesn't change on 10-bit sources (scale_cuda handles both).
  void sourcePixFmt;
  const cuvid = _cuvidFor(sourceCodec);
  if (cuvid) {
    const pixfmt = _useNvenc() ? 'nv12' : 'yuv420p';
    const gpuScale = `scale_cuda=w='min(${maxWidth},iw)':h=-2:format=${pixfmt}`;
    return _useNvenc() ? gpuScale : `${gpuScale},hwdownload,format=${pixfmt}`;
  }
  return `scale='min(${maxWidth},iw)':'-2'`;
}

// The live transcode / HLS path scales the source down to at most this
// width and never up (see the min() in buildScaleFilter). Both the scale
// filter and the bitrate ladder key off this constant so they can't drift.
const LIVE_MAX_OUTPUT_WIDTH = 1280;

// Live-transcode peak-bitrate ladder, keyed to the width the encoder will
// actually emit. A source narrower than LIVE_MAX_OUTPUT_WIDTH is encoded at
// its own width, so a 480p episode lands at 480p — capping it at the 720p
// 6 Mbps ceiling just lets the encoder spend bits a phone still has to pull
// down with no visible return. Each threshold is an OUTPUT width in pixels.
function _liveMaxrateKbps(sourceWidth) {
  const w = Number.isFinite(sourceWidth) && sourceWidth > 0
    ? Math.min(LIVE_MAX_OUTPUT_WIDTH, sourceWidth)
    : LIVE_MAX_OUTPUT_WIDTH; // unknown source — assume the 720p ceiling
  if (w >= 1280) return 6000; // 720p
  if (w >= 1024) return 4000; // ~576p
  if (w >= 854)  return 2500; // 480p
  if (w >= 640)  return 1500; // 360p
  return 1000;                // anything smaller
}

/**
 * Encoder args for the live transcode / HLS path — latency and wall-clock
 * over compression efficiency. libx264 uses ultrafast+zerolatency, h264_nvenc
 * uses p1+ll (lowest preset, low-latency tune). Both get a maxrate/bufsize
 * ceiling scaled to the output resolution (see _liveMaxrateKbps) so a
 * low-res source never produces segments too fat for the client's link.
 *
 * `sourceWidth` is the probed pixel width of the input; pass null/0 when it
 * isn't known and the ceiling falls back to the conservative 720p value.
 */
function buildLiveEncoderArgs(sourceWidth) {
  const rate = `${_liveMaxrateKbps(sourceWidth)}k`;
  if (_useNvenc()) {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p1',
      '-tune', 'll',
      '-rc', 'vbr',
      '-cq', '23',
      '-b:v', '0',
      '-maxrate', rate,
      '-bufsize', rate,
      '-profile:v', 'main',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    // Cap the peak bitrate. CRF alone targets constant quality with an
    // uncapped bitrate, and ultrafast is bitrate-inefficient enough that
    // high-motion scenes spike well past what a phone link can pull a
    // segment in realtime — which surfaces as rebuffering. maxrate+bufsize
    // turns this into capped-CRF; the ceiling tracks the output resolution.
    '-maxrate', rate,
    '-bufsize', rate,
  ];
}

/**
 * Encoder args for the background library conversion path — we run once per
 * file and store the output forever, so quality and size matter more than
 * wall-clock. libx264 uses veryfast (the sweet spot on Orin Nano); h264_nvenc
 * uses p5+hq with spatial/temporal AQ for RTX-class / Orin NX hardware.
 */
function buildArchivalEncoderArgs() {
  if (_useNvenc()) {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', '21',
      '-b:v', '0',
      '-maxrate', '12M',
      '-bufsize', '24M',
      '-profile:v', 'high',
      '-level', '4.1',
      '-bf', '3',
      '-b_ref_mode', 'middle',
      '-spatial-aq', '1',
      '-temporal-aq', '1',
      '-rc-lookahead', '32',
      '-pix_fmt', 'yuv420p',
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
  ];
}

/**
 * One-line summary of the effective mode, for a startup log line.
 */
function describeMode() {
  let decode;
  if (_isNvmpi()) decode = 'NVMPI decode (Jetson L4T)';
  else if (FFMPEG_HWACCEL) decode = `${FFMPEG_HWACCEL.toUpperCase()} decode`;
  else decode = 'CPU decode';
  const encode = _useNvenc() ? 'NVENC encode' : 'libx264 encode';
  return `${decode} + ${encode}`;
}

module.exports = {
  FFMPEG_HWACCEL,
  FFMPEG_ENCODER,
  LIVE_MAX_OUTPUT_WIDTH,
  buildDecodeArgs,
  buildScaleFilter,
  buildLiveEncoderArgs,
  buildArchivalEncoderArgs,
  describeMode,
};
