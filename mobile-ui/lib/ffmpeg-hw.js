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
 *   FFMPEG_HWACCEL   — '' (default), 'cuda' / 'nvdec', or 'v4l2m2m'
 *                      Enables GPU decode. On Jetson Orin Nano this alone
 *                      is the big win because the SoC has NVDEC but no
 *                      NVENC; decode is the most expensive part of an
 *                      HEVC → H.264 pipeline so moving it to the GPU frees
 *                      a significant chunk of CPU for libx264 to use.
 *
 *   FFMPEG_ENCODER   — '' (default = libx264), or 'h264_nvenc'
 *                      Opt-in GPU encode. Orin Nano has no NVENC hardware,
 *                      so leave unset there. Orin NX / AGX Orin / any
 *                      desktop NVIDIA card: set to 'h264_nvenc' and the
 *                      whole pipeline stays on the GPU, no hwdownload copy.
 *
 * Defaults are conservative on purpose — unset both and you get byte-for-byte
 * the same libx264 pipeline the code ran before this module existed, which
 * matters because a stock Alpine ffmpeg build has none of the CUDA codecs
 * compiled in and would hard-fail every transcode if we flipped these on by
 * default.
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

function _isCudaLike() {
  return FFMPEG_HWACCEL === 'cuda' || FFMPEG_HWACCEL === 'nvdec';
}

function _useNvenc() {
  return FFMPEG_ENCODER === 'h264_nvenc' || FFMPEG_ENCODER === 'nvenc';
}

function _cuvidFor(sourceCodec) {
  if (!sourceCodec || !_isCudaLike()) return null;
  return CUVID_DECODERS[String(sourceCodec).toLowerCase()] || null;
}

/**
 * Decode/input args. Returns the list that goes BEFORE `-i <path>`.
 *
 * With a known CUVID-supported codec we pin the decoder explicitly and keep
 * frames in CUDA memory (-hwaccel_output_format=cuda), which is required for
 * scale_cuda downstream. Without a codec hint we fall back to `-hwaccel X`
 * alone — ffmpeg picks the decoder and downloads to system memory, so the
 * filter graph stays on the CPU side. That's still a win (decode is off-CPU)
 * and it keeps us robust against source codecs NVDEC doesn't handle.
 */
function buildDecodeArgs(sourceCodec) {
  if (!FFMPEG_HWACCEL) return [];
  const cuvid = _cuvidFor(sourceCodec);
  if (cuvid) {
    return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', cuvid];
  }
  return ['-hwaccel', FFMPEG_HWACCEL];
}

/**
 * Scale-to-max-width filter string. Picks scale_cuda when the decoder kept
 * frames on the GPU, and tacks on hwdownload when the encoder is a CPU one
 * so libx264 gets system-memory yuv420p frames as it expects.
 *
 * The output pixel format is chosen to match the encoder's native input:
 * NVENC wants nv12, libx264 wants yuv420p. Getting this wrong triggers an
 * extra auto-inserted format conversion inside ffmpeg that blows the CUDA
 * pipeline back onto the CPU silently.
 */
function buildScaleFilter(maxWidth, sourceCodec) {
  const cuvid = _cuvidFor(sourceCodec);
  if (cuvid) {
    const pixfmt = _useNvenc() ? 'nv12' : 'yuv420p';
    const gpuScale = `scale_cuda=w='min(${maxWidth},iw)':h=-2:format=${pixfmt}`;
    // NVENC consumes CUDA frames directly; libx264 needs them on the CPU.
    return _useNvenc() ? gpuScale : `${gpuScale},hwdownload,format=${pixfmt}`;
  }
  return `scale='min(${maxWidth},iw)':'-2'`;
}

/**
 * Encoder args for the live transcode / HLS path — latency and wall-clock
 * over compression efficiency. libx264 uses ultrafast+zerolatency, h264_nvenc
 * uses p1+ll (lowest preset, low-latency tune).
 */
function buildLiveEncoderArgs() {
  if (_useNvenc()) {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p1',
      '-tune', 'll',
      '-rc', 'vbr',
      '-cq', '23',
      '-b:v', '0',
      '-maxrate', '6M',
      '-bufsize', '6M',
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
  const decode = FFMPEG_HWACCEL
    ? `${FFMPEG_HWACCEL.toUpperCase()} decode`
    : 'CPU decode';
  const encode = _useNvenc() ? 'NVENC encode' : 'libx264 encode';
  return `${decode} + ${encode}`;
}

module.exports = {
  FFMPEG_HWACCEL,
  FFMPEG_ENCODER,
  buildDecodeArgs,
  buildScaleFilter,
  buildLiveEncoderArgs,
  buildArchivalEncoderArgs,
  describeMode,
};
