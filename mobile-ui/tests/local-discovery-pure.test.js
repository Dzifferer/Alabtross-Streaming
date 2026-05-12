/**
 * Tests for the pure helpers in lib/local-discovery.js.
 * SSDP/UDP discovery itself touches a real socket and isn't covered
 * here — these tests target parseSSDPResponse, extractXmlTag, and
 * isLocationSafe, all of which are side-effect-free string functions.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  parseSSDPResponse,
  extractXmlTag,
  isLocationSafe,
} = require('../lib/local-discovery');

const SSDP_DATAGRAM = Buffer.from([
  'HTTP/1.1 200 OK',
  'CACHE-CONTROL: max-age=1800',
  'LOCATION: http://192.168.1.50:8080/desc.xml',
  'SERVER: Linux/3.4 UPnP/1.0 BubbleUPnP/3.4.4',
  'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
  'USN: uuid:abc-def::urn:schemas-upnp-org:device:MediaRenderer:1',
  'EXT:',
  '',
  '',
].join('\r\n'));

test('parseSSDPResponse — extracts standard headers', () => {
  const h = parseSSDPResponse(SSDP_DATAGRAM);
  assert.strictEqual(h.location, 'http://192.168.1.50:8080/desc.xml');
  assert.strictEqual(h.st, 'urn:schemas-upnp-org:device:MediaRenderer:1');
  assert.ok(h.usn.startsWith('uuid:'));
});

test('parseSSDPResponse — headers are case-insensitive (lower-cased on parse)', () => {
  const msg = Buffer.from('HTTP/1.1 200 OK\r\nMixedCase: Hello\r\n\r\n');
  const h = parseSSDPResponse(msg);
  assert.strictEqual(h.mixedcase, 'Hello');
});

test('parseSSDPResponse — values preserve internal colons', () => {
  // Standard SSDP USN headers contain "uuid:xxx::urn:..." with multiple
  // colons. parseSSDPResponse must only split on the FIRST colon.
  const h = parseSSDPResponse(SSDP_DATAGRAM);
  assert.ok(h.usn.includes('::urn:'));
});

test('parseSSDPResponse — empty / malformed input is safe', () => {
  assert.deepStrictEqual(parseSSDPResponse(Buffer.from('')), {});
  assert.deepStrictEqual(parseSSDPResponse(Buffer.from('garbage')), {});
});

test('extractXmlTag — simple', () => {
  assert.strictEqual(extractXmlTag('<friendlyName>Living Room</friendlyName>', 'friendlyName'), 'Living Room');
});

test('extractXmlTag — case-insensitive', () => {
  assert.strictEqual(extractXmlTag('<FRIENDLYNAME>X</FRIENDLYNAME>', 'friendlyname'), 'X');
});

test('extractXmlTag — handles attributes on opening tag', () => {
  assert.strictEqual(extractXmlTag('<modelName lang="en">Roku</modelName>', 'modelName'), 'Roku');
});

test('extractXmlTag — missing tag returns null', () => {
  assert.strictEqual(extractXmlTag('<a>1</a>', 'b'), null);
});

test('isLocationSafe — accepts public LAN HTTP URL', () => {
  assert.strictEqual(isLocationSafe('http://192.168.1.50:8080/desc.xml'), true);
});

test('isLocationSafe — rejects loopback', () => {
  assert.strictEqual(isLocationSafe('http://127.0.0.1/'), false);
  assert.strictEqual(isLocationSafe('http://localhost/'), false);
  assert.strictEqual(isLocationSafe('http://[::1]/'), false);
});

test('isLocationSafe — rejects link-local (incl. cloud IMDS prefix)', () => {
  assert.strictEqual(isLocationSafe('http://169.254.169.254/'), false);
});

test('isLocationSafe — rejects IPv4-mapped IPv6 loopback / link-local', () => {
  // Hostname form, not literal-bracketed
  assert.strictEqual(isLocationSafe('http://::ffff:127.0.0.1/'), false);
  assert.strictEqual(isLocationSafe('http://::ffff:169.254.169.254/'), false);
});

test('isLocationSafe — rejects non-http schemes', () => {
  assert.strictEqual(isLocationSafe('file:///etc/passwd'), false);
  assert.strictEqual(isLocationSafe('gopher://1.2.3.4/'), false);
  assert.strictEqual(isLocationSafe('ftp://1.2.3.4/'), false);
});

test('isLocationSafe — rejects privileged ports below 1024 except 80/443', () => {
  assert.strictEqual(isLocationSafe('http://1.2.3.4:22/'), false);
  assert.strictEqual(isLocationSafe('http://1.2.3.4:25/'), false);
  // 80/443 explicitly allowed
  assert.strictEqual(isLocationSafe('http://1.2.3.4/'), true);
  assert.strictEqual(isLocationSafe('https://1.2.3.4/'), true);
});

test('isLocationSafe — malformed URLs are rejected', () => {
  assert.strictEqual(isLocationSafe('not a url'), false);
  assert.strictEqual(isLocationSafe(''), false);
  assert.strictEqual(isLocationSafe(null), false);
});
