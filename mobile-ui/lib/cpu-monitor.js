/**
 * Albatross — CPU Monitor (hardware protection)
 *
 * Samples aggregate CPU usage on a short interval and emits 'overload' /
 * 'relieved' events with hysteresis. LibraryManager consumes these to kill
 * running local ffmpeg conversions when CPU gets too hot and block new ones
 * from starting until the box cools off. Remote (GPU-worker) conversions
 * are out of scope — they don't burn Orin CPU.
 *
 * Hysteresis is intentional: a single pauseThreshold would bounce the queue
 * on every ffmpeg start (libx264 spikes from ~10% idle to 100% in <1s),
 * killing and restarting the same job forever. Separate pause / resume
 * thresholds give the system time to actually cool between transitions.
 */
const os = require('os');
const EventEmitter = require('events');

function snapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

class CpuMonitor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._enabled = opts.enabled !== false;
    // Pause when sustained usage exceeds this %. 90 is tight enough to
    // catch true overload but loose enough that a short download spike
    // doesn't trigger.
    this._pauseThreshold = clampPct(opts.pauseThreshold, 90);
    // Resume when usage drops below this %. Must be meaningfully less
    // than pauseThreshold so we don't flap.
    this._resumeThreshold = clampPct(opts.resumeThreshold, 70);
    this._ensureHysteresis();
    // 3s gives a decent signal-to-noise on a Jetson-class box without
    // burning measurable CPU of our own.
    this._pollMs = Math.max(500, Math.min(60000, opts.pollMs || 3000));
    this._timer = null;
    this._lastSnap = null;
    this._currentPct = 0;
    this._overloaded = false;
  }

  start() {
    if (this._timer) return;
    this._lastSnap = snapshot();
    this._timer = setInterval(() => this._tick(), this._pollMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  getCurrentPct() { return this._currentPct; }
  isOverloaded() { return this._enabled && this._overloaded; }
  isEnabled() { return this._enabled; }
  getPauseThreshold() { return this._pauseThreshold; }
  getResumeThreshold() { return this._resumeThreshold; }

  getConfig() {
    return {
      enabled: this._enabled,
      pauseThreshold: this._pauseThreshold,
      resumeThreshold: this._resumeThreshold,
      pollMs: this._pollMs,
    };
  }

  /**
   * Live update — callers use this from the settings endpoint. If the
   * monitor is turned off mid-overload, we emit 'relieved' so consumers
   * can resume work they had paused.
   */
  updateConfig(opts = {}) {
    const wasEnabled = this._enabled;
    const wasOverloaded = this._overloaded;
    if (typeof opts.enabled === 'boolean') this._enabled = opts.enabled;
    if (opts.pauseThreshold != null) this._pauseThreshold = clampPct(opts.pauseThreshold, this._pauseThreshold);
    if (opts.resumeThreshold != null) this._resumeThreshold = clampPct(opts.resumeThreshold, this._resumeThreshold);
    this._ensureHysteresis();
    if (wasEnabled && !this._enabled && wasOverloaded) {
      this._overloaded = false;
      this.emit('relieved', { pct: this._currentPct, reason: 'disabled' });
    }
    return this.getConfig();
  }

  _ensureHysteresis() {
    // Guarantee resume is at least 10 points below pause so a noisy reading
    // doesn't bounce us in and out on every tick.
    if (this._resumeThreshold >= this._pauseThreshold) {
      this._resumeThreshold = Math.max(10, this._pauseThreshold - 10);
    }
  }

  _tick() {
    const next = snapshot();
    const idleDelta = next.idle - this._lastSnap.idle;
    const totalDelta = next.total - this._lastSnap.total;
    this._lastSnap = next;
    if (totalDelta <= 0) return;
    const pct = Math.round(100 * (1 - idleDelta / totalDelta));
    this._currentPct = pct;
    if (!this._enabled) return;

    if (!this._overloaded && pct >= this._pauseThreshold) {
      this._overloaded = true;
      console.warn(`[CPU] Overload detected (${pct}% ≥ ${this._pauseThreshold}%) — pausing conversions to protect hardware`);
      this.emit('overload', { pct, threshold: this._pauseThreshold });
    } else if (this._overloaded && pct <= this._resumeThreshold) {
      this._overloaded = false;
      console.log(`[CPU] Overload cleared (${pct}% ≤ ${this._resumeThreshold}%) — conversions may resume`);
      this.emit('relieved', { pct, threshold: this._resumeThreshold });
    }
  }
}

function clampPct(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(100, Math.round(v)));
}

module.exports = { CpuMonitor };
