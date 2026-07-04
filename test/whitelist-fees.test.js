// ipfs-gate v1 — Whitelist fee exemption, Stage B tests (node:test).
// Covers the DB/pricing mechanics the fee-exempt routes rest on: a rate-0
// quote totals 0 with the breakdown intact, a fee-exempt reservation persists
// quoted_amount=0 (the /upload skip signal), synthetic zero-amount payment
// rows record + replay-guard via payments.tx_id UNIQUE, a rate_locked=0 claim
// survives its whole lifecycle (cancel → 0 refund, extend stays free, forced
// void → 0 refund), and a 0-budget dormant guardian refunds 0 without crashing.
//
// The HTTP layer (skip-verify branches in /upload, pledge, own-copy, extend)
// reuses exactly these primitives — route-level behavior is boot-smoked
// manually per the repo's convention (no HTTP harness in this suite).
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
process.env.WHITELIST_MODE = 'true';

const quota = require('../quota');
const pricing = require('../pricing');

const db = quota.open();
quota.runMigrations();

process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

function addWhitelistRow(account, { quota_bytes = null, fee_exempt = 0 } = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO whitelisted_accounts
      (hive_account, added_at, added_by, quota_bytes, fee_exempt, note, removed_at, removed_by)
    VALUES (?, ?, 'operator', ?, ?, NULL, NULL, NULL)
  `).run(account, quota.now(), quota_bytes, fee_exempt);
}

// Build a full fee-exempt claim the way /upload does: $0 reservation →
// synthetic payment → pin → claim with rate_locked 0.
function setupExemptClaim({ owner, cid = null, sizeBytes = 5_000_000, paidHours = 5, dormantGuardian = false }) {
  cid = cid || ('Qm' + crypto.randomBytes(8).toString('hex'));
  const resv = quota.createReservation(owner, sizeBytes, 'public',
    { hoursRequested: paidHours, copies: 1, quotedAmount: 0 });
  const syntheticTxId = `whitelist-free:upload:${resv.id}`;
  const payment = quota.recordPayment({
    tx_id: syntheticTxId, reservation_id: resv.id, uploader: owner, currency: 'TEST',
    amount: 0, memo: quota.getMemoForReservation(resv.id), block_num: null, status: 'confirmed'
  });
  quota.markReservationPaid(resv.id, syntheticTxId);

  const startTs = quota.now();
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  if (dormantGuardian) {
    const { claim_id, order_id } = quota.createOrderWithClaim({
      cid, owner, pinId: null, paymentId: payment.id,
      sizeBytes, sizeMB: pricing.billableMB(sizeBytes), rateLocked: 0, paidHours, copies: 1,
      amountPaid: 0, currency: 'TEST', startTs, expiryTs: startTs,
      kind: 'guardian', state: 'dormant'
    });
    return { claim_id, order_id, cid, resv_id: resv.id, syntheticTxId };
  }
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  quota.markReservationUploaded(resv.id, pin.id);
  const { claim_id, order_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id,
    sizeBytes, sizeMB: pricing.billableMB(sizeBytes), rateLocked: 0, paidHours, copies: 1,
    amountPaid: 0, currency: 'TEST', startTs, expiryTs
  });
  return { claim_id, order_id, cid, pin_id: pin.id, resv_id: resv.id, syntheticTxId };
}

// ─── pricing at rate 0 ───────────────────────────────────────────────────────

test('calculateCost at rate 0: total 0, breakdown intact', () => {
  const q = pricing.calculateCost({ sizeBytes: 5_000_000, hoursRequested: 3, copies: 1, rate: 0 });
  assert.deepEqual(q, { billable_mb: 5, billable_hrs: 3, copies: 1, rate: 0, total: 0 });
});

// ─── the /upload skip signal ─────────────────────────────────────────────────

test('fee-exempt reservation persists quoted_amount 0', () => {
  addWhitelistRow('freefamily', { fee_exempt: 1 });
  const resv = quota.createReservation('freefamily', 2_000_000, 'public',
    { hoursRequested: 2, copies: 1, quotedAmount: 0 });
  const r = quota.getReservation(resv.id);
  assert.equal(r.quoted_amount, 0);
  assert.equal(quota.getWhitelistEntry('freefamily').fee_exempt, 1);
});

// ─── synthetic payment rows ──────────────────────────────────────────────────

test('synthetic zero-amount payment records and replay-guards on tx_id UNIQUE', () => {
  addWhitelistRow('synthpayer', { fee_exempt: 1 });
  const resv = quota.createReservation('synthpayer', 1_000_000, 'public',
    { hoursRequested: 1, copies: 1, quotedAmount: 0 });
  const txId = `whitelist-free:upload:${resv.id}`;
  const p = quota.recordPayment({
    tx_id: txId, reservation_id: resv.id, uploader: 'synthpayer', currency: 'TEST',
    amount: 0, memo: quota.getMemoForReservation(resv.id), block_num: null, status: 'confirmed'
  });
  assert.ok(p.id, 'synthetic payment row created');
  assert.ok(quota.getPaymentByTxId(txId), 'replay pre-check finds it');
  assert.throws(
    () => quota.recordPayment({
      tx_id: txId, reservation_id: resv.id, uploader: 'synthpayer', currency: 'TEST',
      amount: 0, memo: 'dup', block_num: null, status: 'confirmed'
    }),
    /already used/i,
    'second insert with the same synthetic tx_id is rejected as a replay'
  );
});

// ─── rate_locked=0 claim lifecycle ───────────────────────────────────────────

test('cancelling an active rate-0 claim computes a 0 refund (no crash, no charge)', () => {
  addWhitelistRow('freealice', { fee_exempt: 1 });
  const { claim_id } = setupExemptClaim({ owner: 'freealice', paidHours: 5 });
  const r = quota.cancelClaim(claim_id, 'freealice');
  assert.equal(r.claim.state, 'active', 'pre-cancel snapshot state');
  const refund = pricing.calculateRefund(r.claim);
  assert.equal(refund.amount, 0, 'rate 0 × unused hours = 0');
  assert.equal(refund.dust, true, '0 is below MIN_REFUND → dust, nothing to broadcast');
});

test('extendClaim on a rate-0 claim pushes hours/expiry; extend cost math is 0', () => {
  addWhitelistRow('freebob', { fee_exempt: 1 });
  const { claim_id } = setupExemptClaim({ owner: 'freebob', paidHours: 2 });
  const before = quota.getClaim(claim_id);
  assert.equal(before.rate_locked, 0);
  // The extend route's cost formula, at this claim's locked rate:
  const cost = pricing.roundCoins(before.size_mb * 3 * before.rate_locked * before.copies_requested);
  assert.equal(cost, 0, 'extend quote at rate_locked 0 is 0');
  const updated = quota.extendClaim(claim_id, 'freebob', 3);
  assert.equal(updated.paid_hours, 5, '2 + 3 hours');
  assert.equal(updated.expiry_ts, before.expiry_ts + 3 * pricing.HOUR_MS);
});

test('forced void of an exempt claim refunds 0 under both policies', () => {
  addWhitelistRow('freecarol', { fee_exempt: 1 });
  const { claim_id } = setupExemptClaim({ owner: 'freecarol', paidHours: 10 });
  const claim = quota.getClaim(claim_id);
  assert.equal(pricing.forcedRefundAmount(claim, { policy: 'prorata', innocent: false }), 0);
  assert.equal(pricing.forcedRefundAmount(claim, { policy: 'none', innocent: false }), 0);
});

// ─── 0-budget dormant guardian ───────────────────────────────────────────────

test('a fee-exempt dormant guardian pledge (budget 0) cancels with a 0 refund', () => {
  addWhitelistRow('freedave', { fee_exempt: 1 });
  addWhitelistRow('freehost', { fee_exempt: 1 });
  // A live host first (a guardian needs a live file to guard).
  const { cid } = setupExemptClaim({ owner: 'freehost', paidHours: 5 });
  const { claim_id } = setupExemptClaim({ owner: 'freedave', cid, paidHours: 5, dormantGuardian: true });
  const g = quota.getClaim(claim_id);
  assert.equal(g.kind, 'guardian');
  assert.equal(g.state, 'dormant');
  assert.equal(g.pledge_budget, 0, 'escrow pledged is 0');
  const r = quota.cancelClaim(claim_id, 'freedave');
  const refund = pricing.calculateDormantRefund(r.claim);
  assert.equal(refund.amount, 0);
  assert.equal(refund.dust, true, 'nothing to broadcast back');
});

// ─── exemption is per-entry, not per-mode ────────────────────────────────────

test('a whitelisted but NOT fee-exempt account still quotes at the real rate', () => {
  addWhitelistRow('payingguest', { fee_exempt: 0 });
  const entry = quota.getWhitelistEntry('payingguest');
  assert.equal(entry.fee_exempt, 0);
  // The route-side branch keys off entry.fee_exempt — a paying guest's quote
  // uses the default rate:
  const q = pricing.calculateCost({ sizeBytes: 5_000_000, hoursRequested: 1, copies: 1 });
  assert.equal(q.total, 5 * pricing.RATE_PER_MB_HOUR);
});
