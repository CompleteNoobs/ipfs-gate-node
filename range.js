// ipfs-gate — HTTP Range header parsing for GET /ipfs/:cid (byte-range/seek).
// Pure module, no I/O — fully unit-testable in isolation (same pattern as
// pricing.js). DESIGN LOCKED: BYTE-RANGE-DESIGN-NOTES.md.
//
// Deliberately minimal per RFC 9110: only the `bytes` unit, exactly one range
// spec. Anything else (multi-range, other units, malformed) → null, and the
// caller serves a plain 200 full response — which RFC 9110 explicitly allows.

/**
 * parseRange(header, size) →
 *   null                    — no/ignorable Range (missing, malformed,
 *                             multi-range, non-bytes unit) → serve 200 full
 *   { unsatisfiable: true } — start ≥ size (or suffix of 0) → 416
 *   { start, end }          — inclusive byte bounds, end clamped to size-1 → 206
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || !Number.isFinite(size) || size < 0) return null;

  const m = header.match(/^bytes=(.+)$/);
  if (!m) return null;                       // wrong/missing unit
  const spec = m[1].trim();
  if (spec.includes(',')) return null;       // multi-range → ignore, serve 200

  // Three forms: `a-b`, `a-`, `-suffix`. Digits only — no signs, no floats.
  const parts = spec.match(/^(\d*)-(\d*)$/);
  if (!parts) return null;
  const [, rawStart, rawEnd] = parts;

  if (rawStart === '' && rawEnd === '') return null; // bare `-`

  if (rawStart === '') {
    // Suffix form `-N`: the LAST N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return { unsatisfiable: true }; // zero bytes to name
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return { unsatisfiable: true };

  if (rawEnd === '') {
    // Open-ended `a-`: from a to EOF.
    return { start, end: size - 1 };
  }

  const end = Number(rawEnd);
  if (start > end) return null;              // inverted → ignore, serve 200
  return { start, end: Math.min(end, size - 1) };
}

module.exports = { parseRange };
