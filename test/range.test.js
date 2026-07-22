// ipfs-gate — Range header parser tests (node:test, pure — no Kubo/HTTP,
// same style as the pricing tests). Spec: BYTE-RANGE-DESIGN-NOTES.md §5.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');

const { parseRange } = require('../range');

const SIZE = 10000; // representative file size for most cases

test('no header → null (serve 200 full)', () => {
  assert.strictEqual(parseRange(undefined, SIZE), null);
  assert.strictEqual(parseRange(null, SIZE), null);
  assert.strictEqual(parseRange('', SIZE), null);
});

test('bytes=0-99 → {0, 99}', () => {
  assert.deepStrictEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 });
});

test('bytes=100- (open-ended) → {100, size-1}', () => {
  assert.deepStrictEqual(parseRange('bytes=100-', SIZE), { start: 100, end: SIZE - 1 });
});

test('bytes=-500 (suffix) → last 500 bytes', () => {
  assert.deepStrictEqual(parseRange('bytes=-500', SIZE), { start: SIZE - 500, end: SIZE - 1 });
});

test('suffix bigger than file → whole file {0, size-1}', () => {
  assert.deepStrictEqual(parseRange('bytes=-99999', SIZE), { start: 0, end: SIZE - 1 });
});

test('bytes=0- (the Chrome/Safari media probe) → {0, size-1}, NOT null', () => {
  assert.deepStrictEqual(parseRange('bytes=0-', SIZE), { start: 0, end: SIZE - 1 });
});

test('end beyond size-1 is clamped to size-1', () => {
  assert.deepStrictEqual(parseRange(`bytes=100-${SIZE + 5000}`, SIZE), { start: 100, end: SIZE - 1 });
});

test('start ≥ size → unsatisfiable (416)', () => {
  assert.deepStrictEqual(parseRange(`bytes=${SIZE}-`, SIZE), { unsatisfiable: true });
  assert.deepStrictEqual(parseRange(`bytes=${SIZE + 1}-${SIZE + 100}`, SIZE), { unsatisfiable: true });
});

test('bytes=-0 (zero-length suffix) → unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=-0', SIZE), { unsatisfiable: true });
});

test('multi-range → null (ignore, serve 200)', () => {
  assert.strictEqual(parseRange('bytes=0-99,200-299', SIZE), null);
});

test('malformed / inverted / wrong unit → null', () => {
  assert.strictEqual(parseRange('bytes=x', SIZE), null);        // non-numeric
  assert.strictEqual(parseRange('bytes=5-2', SIZE), null);      // a > b
  assert.strictEqual(parseRange('items=0-9', SIZE), null);      // non-bytes unit
  assert.strictEqual(parseRange('bytes=-', SIZE), null);        // bare dash
  assert.strictEqual(parseRange('bytes=1.5-9', SIZE), null);    // floats
  assert.strictEqual(parseRange('bytes=-5-9', SIZE), null);     // negative start
  assert.strictEqual(parseRange('0-99', SIZE), null);           // missing unit
});

test('edge: single-byte ranges and exact-end', () => {
  assert.deepStrictEqual(parseRange('bytes=0-0', SIZE), { start: 0, end: 0 });
  assert.deepStrictEqual(parseRange(`bytes=${SIZE - 1}-${SIZE - 1}`, SIZE), { start: SIZE - 1, end: SIZE - 1 });
});

test('edge: zero-length file — any range is unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=0-', 0), { unsatisfiable: true });
  assert.deepStrictEqual(parseRange('bytes=-500', 0), { unsatisfiable: true });
});
