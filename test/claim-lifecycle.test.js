// ipfs-gate v1 — Stage 1a unit + lifecycle tests (node:test, Node 18+).
// Covers: the MB-hour pricing formula, pro-rata refund math, the claim lifecycle
// (cancel vs expire), last-funder unpin timing, and the refund ledger.
//
// Runs entirely against a throwaway SQLite DB — no Kubo, no Hive, no network.
// (The on-chain refund BROADCAST is a live/manual test — see STAGE-0-BASELINE.md
// + the plan's verification §4 — because it needs a funded escrow key.)
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Point quota at a fresh temp DB BEFORE requiring it (DB_PATH is read at load).
const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = TMP_DB;

const quota = require('../quota');
const pricing = require('../pricing');

quota.open();
quota.runMigrations();

process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

// ─── helper: create a fully-formed active claim at the DB level ──────────────
let txCounter = 0;
function setupClaim({ owner = 'alice', cid = null, sizeBytes = 5_000_000, paidHours = 5, copies = 1, startOffsetMs = 0, rate = pricing.RATE_PER_MB_HOUR }) {
  cid = cid || ('Qm' + crypto.randomBytes(8).toString('hex'));
  const sizeMB = pricing.billableMB(sizeBytes);
  const quotedAmount = pricing.calculateCost({ sizeBytes, hoursRequested: paidHours, copies }).total;

  const resv = quota.createReservation(owner, sizeBytes, 'encrypted', { hoursRequested: paidHours, copies, quotedAmount });
  const txId = `tx_${++txCounter}_${crypto.randomBytes(4).toString('hex')}`;
  quota.markReservationPaid(resv.id, txId);
  const payment = quota.recordPayment({
    tx_id: txId, reservation_id: resv.id, uploader: owner, currency: 'TEST',
    amount: quotedAmount, memo: quota.getMemoForReservation(resv.id), block_num: 1, status: 'confirmed'
  });

  const startTs = quota.now() - startOffsetMs;
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  quota.markReservationUploaded(resv.id, pin.id);

  const { claim_id, order_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id,
    sizeBytes, sizeMB, rateLocked: rate, paidHours, copies,
    amountPaid: quotedAmount, currency: 'TEST', startTs, expiryTs
  });
  return { claim_id, order_id, cid, pin_id: pin.id, payment_id: payment.id };
}

// ─── pricing (pure) ─────────────────────────────────────────────────────────

test('calculateCost — worked examples (PRICING-V1 §2)', () => {
  assert.equal(pricing.calculateCost({ sizeBytes: 5_000_000,   hoursRequested: 1,  copies: 1 }).total, 5);
  assert.equal(pricing.calculateCost({ sizeBytes: 5_000_000,   hoursRequested: 3,  copies: 1 }).total, 15);
  assert.equal(pricing.calculateCost({ sizeBytes: 10_300_000,  hoursRequested: 1,  copies: 1 }).total, 11);  // 10.3 → ceil 11
  assert.equal(pricing.calculateCost({ sizeBytes: 100_000_000, hoursRequested: 24, copies: 1 }).total, 2400);
});

test('billable units round up; copies cap at node_count', () => {
  assert.equal(pricing.billableMB(1), 1);            // min 1 MB
  assert.equal(pricing.billableMB(1_000_001), 2);    // ceil decimal MB
  assert.equal(pricing.billableHours(0.1), 1);       // min 1 hr
  assert.equal(pricing.billableHours(2.1), 3);       // ceil
  assert.equal(pricing.cappedCopies(5, 1), 1);       // single-node gate caps to 1
  assert.equal(pricing.cappedCopies(5, 3), 3);
  assert.equal(pricing.cappedCopies(0), 1);          // floor 1
});

test('calculateCost breakdown is self-describing', () => {
  const q = pricing.calculateCost({ sizeBytes: 5_000_000, hoursRequested: 3, copies: 1 });
  assert.deepEqual(q, { billable_mb: 5, billable_hrs: 3, copies: 1, rate: 1, total: 15 });
});

// ─── refund math ────────────────────────────────────────────────────────────

test('cancel just after start of a 5h claim → 4h pro-rata refund (min 1h consumed)', () => {
  const { claim_id, cid } = setupClaim({ owner: 'alice', sizeBytes: 5_000_000, paidHours: 5, copies: 1, startOffsetMs: 0 });

  const { claim, fully_unpinned } = quota.cancelClaim(claim_id, 'alice');
  const refund = pricing.calculateRefund(claim, Date.now());

  assert.equal(refund.hours_used, 1);        // min 1 hr consumed
  assert.equal(refund.hours_refunded, 4);    // 5 paid − 1 used
  assert.equal(refund.amount, 20);           // 4h × 5MB × rate 1 × copies 1
  assert.equal(refund.dust, false);
  assert.equal(fully_unpinned, true);
  assert.equal(quota.getClaim(claim_id).state, 'cancelled');
  assert.equal(quota.hasActivePinForCid(cid), false);
});

test('cancel a 1h claim already an hour in → nothing refundable (dust)', () => {
  const { claim_id } = setupClaim({ owner: 'bob', sizeBytes: 5_000_000, paidHours: 1, copies: 1, startOffsetMs: 0 });
  const { claim } = quota.cancelClaim(claim_id, 'bob');
  const refund = pricing.calculateRefund(claim, Date.now());
  assert.equal(refund.hours_refunded, 0);
  assert.equal(refund.amount, 0);
  assert.equal(refund.dust, true);
});

// ─── lifecycle: expire vs cancel + last-funder unpin ────────────────────────

test('expiry sweep marks the claim expired, issues NO refund, unpins the last funder', () => {
  // started 2h ago, only 1h paid → already past expiry
  const { claim_id, cid } = setupClaim({ owner: 'carol', paidHours: 1, startOffsetMs: 2 * pricing.HOUR_MS });
  assert.equal(quota.hasActivePinForCid(cid), true);

  const res = quota.sweep();
  assert.ok(res.expired_claims >= 1);
  assert.equal(quota.getClaim(claim_id).state, 'expired');
  assert.equal(quota.hasActivePinForCid(cid), false);
  assert.ok(res.cids_to_unpin.includes(cid));

  // expiry refunds nothing — the sweep never touches the refund ledger
  const db = quota.open();
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM refunds WHERE claim_id = ?').get(claim_id).c;
  assert.equal(cnt, 0);
});

test('two active claims on one CID: unpin only after the LAST is cancelled', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const a = setupClaim({ owner: 'dave', cid, paidHours: 5, startOffsetMs: 0 });
  const b = setupClaim({ owner: 'dave', cid, paidHours: 5, startOffsetMs: 0 });

  assert.equal(quota.hasActivePinForCid(cid), true);

  const r1 = quota.cancelClaim(a.claim_id, 'dave');
  assert.equal(r1.fully_unpinned, false);          // b still funds it
  assert.equal(quota.hasActivePinForCid(cid), true);

  const r2 = quota.cancelClaim(b.claim_id, 'dave');
  assert.equal(r2.fully_unpinned, true);           // last funder gone
  assert.equal(quota.hasActivePinForCid(cid), false);
});

// ─── guards + ledger ────────────────────────────────────────────────────────

test('cancelClaim guards: not found / wrong owner / double cancel', () => {
  assert.throws(() => quota.cancelClaim('clm_nope', 'eve'), /not found/);

  const { claim_id } = setupClaim({ owner: 'eve', startOffsetMs: 0 });
  assert.throws(() => quota.cancelClaim(claim_id, 'mallory'), /not your claim/);

  quota.cancelClaim(claim_id, 'eve');                                   // first cancel wins
  assert.throws(() => quota.cancelClaim(claim_id, 'eve'), /not active|already closed/);  // second is rejected
});

test('refund ledger records pending then settles sent', () => {
  const { claim_id } = setupClaim({ owner: 'frank', startOffsetMs: 0 });
  const { refund_id } = quota.recordRefund({ claim_id, to_account: 'frank', amount: 3, currency: 'TEST', memo: 'm', status: 'pending', reason: 'cancel' });
  assert.equal(quota.getRefund(refund_id).status, 'pending');

  quota.markRefundSettled(refund_id, 'sent', 'tx_abc');
  const row = quota.getRefund(refund_id);
  assert.equal(row.status, 'sent');
  assert.equal(row.tx_id, 'tx_abc');
  assert.ok(row.settled_ts > 0);
});
