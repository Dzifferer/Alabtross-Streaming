#!/usr/bin/env node
/**
 * Albatross Streaming — GPU Conversion Worker
 *
 * Lightweight HTTP service that runs on a Windows PC with an NVIDIA RTX
 * card, accepts source video files from the Jetson Orin Nano over Tailscale,
 * transcodes them to universal H.264/AAC MP4 using the GPU's NVENC, and
 * streams the result back. Designed to be the encode-side of a hybrid
 * pipeline where the Orin keeps doing torrent + library + UI work and only
 * offloads the CPU-expensive transcode.
 *
 * Single-file Node script. No npm dependencies. Logs to stdout.
 *
 * Endpoints:
 *   GET  /health     → JSON status (ffmpeg version, GPU name, config)
 *   POST /transcode  → request body is the source file; response is MP4
 *
 * POST /transcode headers:
 *   X-Source-Filename     (optional) original filename, for logging + ext
 *   X-Source-Codec        (optional) source video codec hint, skips probe
 *   X-Source-Audio        (optional) source audio codec hint
 *   X-Source-Audio-Copy   (optional) "1" → stream-copy audio (skip re-encode)
 *   X-Worker-Secret       (required — must match WORKER_SECRET on this worker)
 *
 * Environment:
 *   WORKER_PORT     port to listen on               (default 8090)
 *   WORKER_HOST     bind address                    (default 0.0.0.0)
 *   WORKER_TEMP     scratch dir for in-flight files (default %TEMP%\alabtross-worker)
 *   WORKER_SECRET   shared secret for X-Worker-Secret header (REQUIRED — worker refuses to start without it)
 *   FFMPEG_PATH     path to ffmpeg.exe              (default 'ffmpeg' from PATH)
 *   FFPROBE_PATH    path to ffprobe.exe             (default 'ffprobe' from PATH)
 *   NVENC_PRESET    NVENC quality preset p1..p7     (default 'p6')
 *   NVENC_CQ        NVENC constant-quality target   (default '21')
 *   NVENC_MAXRATE   NVENC vbr maxrate               (default '12M')
 *   MAX_WIDTH       output width cap in pixels      (default 1920)
 *   AUDIO_BITRATE   AAC bitrate when re-encoding    (default '192k')
 *
 * The Tailscale tunnel is mutually authenticated and end-to-end encrypted,
 * but WORKER_SECRET is required as a second layer so that any process with
 * network reach to this port (e.g. LAN access, another tailnet node) still
 * can't spend GPU cycles without the shared secret.
 */

const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────
const PORT          = parseInt(process.env.WORKER_PORT || '8090', 10);
const HOST          = process.env.WORKER_HOST || '0.0.0.0';
const TEMP_DIR      = process.env.WORKER_TEMP || path.join(os.tmpdir(), 'alabtross-worker');
const SECRET        = process.env.WORKER_SECRET || '';
if (!SECRET) {
  console.error('[worker] WORKER_SECRET is required. Generate one (e.g. `openssl rand -hex 32`) and set it on both this worker and the server it talks to.');
  process.exit(1);
}
const FFMPEG        = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE       = process.env.FFPROBE_PATH || 'ffprobe';
const NVENC_PRESET  = process.env.NVENC_PRESET || 'p6';
const NVENC_CQ      = process.env.NVENC_CQ || '21';
const NVENC_MAXRATE = process.env.NVENC_MAXRATE || '12M';
const NVENC_BUFSIZE = process.env.NVENC_BUFSIZE || doubleRate(NVENC_MAXRATE);

// Double a "12M" / "8000k" rate string for bufsize. ffmpeg accepts both
// units; we just preserve whichever the user gave us.
function doubleRate(rateStr) {
  const m = String(rateStr).match(/^(\d+(?:\.\d+)?)([kKmMgG]?)$/);
  if (!m) return '24M';
  const n = parseFloat(m[1]) * 2;
  return `${n}${m[2] || 'M'}`;
}
const MAX_WIDTH     = parseInt(process.env.MAX_WIDTH || '1920', 10);
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '192k';

fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Startup checks ───────────────────────────────────────────────────
// Sweep stale temp files from a previous crash. Anything older than 12h is
// junk that nobody is going to want back.
function sweepStaleTemp() {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const p = path.join(TEMP_DIR, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
sweepStaleTemp();

function checkBinaries() {
  for (const [name, bin] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]]) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      console.error(`[worker] ${name} not found at "${bin}". Install ffmpeg or set ${name.toUpperCase()}_PATH.`);
      process.exit(1);
    }
  }
  // h264_nvenc encoder must be present in this ffmpeg build
  const r = spawnSync(FFMPEG, ['-hide_banner', '-h', 'encoder=h264_nvenc'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!/h264_nvenc/i.test(out) || /unknown encoder/i.test(out)) {
    console.error('[worker] h264_nvenc encoder not available in this ffmpeg build.');
    console.error('[worker] Install an NVIDIA-enabled ffmpeg (Gyan.dev "full" build on Windows works).');
    process.exit(1);
  }
}
checkBinaries();

// ─── Helpers ──────────────────────────────────────────────────────────
function probeVideoCodec(filePath) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return ((r.stdout || '').trim()) || null;
}

// Source codecs that NVDEC handles. The fallback (no entry here) goes
// through software decode → hwupload to NVENC, which is still way faster
// than libx264 since the encode side stays on the GPU.
const CUVID_DECODERS = {
  h264:       'h264_cuvid',
  hevc:       'hevc_cuvid',
  vp9:        'vp9_cuvid',
  av1:        'av1_cuvid',
  mpeg2video: 'mpeg2_cuvid',
  vc1:        'vc1_cuvid',
};

function buildFfmpegArgs(inputPath, outputPath, sourceCodec, audioCopy) {
  const cuvid = sourceCodec ? CUVID_DECODERS[sourceCodec.toLowerCase()] : null;

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-fflags', '+genpts',
  ];

  if (cuvid) {
    // Full GPU pipeline: NVDEC → CUDA scale → NVENC. Frames stay in
    // device memory the whole way through, no PCIe round trip.
    args.push(
      '-hwaccel', 'cuda',
      '-hwaccel_output_format', 'cuda',
      '-c:v', cuvid,
    );
  }

  args.push('-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  if (cuvid) {
    // Single-quoted min() lets the filter parser treat the comma as a
    // literal instead of a filter-chain separator. Same trick the local
    // libx264 path in library-manager.js uses.
    args.push('-vf', `scale_cuda=w='min(${MAX_WIDTH},iw)':h=-2:format=nv12`);
  } else {
    // Software decode + CPU scale, then ffmpeg auto-uploads to NVENC.
    args.push('-vf', `scale='min(${MAX_WIDTH},iw)':'-2',format=nv12`);
  }

  args.push(
    '-c:v', 'h264_nvenc',
    '-preset', NVENC_PRESET,
    '-tune', 'hq',
    '-rc', 'vbr',
    '-cq', NVENC_CQ,
    '-b:v', '0',
    '-maxrate', NVENC_MAXRATE,
    '-bufsize', NVENC_BUFSIZE,
    '-profile:v', 'high',
    '-level', '4.1',
    // Quality knobs that cost almost nothing on Ampere/Turing NVENC but
    // measurably improve perceived quality at the same bitrate.
    '-bf', '3',
    '-b_ref_mode', 'middle',
    '-spatial-aq', '1',
    '-temporal-aq', '1',
    '-rc-lookahead', '32',
  );

  if (audioCopy) {
    // Source audio is already universal (AAC LC stereo @ ≤48k) — skip
    // the re-encode, save a few percent on wall-clock and avoid the
    // extra generation loss.
    args.push('-c:a', 'copy');
  } else {
    args.push(
      '-c:a', 'aac',
      '-b:a', AUDIO_BITRATE,
      '-ac', '2',
      '-ar', '48000',
    );
  }

  args.push(
    '-movflags', '+faststart',
    '-f', 'mp4',
    outputPath,
  );

  return args;
}

const SECRET_BUF = Buffer.from(SECRET);
function checkAuth(req) {
  const provided = req.headers['x-worker-secret'];
  if (typeof provided !== 'string' || provided.length !== SECRET.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), SECRET_BUF);
  } catch {
    return false;
  }
}

function jsonResponse(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function newJobPaths(extHint) {
  const id = crypto.randomBytes(8).toString('hex');
  const ext = extHint || '.bin';
  return {
    id,
    inputPath:  path.join(TEMP_DIR, `${id}.in${ext}`),
    outputPath: path.join(TEMP_DIR, `${id}.out.mp4`),
  };
}

function cleanupJob(job) {
  for (const p of [job.inputPath, job.outputPath]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

// ─── Endpoints ────────────────────────────────────────────────────────
function handleHealth(req, res) {
  const ffv = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' });
  const firstLine = ((ffv.stdout || '').split('\n')[0] || '').trim();
  let nvidiaSmi = null;
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { encoding: 'utf8' });
    if (r.status === 0) nvidiaSmi = (r.stdout || '').trim();
  } catch { /* ignore */ }
  jsonResponse(res, 200, {
    ok: true,
    encoder: 'h264_nvenc',
    preset: NVENC_PRESET,
    cq: NVENC_CQ,
    maxWidth: MAX_WIDTH,
    ffmpeg: firstLine,
    gpu: nvidiaSmi,
    tempDir: TEMP_DIR,
    secured: !!SECRET,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  });
}

function handleTranscode(req, res) {
  if (!checkAuth(req)) {
    return jsonResponse(res, 401, { error: 'unauthorized' });
  }

  // Parse hints from headers — all optional.
  let sourceFilename = 'source.bin';
  try { sourceFilename = decodeURIComponent(req.headers['x-source-filename'] || 'source.bin'); }
  catch { /* keep default */ }
  const sourceCodec    = (req.headers['x-source-codec'] || '').toLowerCase() || null;
  const sourceAudio    = (req.headers['x-source-audio'] || '').toLowerCase() || null;
  const audioCopyHint  = (req.headers['x-source-audio-copy'] || '') === '1';

  const ext = path.extname(sourceFilename).toLowerCase() || '.bin';
  const job = newJobPaths(ext);
  const tStart = Date.now();
  const tag = `[worker ${job.id}]`;
  console.log(`${tag} ← ${sourceFilename}  (codec=${sourceCodec || 'unknown'} audio=${sourceAudio || 'unknown'}${audioCopyHint ? ' COPY' : ''})`);

  // Stream the request body to disk first. Some containers (MP4 with
  // moov at the end, MKV with index needed for seek) require ffmpeg to
  // see a seekable input — piping stdin can fail mid-encode in ways that
  // are hard to recover from. The temp dir lives on the worker's local
  // disk, which on a desktop SSD is essentially free.
  const ws = fs.createWriteStream(job.inputPath);
  let bytesIn = 0;
  let aborted = false;
  let ff = null;

  req.on('data', (chunk) => { bytesIn += chunk.length; });
  req.pipe(ws);

  req.on('aborted', () => {
    aborted = true;
    try { ws.destroy(); } catch { /* ignore */ }
    if (ff) { try { ff.kill('SIGTERM'); } catch { /* ignore */ } }
    cleanupJob(job);
    console.log(`${tag} client aborted upload after ${(bytesIn / 1e9).toFixed(2)} GB`);
  });

  ws.on('error', (err) => {
    cleanupJob(job);
    if (!res.headersSent) jsonResponse(res, 500, { error: `upload write failed: ${err.message}` });
  });

  ws.on('finish', () => {
    if (aborted) return;
    const tUploaded = Date.now();
    const uploadSec = (tUploaded - tStart) / 1000;
    const mbps = (bytesIn * 8) / 1e6 / Math.max(uploadSec, 0.001);
    console.log(`${tag} upload done: ${(bytesIn / 1e9).toFixed(2)} GB in ${uploadSec.toFixed(0)}s (${mbps.toFixed(0)} Mbps)`);

    // If the Orin didn't send a codec hint, probe locally. Costs ~50ms.
    let codec = sourceCodec;
    if (!codec) {
      codec = probeVideoCodec(job.inputPath);
      console.log(`${tag} probed codec=${codec || 'unknown'}`);
    }

    const args = buildFfmpegArgs(job.inputPath, job.outputPath, codec, audioCopyHint);
    console.log(`${tag} ffmpeg ${args.join(' ')}`);

    ff = spawn(FFMPEG, args);

    let stderrBuf = '';
    ff.stderr.on('data', (d) => {
      const msg = d.toString();
      stderrBuf += msg;
      if (stderrBuf.length > 32768) stderrBuf = stderrBuf.slice(-32768);
      const trimmed = msg.trim();
      if (trimmed) console.log(`${tag} ffmpeg: ${trimmed}`);
    });

    ff.on('error', (err) => {
      cleanupJob(job);
      if (!res.headersSent) jsonResponse(res, 500, { error: `ffmpeg spawn failed: ${err.message}` });
    });

    ff.on('close', (code) => {
      const tEncoded = Date.now();
      if (aborted) {
        cleanupJob(job);
        return;
      }

      if (code !== 0) {
        console.log(`${tag} ffmpeg exited ${code}`);
        cleanupJob(job);
        if (!res.headersSent) {
          jsonResponse(res, 500, {
            error: `ffmpeg exited ${code}`,
            ffmpegStderr: stderrBuf.slice(-4096),
          });
        }
        return;
      }

      let outStat;
      try {
        outStat = fs.statSync(job.outputPath);
      } catch (e) {
        cleanupJob(job);
        if (!res.headersSent) jsonResponse(res, 500, { error: `output missing: ${e.message}` });
        return;
      }
      if (outStat.size === 0) {
        cleanupJob(job);
        if (!res.headersSent) jsonResponse(res, 500, { error: 'output empty' });
        return;
      }

      const encodeSec = (tEncoded - tUploaded) / 1000;
      const sizeRatio = outStat.size / Math.max(bytesIn, 1);
      console.log(`${tag} encode done: ${(outStat.size / 1e9).toFixed(2)} GB in ${encodeSec.toFixed(0)}s (${(sizeRatio * 100).toFixed(0)}% of input) — streaming back`);

      // Stream the output file back as the response body.
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': outStat.size,
        'X-Worker-Encoder': 'h264_nvenc',
        'X-Worker-Codec-Input': codec || 'unknown',
        'X-Worker-Encode-Sec': String(encodeSec.toFixed(0)),
      });
      const rs = fs.createReadStream(job.outputPath);
      rs.pipe(res);
      rs.on('close', () => {
        cleanupJob(job);
        const tTotal = (Date.now() - tStart) / 1000;
        console.log(`${tag} complete in ${tTotal.toFixed(0)}s total`);
      });
      rs.on('error', () => {
        try { res.destroy(); } catch { /* ignore */ }
        cleanupJob(job);
      });
    });

    // If the Orin disconnects mid-encode, kill ffmpeg so we don't keep
    // burning GPU on output nobody is going to read.
    res.on('close', () => {
      if (!res.writableFinished && ff) {
        try { ff.kill('SIGTERM'); } catch { /* ignore */ }
        cleanupJob(job);
        console.log(`${tag} client disconnected mid-encode`);
      }
    });
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health')    return handleHealth(req, res);
  if (req.method === 'POST' && req.url === '/transcode') return handleTranscode(req, res);
  jsonResponse(res, 404, { error: 'not found' });
});

// No idle/header timeouts — long encodes legitimately stall the socket
// for many minutes between request body and response body.
server.timeout         = 0;
server.keepAliveTimeout = 0;
server.headersTimeout   = 0;
server.requestTimeout   = 0;

server.listen(PORT, HOST, () => {
  console.log(`[worker] albatross GPU worker listening on http://${HOST}:${PORT}`);
  console.log(`[worker] preset=${NVENC_PRESET} cq=${NVENC_CQ} maxWidth=${MAX_WIDTH} secret=${SECRET ? 'set' : 'none'}`);
  console.log(`[worker] temp=${TEMP_DIR}`);
});

process.on('SIGINT',  () => { console.log('[worker] SIGINT, shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[worker] SIGTERM, shutting down'); process.exit(0); });
