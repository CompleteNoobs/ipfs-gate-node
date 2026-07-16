// ipfs-gate v1 — HOSTING_MODE=permanent tests.
// Permanent hosting represents "host until owner/admin unpins" as a far-future
// sentinel expiry_ts (schema columns are NOT NULL, so no NULL). These tests
// prove the primitives the /reserve + /upload permanent branch rests on:
//   - pricing.isPermanent() recognises the sentinel (and only it),
//   - a permanent claim/pin is NEVER swept while a timed-expired one IS,
//   - refund math returns 0 for a permanent claim (no time to pro-rate),
//   - isPermanent gates the /claims/extend rejection.
// The HTTP layer (reserve/upload/own-copy branches, extend 409) is boot-smoked
// live per the repo convention — see the deploy verification.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = TMP_DB;

const quota = require('../quota');
const pricing = require('../pricing');

const db = quota.open();
quota.runMigrations();

process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

// Build a claim directly, the way /upload does, with a caller-chosen expiry.
let n = 0;
function makeClaim({ owner, expiryTs, paidHours, cid = null }) {
  cid = cid || ('Qm' + crypto.randomBytes(8).toString('hex'));
  const resv = quota.createReservation(owner, 5_000_000, 'public', { hoursRequested: paidHours, copies: 1, quotedAmount: 0 });
  const txId = `perm_${++n}_${crypto.randomBytes(4).toString('hex')}`;
  const payment = quota.recordPayment({
    tx_id: txId, reservation_id: resv.id, uploader: owner, currency: 'TEST',
    amount: 0, memo: quota.getMemoForReservation(resv.id), block_num: null, status: 'confirmed'
  });
  quota.markReservationPaid(resv.id, txId);
  const startTs = quota.now();
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: 5_000_000, payment_id: payment.id, expires_at: expiryTs });
  quota.markReservationUploaded(resv.id, pin.id);
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id,
    sizeBytes: 5_000_000, sizeMB: pricing.billableMB(5_000_000), rateLocked: 0,
    paidHours, copies: 1, amountPaid: 0, currency: 'TEST', startTs, expiryTs
  });
  return { claim_id, cid, pin_id: pin.id };
}

// ─── the sentinel predicate ──────────────────────────────────────────────────

test('isPermanent recognises the sentinel and nothing normal', () => {
  assert.equal(pricing.isPermanent(pricing.PERMANENT_EXPIRY_TS), true);
  assert.equal(pricing.isPermanent(pricing.PERMANENT_EXPIRY_TS + 1), true);
  assert.equal(pricing.isPermanent(Date.now()), false);
  assert.equal(pricing.isPermanent(Date.now() + 365 * 24 * 3600 * 1000), false, 'even a year out is not permanent');
});

// ─── the sweeper never expires a permanent claim ─────────────────────────────

test('sweep expires a timed claim past its clock but leaves a permanent one active', () => {
  // Timed claim already expired (expiry in the past).
  const timed = makeClaim({ owner: 'timedowner', expiryTs: quota.now() - 1000, paidHours: 1 });
  // Permanent claim (far-future sentinel).
  const perm = makeClaim({ owner: 'permowner', expiryTs: pricing.PERMANENT_EXPIRY_TS, paidHours: pricing.MIN_HOURS });

  const result = quota.sweep();

  assert.equal(quota.getClaim(timed.claim_id).state, 'expired', 'timed claim swept');
  assert.equal(quota.getClaim(perm.claim_id).state, 'active', 'permanent claim untouched');
  // And its pin stays active (would otherwise be a candidate for unpin/GC).
  const permPin = db.prepare('SELECT status FROM pins WHERE id = ?').get(perm.pin_id);
  assert.equal(permPin.status, 'active', 'permanent pin still active');
  assert.ok(result.expired_claims >= 1, 'at least the timed claim expired this tick');
  assert.ok(!result.cids_to_unpin.includes(perm.cid), 'permanent CID never queued for unpin');
});

// ─── refund is 0 for a permanent claim ───────────────────────────────────────

test('calculateRefund returns 0/dust for a permanent claim regardless of paid_hours', () => {
  // Even with a large paid_hours, a permanent claim has no time to pro-rate.
  const r = pricing.calculateRefund({
    expiry_ts: pricing.PERMANENT_EXPIRY_TS, start_ts: Date.now(),
    paid_hours: 999999, rate_locked: 1, copies_requested: 1, size_bytes: 5_000_000
  });
  assert.equal(r.amount, 0);
  assert.equal(r.dust, true);
  assert.equal(r.permanent, true);
});

test('forcedRefundAmount (active offender, prorata) is 0 for a permanent claim', () => {
  const amt = pricing.forcedRefundAmount(
    { state: 'active', expiry_ts: pricing.PERMANENT_EXPIRY_TS, start_ts: Date.now(),
      paid_hours: 100, rate_locked: 1, copies_requested: 1, size_bytes: 5_000_000 },
    { policy: 'prorata', innocent: false }
  );
  assert.equal(amt, 0);
});

// ─── a timed claim still refunds normally (no regression) ────────────────────

test('a normal timed claim still pro-rates a refund (permanent guard is scoped)', () => {
  const now = Date.now();
  const r = pricing.calculateRefund(
    { expiry_ts: now + 100 * pricing.HOUR_MS, start_ts: now, paid_hours: 100,
      rate_locked: 1, copies_requested: 1, size_bytes: 5_000_000 },
    now + 10 * pricing.HOUR_MS   // 10h used of 100h
  );
  assert.equal(r.permanent, undefined);
  assert.ok(r.amount > 0, 'unused time refunds a positive amount on a timed claim');
});
