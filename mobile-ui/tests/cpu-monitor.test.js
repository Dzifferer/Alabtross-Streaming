/**
 * Tests for CpuMonitor — the hysteresis + sustained-overload state machine.
 *
 * The OS-CPU snapshot is mocked via { snapshotFn } so we can deterministically
 * drive the percent computation. node:test's t.mock.timers lets us advance
 * the setInterval without sleeping.
 *
 * Reminder of the percent formula in CpuMonitor._tick:
 *   pct = round(100 * (1 - (idle_delta / total_delta)))
 * so a snapshot delta with idle = total gives 0% and idle = 0 gives 100%.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { CpuMonitor, clampPct } = require('../lib/cpu-monitor');

// Helper to build a snapshot pair: each call yields the running counters
// advanced by the chosen pct. Returns a snapshotFn closure to feed the monitor.
function pctFeed(initial = { idle: 0, total: 0 }) {
  let { idle, total } = initial;
  const queue = [];
  return {
    push(pct, deltaTotal = 100_000) {
      queue.push({ pct, deltaTotal });
    },
    snapshotFn() {
      if (queue.length === 0) return { idle, total };
      const { pct, deltaTotal } = queue.shift();
      const deltaIdle = Math.round(deltaTotal * (1 - pct / 100));
      idle += deltaIdle;
      total += deltaTotal;
      return { idle, total };
    },
  };
}

test('single-sample overload does NOT fire (sustainedMs not reached)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const feed = pctFeed();
  // Seed snapshot at 50% baseline.
  feed.push(50);
  // Then one sample at 99% — well under the 20s default sustainedMs.
  feed.push(99);
  const m = new CpuMonitor({
    snapshotFn: feed.snapshotFn,
    pauseThreshold: 90,
    resumeThreshold: 70,
    pollMs: 500,
    sustainedMs: 20_000,
  });
  let fired = false;
  m.on('overload', () => { fired = true; });
  m.start();
  // Advance 500ms — single tick. The tick samples 99%, starts the window,
  // but doesn't fire because 500ms < 20_000ms.
  t.mock.timers.tick(500);
  assert.equal(fired, false);
  m.stop();
});

test('sustained-overload window fires overload after sustainedMs', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const feed = pctFeed();
  feed.push(50);    // initial snap captured in start()
  // 12 ticks of 99% at 500ms each = 6 seconds — well over the 2s sustainedMs.
  for (let i = 0; i < 12; i++) feed.push(99);
  const m = new CpuMonitor({
    snapshotFn: feed.snapshotFn,
    pauseThreshold: 90,
    resumeThreshold: 70,
    pollMs: 500,
    sustainedMs: 2_000,
  });
  let firedPct = null;
  m.on('overload', ({ pct }) => { firedPct = pct; });
  m.start();
  // Advance enough ticks for the window to fully elapse.
  for (let i = 0; i < 12; i++) t.mock.timers.tick(500);
  assert.ok(firedPct !== null, 'overload should have fired');
  assert.ok(firedPct >= 90);
  m.stop();
});

test('single dip resets the sustained window', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const feed = pctFeed();
  feed.push(50);
  feed.push(99); feed.push(99); // window starts
  feed.push(40);                // dip — window resets
  feed.push(99); feed.push(99); feed.push(99); // restart, but only 1.5s elapsed
  const m = new CpuMonitor({
    snapshotFn: feed.snapshotFn,
    pauseThreshold: 90,
    resumeThreshold: 70,
    pollMs: 500,
    sustainedMs: 2_000,
  });
  let fired = false;
  m.on('overload', () => { fired = true; });
  m.start();
  for (let i = 0; i < 6; i++) t.mock.timers.tick(500);
  // The dip restarted the window, and the subsequent 3 ticks (1.5s) are
  // below the 2s sustainedMs ceiling → no fire.
  assert.equal(fired, false);
  m.stop();
});

test('resume threshold hysteresis — must drop below resumeThreshold', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const feed = pctFeed();
  feed.push(50);
  // Fire overload first.
  for (let i = 0; i < 8; i++) feed.push(99);
  // Then dip to JUST under pauseThreshold but above resumeThreshold
  // (between 70 and 90). Must NOT relieve.
  feed.push(80); feed.push(80); feed.push(80);
  // Finally drop below resumeThreshold → relieve.
  feed.push(60);
  const m = new CpuMonitor({
    snapshotFn: feed.snapshotFn,
    pauseThreshold: 90,
    resumeThreshold: 70,
    pollMs: 500,
    sustainedMs: 2_000,
  });
  const events = [];
  m.on('overload', () => events.push('overload'));
  m.on('relieved', () => events.push('relieved'));
  m.start();
  // 8 high ticks → overload.
  for (let i = 0; i < 8; i++) t.mock.timers.tick(500);
  assert.ok(events.includes('overload'));
  // 3 ticks at 80% (above resume) — must NOT relieve.
  events.length = 0;
  for (let i = 0; i < 3; i++) t.mock.timers.tick(500);
  assert.equal(events.includes('relieved'), false);
  // 1 tick at 60% — drops under resume → relieve.
  t.mock.timers.tick(500);
  assert.ok(events.includes('relieved'), 'should relieve only after dropping below resume threshold');
  m.stop();
});

test('updateConfig({ enabled: false }) while overloaded emits relieved', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const feed = pctFeed();
  feed.push(50);
  for (let i = 0; i < 8; i++) feed.push(99);
  const m = new CpuMonitor({
    snapshotFn: feed.snapshotFn,
    pauseThreshold: 90,
    resumeThreshold: 70,
    pollMs: 500,
    sustainedMs: 2_000,
  });
  let relieved = false;
  m.on('relieved', () => { relieved = true; });
  m.start();
  for (let i = 0; i < 8; i++) t.mock.timers.tick(500);
  assert.equal(m.isOverloaded(), true);
  // Flip the kill switch — should emit relieved.
  m.updateConfig({ enabled: false });
  assert.equal(relieved, true);
  m.stop();
});

test('_ensureHysteresis enforces 10-point gap', () => {
  const m = new CpuMonitor({
    pauseThreshold: 80,
    resumeThreshold: 80,     // equal → should be pushed down
  });
  assert.ok(m.getResumeThreshold() < m.getPauseThreshold());
  assert.ok(m.getPauseThreshold() - m.getResumeThreshold() >= 10);
});

test('clampPct bounds inputs to [1, 100]', () => {
  assert.equal(clampPct(50, 99), 50);
  assert.equal(clampPct(0, 99), 1);    // floor 1
  assert.equal(clampPct(-100, 99), 1);
  assert.equal(clampPct(150, 99), 100); // ceiling 100
  assert.equal(clampPct('abc', 99), 99); // NaN → fallback
});

test('getCurrentPct reflects latest sample', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const feed = pctFeed();
  feed.push(50);
  feed.push(35);
  const m = new CpuMonitor({
    snapshotFn: feed.snapshotFn,
    pauseThreshold: 90,
    resumeThreshold: 70,
    pollMs: 500,
    sustainedMs: 20_000,
  });
  m.start();
  t.mock.timers.tick(500);
  // First tick after start consumes the second queued sample → pct=35.
  assert.equal(m.getCurrentPct(), 35);
  m.stop();
});
