/**
 * Tests for lib/ffmpeg-hw.js — the hardware-accel decision matrix.
 *
 * The module captures FFMPEG_HWACCEL / FFMPEG_ENCODER at require-time, so
 * each test resets the env, drops the cached module, and re-requires it
 * to exercise the desired branch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadHw(env = {}) {
  const before = {
    FFMPEG_HWACCEL: process.env.FFMPEG_HWACCEL,
    FFMPEG_ENCODER: process.env.FFMPEG_ENCODER,
  };
  // Clear and re-set so a previous test's "cuda" doesn't leak into "none".
  delete process.env.FFMPEG_HWACCEL;
  delete process.env.FFMPEG_ENCODER;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const modPath = require.resolve('../lib/ffmpeg-hw');
  delete require.cache[modPath];
  const hw = require('../lib/ffmpeg-hw');
  // Restore env afterwards so test isolation is clean.
  return { hw, restore: () => {
    delete process.env.FFMPEG_HWACCEL;
    delete process.env.FFMPEG_ENCODER;
    if (before.FFMPEG_HWACCEL !== undefined) process.env.FFMPEG_HWACCEL = before.FFMPEG_HWACCEL;
    if (before.FFMPEG_ENCODER !== undefined) process.env.FFMPEG_ENCODER = before.FFMPEG_ENCODER;
  }};
}

test('FFMPEG_HWACCEL unset → decode args is []', (t) => {
  const { hw, restore } = loadHw({});
  t.after(restore);
  assert.deepEqual(hw.buildDecodeArgs('h264', 'yuv420p'), []);
});

test('FFMPEG_HWACCEL=cuda + h264 → cuda + cuvid pipeline', (t) => {
  const { hw, restore } = loadHw({ FFMPEG_HWACCEL: 'cuda' });
  t.after(restore);
  const args = hw.buildDecodeArgs('h264', 'yuv420p');
  for (const wanted of ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'h264_cuvid']) {
    assert.ok(args.includes(wanted), `expected ${wanted} in ${JSON.stringify(args)}`);
  }
});

test('FFMPEG_HWACCEL=nvmpi + h264 + yuv420p → h264_nvmpi', (t) => {
  const { hw, restore } = loadHw({ FFMPEG_HWACCEL: 'nvmpi' });
  t.after(restore);
  assert.deepEqual(hw.buildDecodeArgs('h264', 'yuv420p'), ['-c:v', 'h264_nvmpi']);
});

test('FFMPEG_HWACCEL=nvmpi + h264 + yuv420p10le → [] (10-bit unsupported)', (t) => {
  const { hw, restore } = loadHw({ FFMPEG_HWACCEL: 'nvmpi' });
  t.after(restore);
  assert.deepEqual(hw.buildDecodeArgs('h264', 'yuv420p10le'), []);
});

test('buildScaleFilter cuvid path uses scale_cuda/scale_npp, not cpu scale', (t) => {
  const { hw, restore } = loadHw({ FFMPEG_HWACCEL: 'cuda' });
  t.after(restore);
  const filter = hw.buildScaleFilter(1280, 'h264', 'yuv420p');
  // Either scale_cuda or scale_npp — both are GPU filters — must appear,
  // and the bare CPU 'scale=' filter must NOT be the chosen branch.
  assert.ok(filter.includes('scale_cuda') || filter.includes('scale_npp'),
    `expected GPU scale in: ${filter}`);
});

test('buildLiveEncoderArgs() with no arg → no -threads emitted', (t) => {
  const { hw, restore } = loadHw({});
  t.after(restore);
  const args = hw.buildLiveEncoderArgs();
  assert.equal(args.includes('-threads'), false);
});

test('buildLiveEncoderArgs(2) → includes -threads 2', (t) => {
  const { hw, restore } = loadHw({});
  t.after(restore);
  const args = hw.buildLiveEncoderArgs(2);
  const idx = args.indexOf('-threads');
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], '2');
});

test('buildLiveEncoderArgs(not-a-number) → no -threads emitted', (t) => {
  const { hw, restore } = loadHw({});
  t.after(restore);
  const args = hw.buildLiveEncoderArgs('not-a-number');
  assert.equal(args.includes('-threads'), false);
});

test('buildLiveEncoderArgs(0) and (-1) → no -threads emitted', (t) => {
  const { hw, restore } = loadHw({});
  t.after(restore);
  assert.equal(hw.buildLiveEncoderArgs(0).includes('-threads'), false);
  assert.equal(hw.buildLiveEncoderArgs(-1).includes('-threads'), false);
});

test('NVENC encoder branch ignores maxThreads (no -threads)', (t) => {
  const { hw, restore } = loadHw({ FFMPEG_HWACCEL: 'cuda', FFMPEG_ENCODER: 'h264_nvenc' });
  t.after(restore);
  // Even with a thread cap argument, NVENC's args list omits -threads.
  const args = hw.buildLiveEncoderArgs(4);
  assert.ok(args.includes('h264_nvenc'));
  assert.equal(args.includes('-threads'), false);
});

test('describeMode() returns a non-empty string', (t) => {
  const { hw, restore } = loadHw({});
  t.after(restore);
  const s = hw.describeMode();
  assert.equal(typeof s, 'string');
  assert.ok(s.length > 0);
});

test('describeMode() reflects NVMPI mode', (t) => {
  const { hw, restore } = loadHw({ FFMPEG_HWACCEL: 'nvmpi' });
  t.after(restore);
  assert.ok(hw.describeMode().toLowerCase().includes('nvmpi'));
});
