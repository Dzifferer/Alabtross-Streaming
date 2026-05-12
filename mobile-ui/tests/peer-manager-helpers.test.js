/**
 * Tests for the standalone helpers exported by lib/peer-manager.js
 * (ipOf, isBogusAddr). These guard the BitTorrent peer-intake path:
 * a bug here either lets bogus peers spam reputation strikes or silently
 * drops good peers. Tracker payloads occasionally contain
 * unspecified/loopback/broadcast addresses, so the rejection rules need
 * to be airtight.
 */

const test = require('node:test');
const assert = require('node:assert');
const { ipOf, isBogusAddr } = require('../lib/peer-manager');

test('ipOf — IPv4 host:port', () => {
  assert.strictEqual(ipOf('1.2.3.4:6881'), '1.2.3.4');
  assert.strictEqual(ipOf('192.168.1.50:51413'), '192.168.1.50');
});

test('ipOf — string without colon returns the input', () => {
  assert.strictEqual(ipOf('1.2.3.4'), '1.2.3.4');
});

test('ipOf — non-string input returns null', () => {
  assert.strictEqual(ipOf(undefined), null);
  assert.strictEqual(ipOf(null), null);
  assert.strictEqual(ipOf(12345), null);
  assert.strictEqual(ipOf({}), null);
});

test('isBogusAddr — accepts a well-formed public peer', () => {
  assert.strictEqual(isBogusAddr('8.8.8.8:6881'), false);
  assert.strictEqual(isBogusAddr('203.0.113.42:51413'), false);
});

test('isBogusAddr — rejects 0.0.0.0', () => {
  assert.strictEqual(isBogusAddr('0.0.0.0:6881'), true);
});

test('isBogusAddr — rejects broadcast', () => {
  assert.strictEqual(isBogusAddr('255.255.255.255:6881'), true);
});

test('isBogusAddr — rejects loopback', () => {
  assert.strictEqual(isBogusAddr('127.0.0.1:8080'), true);
  assert.strictEqual(isBogusAddr('localhost:6881'), true);
});

test('isBogusAddr — rejects port 0', () => {
  assert.strictEqual(isBogusAddr('1.2.3.4:0'), true);
});

test('isBogusAddr — rejects port > 65535', () => {
  assert.strictEqual(isBogusAddr('1.2.3.4:65536'), true);
  assert.strictEqual(isBogusAddr('1.2.3.4:99999'), true);
});

test('isBogusAddr — rejects non-numeric port', () => {
  assert.strictEqual(isBogusAddr('1.2.3.4:abcd'), true);
});

test('isBogusAddr — rejects missing colon', () => {
  assert.strictEqual(isBogusAddr('1.2.3.4'), true);
  assert.strictEqual(isBogusAddr('localhost'), true);
});

test('isBogusAddr — rejects empty string', () => {
  assert.strictEqual(isBogusAddr(''), true);
});

test('isBogusAddr — rejects non-string', () => {
  assert.strictEqual(isBogusAddr(null), true);
  assert.strictEqual(isBogusAddr(undefined), true);
  assert.strictEqual(isBogusAddr(12345), true);
  assert.strictEqual(isBogusAddr({}), true);
});

test('isBogusAddr — accepts boundary ports 1 and 65535', () => {
  assert.strictEqual(isBogusAddr('1.2.3.4:1'), false);
  assert.strictEqual(isBogusAddr('1.2.3.4:65535'), false);
});
