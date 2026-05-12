/**
 * Tests for the pure helpers in lib/cast-manager.js.
 *
 * castv2-client is an optional dep; the module loads with a soft fallback
 * when it's missing. The escapeXml / extractXmlValue functions are pure
 * and do not depend on that — so importing here is safe regardless of
 * castv2-client presence.
 */

const test = require('node:test');
const assert = require('node:assert');
const { escapeXml, extractXmlValue } = require('../lib/cast-manager');

test('escapeXml — escapes the five XML metacharacters', () => {
  assert.strictEqual(escapeXml('<a href="x">b & c</a>'),
    '&lt;a href=&quot;x&quot;&gt;b &amp; c&lt;/a&gt;');
});

test('escapeXml — preserves plain text', () => {
  assert.strictEqual(escapeXml('Hello World 2024'), 'Hello World 2024');
});

test('escapeXml — handles apostrophes', () => {
  assert.strictEqual(escapeXml("it's"), 'it&apos;s');
});

test("escapeXml — & is escaped first so it doesn't double-escape", () => {
  // Naive replace order can produce &amp;lt; from <. Verify the implementation
  // already does & first by checking the canonical output for a mixed input.
  assert.strictEqual(escapeXml('<&>'), '&lt;&amp;&gt;');
});

test('extractXmlValue — basic tag', () => {
  assert.strictEqual(extractXmlValue('<friendlyName>Foo</friendlyName>', 'friendlyName'), 'Foo');
});

test('extractXmlValue — case-insensitive tag match', () => {
  assert.strictEqual(extractXmlValue('<FriendlyName>Bar</FriendlyName>', 'friendlyname'), 'Bar');
});

test('extractXmlValue — tag with attributes', () => {
  assert.strictEqual(extractXmlValue('<x ns:attr="v">value</x>', 'x'), 'value');
});

test('extractXmlValue — trims whitespace', () => {
  assert.strictEqual(extractXmlValue('<x>  hello  </x>', 'x'), 'hello');
});

test('extractXmlValue — missing tag returns null', () => {
  assert.strictEqual(extractXmlValue('<a>1</a>', 'b'), null);
});

test('extractXmlValue — empty tag body returns empty string after trim', () => {
  assert.strictEqual(extractXmlValue('<x></x>', 'x'), '');
});

test('extractXmlValue — multi-line XML', () => {
  const xml = `<root>
    <friendlyName>Living Room TV</friendlyName>
    <manufacturer>Acme</manufacturer>
  </root>`;
  assert.strictEqual(extractXmlValue(xml, 'friendlyName'), 'Living Room TV');
  assert.strictEqual(extractXmlValue(xml, 'manufacturer'), 'Acme');
});

test('extractXmlValue — first occurrence wins', () => {
  // Lazy match of [^<]* — first opening tag's content is captured.
  assert.strictEqual(extractXmlValue('<x>a</x><x>b</x>', 'x'), 'a');
});
