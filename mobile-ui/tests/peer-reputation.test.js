/**
 * Tests for PeerReputation: the cross-torrent peer scoring map.
 *
 * Constructed with { skipLoad: true, now } so each test starts from a
 * deterministic empty state with an injected clock. Real disk I/O is
 * still exercised via save() / fresh-instance round-trip on the few
 * persistence-targeting cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { PeerReputation } = require('../lib/peer-reputation');
const { withTmpDir } = require('./helpers/tmpdir');

const ONE_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // arbitrary fixed timestamp
const KB = 1024;

function makeRep(t, overrides = {}) {
  const dir = withTmpDir(t);
  let clock = overrides.now || NOW;
  const rep = new PeerReputation({
    cacheDir: dir,
    skipLoad: true,
    now: typeof overrides.now === 'function' ? overrides.now : () => clock,
  });
  return { rep, dir, setNow: (n) => { clock = n; } };
}

test('recordDelivery — accumulates goodBytes', (t) => {
  const { rep } = makeRep(t);
  rep.recordDelivery('1.2.3.4:6881', 1000);
  rep.recordDelivery('1.2.3.4:6881', 2000);
  // Internal lookup — exercise topGoodAddrs as a public read instead of
  // poking at _entries directly. Below threshold (256 KiB) means topGood
  // won't surface it; bump up to exceed:
  rep.recordDelivery('1.2.3.4:6881', 300 * KB);
  const top = rep.topGoodAddrs(10);
  assert.deepEqual(top, ['1.2.3.4:6881']);
});

test('recordStrike — 3 strikes with <256KB goodBytes appears in knownBadIps', (t) => {
  const { rep } = makeRep(t);
  rep.recordStrike('5.6.7.8:6881');
  rep.recordStrike('5.6.7.8:6881');
  // Two strikes shouldn't ban yet.
  assert.equal(rep.knownBadIps().has('5.6.7.8'), false);
  rep.recordStrike('5.6.7.8:6881');
  // 3 strikes, no offsetting good-bytes → banned.
  assert.equal(rep.knownBadIps().has('5.6.7.8'), true);
});

test('flaky-peer carve-out: 3 strikes + goodBytes >= 256KB does NOT pre-block', (t) => {
  const { rep } = makeRep(t);
  rep.recordDelivery('9.9.9.9:6881', 512 * KB);
  // recordDelivery decays a strike per call, so push past that with extra
  // strikes after the delivery completes.
  rep.recordStrike('9.9.9.9:6881');
  rep.recordStrike('9.9.9.9:6881');
  rep.recordStrike('9.9.9.9:6881');
  assert.equal(rep.knownBadIps().has('9.9.9.9'), false,
    'flaky-but-productive peer should be retried, not pre-blocked');
});

test('topGoodAddrs — sorts desc + respects limit, excludes <256KB', (t) => {
  const { rep } = makeRep(t);
  rep.recordDelivery('a.b.c.d:1', 1 * 1024 * 1024); // 1 MB
  rep.recordDelivery('a.b.c.d:2', 2 * 1024 * 1024); // 2 MB
  rep.recordDelivery('a.b.c.d:3', 100 * KB);        // below threshold
  rep.recordDelivery('a.b.c.d:4', 4 * 1024 * 1024); // 4 MB
  const top3 = rep.topGoodAddrs(3);
  assert.deepEqual(top3, ['a.b.c.d:4', 'a.b.c.d:2', 'a.b.c.d:1']);
  const top2 = rep.topGoodAddrs(2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0], 'a.b.c.d:4');
});

test('stale entry drop on load — entries older than 14 days are removed', (t) => {
  const dir = withTmpDir(t);
  // Write a hand-rolled JSON snapshot with one stale entry and one fresh.
  const file = path.join(dir, 'peer-reputation.json');
  const stale = NOW - 15 * ONE_DAY;
  const fresh = NOW - 1 * ONE_DAY;
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    savedAt: NOW,
    entries: {
      '1.1.1.1:1': { goodBytes: 1024 * 1024, strikes: 0, lastSeenAt: stale },
      '2.2.2.2:2': { goodBytes: 1024 * 1024, strikes: 0, lastSeenAt: fresh },
    },
  }));
  // Load with the injected clock at NOW.
  const rep = new PeerReputation({ cacheDir: dir, now: () => NOW });
  const top = rep.topGoodAddrs(10);
  // 1.1.1.1 was 15 days old → dropped. 2.2.2.2 was 1 day old → kept.
  assert.deepEqual(top, ['2.2.2.2:2']);
});

test('MAX_ENTRIES LRU eviction — oldest dropped when over the cap', (t) => {
  // Verify boundary behavior by burning a large fraction of MAX_ENTRIES.
  // We don't push 10_001 entries (slow); instead introspect _entries.size
  // after a deliberately-crafted small cap scenario via touch + delete.
  const { rep, setNow } = makeRep(t);
  // Sample at increasing timestamps so eviction is deterministic.
  for (let i = 0; i < 5; i++) {
    setNow(NOW + i);
    rep.recordDelivery(`10.0.0.${i}:1`, 100); // small delivery to seed entries
  }
  // Manually fake the cap to test the eviction loop without 10k entries.
  // _evictOldest() is the unit under test here.
  const initialSize = rep._entries.size;
  assert.equal(initialSize, 5);
  // Force-evict twice; the two oldest (lowest i) should be the first to go.
  rep._evictOldest();
  rep._evictOldest();
  assert.equal(rep._entries.size, 3);
  assert.equal(rep._entries.has('10.0.0.0:1'), false);
  assert.equal(rep._entries.has('10.0.0.1:1'), false);
  assert.equal(rep._entries.has('10.0.0.4:1'), true);
});

test('persistence round-trip — fresh instance against same cacheDir restores entries', async (t) => {
  const dir = withTmpDir(t);
  const rep1 = new PeerReputation({ cacheDir: dir, skipLoad: true, now: () => NOW });
  rep1.recordDelivery('7.7.7.7:6881', 1024 * 1024);
  rep1.recordStrike('8.8.8.8:6881');
  await rep1.save();
  // New instance with default load path — should pick up the saved entries.
  const rep2 = new PeerReputation({ cacheDir: dir, now: () => NOW });
  // Verify via the public surface: top peer should be 7.7.7.7.
  const top = rep2.topGoodAddrs(10);
  assert.deepEqual(top, ['7.7.7.7:6881']);
});

test('atomic write — .tmp file is gone after save() completes', async (t) => {
  const dir = withTmpDir(t);
  const rep = new PeerReputation({ cacheDir: dir, skipLoad: true, now: () => NOW });
  rep.recordDelivery('3.3.3.3:6881', 1024 * 1024);
  await rep.save();
  const tmpPath = path.join(dir, 'peer-reputation.json.tmp');
  assert.equal(fs.existsSync(tmpPath), false, '.tmp file should be renamed away');
  assert.equal(fs.existsSync(path.join(dir, 'peer-reputation.json')), true);
});

test('malformed JSON on load — falls back cleanly', (t) => {
  const dir = withTmpDir(t);
  fs.writeFileSync(path.join(dir, 'peer-reputation.json'), '{not valid json');
  // Should NOT throw.
  const rep = new PeerReputation({ cacheDir: dir, now: () => NOW });
  // Empty after failed load.
  assert.equal(rep.topGoodAddrs(10).length, 0);
});

test('invalid addr keys and bogus lastSeenAt on load — skipped', (t) => {
  const dir = withTmpDir(t);
  fs.writeFileSync(path.join(dir, 'peer-reputation.json'), JSON.stringify({
    version: 1,
    entries: {
      'not-an-addr':            { goodBytes: 1e6, strikes: 0, lastSeenAt: NOW - 1 },
      '999.999.999.999:abc':    { goodBytes: 1e6, strikes: 0, lastSeenAt: NOW - 1 },
      '1.2.3.4:5678':           { goodBytes: 1e6, strikes: 0, lastSeenAt: 'oops' },
      '5.6.7.8:1234':           { goodBytes: 1e6, strikes: 0, lastSeenAt: NOW - 1 },
    },
  }));
  const rep = new PeerReputation({ cacheDir: dir, now: () => NOW });
  // Only the well-formed addr + valid lastSeenAt entry survives.
  assert.deepEqual(rep.topGoodAddrs(10), ['5.6.7.8:1234']);
});

test('recordDelivery — successful delivery decays one strike', (t) => {
  const { rep } = makeRep(t);
  rep.recordStrike('4.4.4.4:1');
  rep.recordStrike('4.4.4.4:1');
  rep.recordStrike('4.4.4.4:1');
  // 3 strikes, banned.
  assert.ok(rep.knownBadIps().has('4.4.4.4'));
  // A successful delivery decays one strike → now at 2 → not banned.
  rep.recordDelivery('4.4.4.4:1', 100);
  assert.equal(rep.knownBadIps().has('4.4.4.4'), false);
});

test('stats() — diagnostic snapshot reports counts', (t) => {
  const { rep } = makeRep(t);
  rep.recordDelivery('1.1.1.1:1', 1024 * 1024);
  rep.recordStrike('2.2.2.2:2');
  rep.recordStrike('2.2.2.2:2');
  rep.recordStrike('2.2.2.2:2');
  const s = rep.stats();
  assert.equal(s.entries, 2);
  assert.equal(s.good, 1);
  assert.equal(s.bad, 1);
  assert.ok(s.totalGoodBytes >= 1024 * 1024);
});
