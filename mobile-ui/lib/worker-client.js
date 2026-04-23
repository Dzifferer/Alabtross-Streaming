/**
 * Albatross — GPU Worker Client
 *
 * Talks to the optional Windows-side GPU conversion worker over Tailscale.
 * The worker runs h264_nvenc on a desktop NVIDIA card and replaces the
 * Orin Nano's libx264 software encode for background library conversions.
 *
 * The Orin doesn't depend on the worker — if WORKER_URL isn't set, or the
 * worker is unreachable, callers fall back to local libx264. This module
 * just provides the HTTP plumbing for talking to the worker when it's there.
 *
 * Used by library-manager.js. See worker/README.md for the worker side.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const { URL } = require('url');

const HEALTH_TIMEOUT_MS = 5000;

// If neither side sees any bytes for this long, treat the connection as
// dead and bail out so the conversion can be retried locally. The default
// is generous because real encodes legitimately go silent on the wire for
// minutes between the upload finishing and the download starting.
const DEFAULT_STALL_MS = parseInt(process.env.WORKER_STALL_MS || '120000', 10);
// Hard ceiling on the encode phase. req.setTimeout(0) disables Node's
// socket idle timeout, so a half-open TCP connection (worker crashed,
// OS hasn't noticed yet) would otherwise wedge us forever. 60 minutes
// covers a 4K HEVC remux on weaker GPUs; override with
// WORKER_ENCODE_MAX_MS for environments with slower hardware.
const DEFAULT_ENCODE_MAX_MS = parseInt(process.env.WORKER_ENCODE_MAX_MS || '3600000', 10);

class WorkerClient {
  /**
   * @param {object} opts
   * @param {string} opts.workerUrl  e.g. http://gpu-pc.tailnet.ts.net:8090
   * @param {string} [opts.secret]   shared secret matching WORKER_SECRET
   * @param {number} [opts.stallMs]  abort if no progress for this many ms
   */
  constructor(opts = {}) {
    this.workerUrl    = opts.workerUrl || '';
    this.secret       = opts.secret || '';
    this.stallMs      = opts.stallMs || DEFAULT_STALL_MS;
    this.encodeMaxMs  = opts.encodeMaxMs || DEFAULT_ENCODE_MAX_MS;
  }

  enabled() {
    return !!this.workerUrl;
  }

  _module(urlObj) {
    return urlObj.protocol === 'https:' ? https : http;
  }

  /**
   * Probe the worker's /health endpoint. Returns the parsed health JSON
   * on success or null on any failure (network error, non-200, bad JSON).
   * Never throws — callers can use it as a boolean.
   */
  async checkHealth() {
    if (!this.workerUrl) return null;
    let urlObj;
    try { urlObj = new URL('/health', this.workerUrl); }
    catch { return null; }

    return new Promise((resolve) => {
      const req = this._module(urlObj).get({
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: this.secret ? { 'X-Worker-Secret': this.secret } : {},
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let buf = '';
        res.on('data', (d) => {
          buf += d.toString();
          if (buf.length > 16384) { req.destroy(); resolve(null); }
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            resolve(j && j.ok ? j : null);
          } catch { resolve(null); }
        });
      });
      req.setTimeout(HEALTH_TIMEOUT_MS, () => { try { req.destroy(); } catch {} resolve(null); });
      req.on('error', () => resolve(null));
    });
  }

  /**
   * Transcode a file via the remote worker.
   *
   * Streams `inputPath` as the request body, streams the response body to
   * `outputPath`. Resolves with { inputBytes, outputBytes, encodeSec } on
   * success. Rejects with an Error on any failure — caller is responsible
   * for cleaning up `outputPath` on rejection.
   *
   * @param {string}   inputPath  absolute path to source file
   * @param {string}   outputPath absolute path to write the converted MP4
   * @param {object}   opts
   * @param {string}   [opts.filename]    original filename for logging
   * @param {string}   [opts.sourceCodec] video codec hint (skips probe on worker)
   * @param {string}   [opts.sourceAudio] audio codec hint (info only, for logs)
   * @param {boolean}  [opts.audioCopy]   tell worker to stream-copy audio
   * @param {function} [opts.onProgress]  ({phase, bytesUp, bytesDown, totalUp}) => void
   * @param {function} [opts.registerHandle] (handle) => void — handle has .kill()
   *                                          for shutdown / pause integration
   * @returns {Promise<{inputBytes:number, outputBytes:number, encodeSec:number}>}
   */
  transcode(inputPath, outputPath, opts = {}) {
    return new Promise((resolve, reject) => {
      let urlObj;
      try { urlObj = new URL('/transcode', this.workerUrl); }
      catch (e) { return reject(new Error(`worker URL invalid: ${e.message}`)); }

      let inputStat;
      try { inputStat = fs.statSync(inputPath); }
      catch (e) { return reject(new Error(`input stat failed: ${e.message}`)); }

      const headers = {
        'Content-Type':   'application/octet-stream',
        'Content-Length': String(inputStat.size),
        'X-Source-Filename': encodeURIComponent(opts.filename || 'source.bin'),
      };
      if (opts.sourceCodec)  headers['X-Source-Codec']      = opts.sourceCodec;
      if (opts.sourceAudio)  headers['X-Source-Audio']      = opts.sourceAudio;
      if (opts.audioCopy)    headers['X-Source-Audio-Copy'] = '1';
      if (this.secret)       headers['X-Worker-Secret']     = this.secret;

      const reqOpts = {
        method:   'POST',
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port:     urlObj.port,
        path:     urlObj.pathname,
        headers,
      };

      let cleaned = false;
      let killed  = false;
      let lastProgressAt = Date.now();
      let encodeStartedAt = 0;   // set when phase transitions to 'encode'
      let bytesUp   = 0;
      let bytesDown = 0;
      let phase     = 'upload';
      let stallTimer = null;
      let rs = null;
      let ws = null;
      let req = null;

      const handle = {
        // Caller (library-manager._pauseRunningConversionsForDownloads or
        // shutdown) can call kill() to abort.
        kill: () => {
          killed = true;
          cleanup();
          reject(new Error('killed'));
        },
        get bytesUp()   { return bytesUp; },
        get bytesDown() { return bytesDown; },
        get phase()     { return phase; },
      };
      if (opts.registerHandle) opts.registerHandle(handle);

      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        try { if (rs)  rs.destroy();  } catch {}
        try { if (ws)  ws.destroy();  } catch {}
        try { if (req) req.destroy(); } catch {}
      }

      function fail(err) {
        if (cleaned) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }

      // Stall watchdog: if no bytes have moved in `stallMs` AND we're past
      // the encode-only quiet period, abort. We give a long quiet period
      // because legitimate encodes can sit silent for many minutes between
      // the upload finishing and the response body starting.
      const stallMs = this.stallMs;
      const encodeMaxMs = this.encodeMaxMs;
      stallTimer = setInterval(() => {
        if (cleaned || killed) return;
        const idleFor = Date.now() - lastProgressAt;
        // Only enforce the stall during transfer phases — the encode-only
        // gap between upload-complete and download-start can legitimately
        // last as long as the entire encode (5–15 min on a 4K source).
        if (phase === 'upload' && idleFor > stallMs) {
          fail(new Error(`upload stalled for ${(idleFor / 1000).toFixed(0)}s`));
        }
        if (phase === 'download' && idleFor > stallMs) {
          fail(new Error(`download stalled for ${(idleFor / 1000).toFixed(0)}s`));
        }
        // Hard cap on the encode phase. The stall watchdog above is
        // deliberately disabled during encode (zero bytes is legitimate),
        // but without any cap a half-open TCP connection to a crashed
        // worker would hang this request forever. An hour covers the
        // p99 4K HEVC job on GPUs we've seen; tune with WORKER_ENCODE_MAX_MS.
        if (phase === 'encode' && encodeStartedAt && (Date.now() - encodeStartedAt) > encodeMaxMs) {
          fail(new Error(`encode exceeded ${(encodeMaxMs / 60000).toFixed(0)}min cap`));
        }
        // Fire an onProgress tick during encode so consumers that want
        // to advance a UI progress bar by elapsed time have something
        // to hook into — the encode phase otherwise sees zero callback
        // invocations because no bytes flow on either direction.
        if (phase === 'encode' && opts.onProgress) {
          try { opts.onProgress({ phase, bytesUp, bytesDown, totalUp: inputStat.size }); }
          catch {}
        }
      }, 5000);

      const tStart = Date.now();
      req = this._module(urlObj).request(reqOpts, (res) => {
        if (res.statusCode !== 200) {
          let errBuf = '';
          res.on('data', (d) => {
            errBuf += d.toString();
            if (errBuf.length > 8192) errBuf = errBuf.slice(-8192);
          });
          res.on('end', () => {
            fail(new Error(`worker HTTP ${res.statusCode}: ${errBuf.slice(0, 1024)}`));
          });
          return;
        }

        phase = 'download';
        lastProgressAt = Date.now();

        ws = fs.createWriteStream(outputPath);
        ws.on('error', (err) => fail(new Error(`output write failed: ${err.message}`)));

        res.on('data', (chunk) => {
          bytesDown += chunk.length;
          lastProgressAt = Date.now();
          if (opts.onProgress) {
            try { opts.onProgress({ phase, bytesUp, bytesDown, totalUp: inputStat.size }); }
            catch {}
          }
        });

        res.pipe(ws);

        ws.on('finish', () => {
          let outStat;
          try { outStat = fs.statSync(outputPath); }
          catch (e) { return fail(new Error(`output missing: ${e.message}`)); }
          if (outStat.size === 0) return fail(new Error('worker returned empty output'));

          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          cleaned = true;
          const encodeSec = Math.round((Date.now() - tStart) / 1000);
          resolve({
            inputBytes:  inputStat.size,
            outputBytes: outStat.size,
            encodeSec,
          });
        });
      });

      req.on('error', (err) => fail(new Error(`worker request failed: ${err.message}`)));
      // Disable Node's default socket idle timeout — we manage staleness
      // ourselves with the watchdog above.
      req.setTimeout(0);

      // Stream the input file as the request body. The watchdog above
      // catches a stalled Wi-Fi link and aborts the upload phase.
      rs = fs.createReadStream(inputPath);
      rs.on('data', (chunk) => {
        bytesUp += chunk.length;
        lastProgressAt = Date.now();
        if (opts.onProgress) {
          try { opts.onProgress({ phase, bytesUp, bytesDown, totalUp: inputStat.size }); }
          catch {}
        }
      });
      rs.on('error', (err) => fail(new Error(`input read failed: ${err.message}`)));
      rs.on('end', () => {
        // Upload complete — switch phase. The watchdog stops enforcing
        // the stall timeout until the response body starts arriving,
        // but the encode-max cap kicks in starting now.
        phase = 'encode';
        encodeStartedAt = Date.now();
        lastProgressAt = Date.now();
      });
      rs.pipe(req);
    });
  }
}

module.exports = { WorkerClient };
