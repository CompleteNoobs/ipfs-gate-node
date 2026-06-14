// ipfs-gate v1 — Stage 1b (part 1) backstop lifecycle tests (node:test).
// Covers: dormant pledge, FIFO baton-pass activation (on expire AND on cancel),
// FIFO ordering, dormant-cancel full-minus-fee refund, extend/top-up, and the
// "unpin only when no funder remains" rule. DB-level, no Kubo/Hive/network.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-bs-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = TMP_DB;

const quota = require('../quota');
const pricing = require('../pricing');

quota.open();
quota.runMigrations();
process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

let txCounter = 0;
function newTx() { return `tx_${++txCounter}_${crypto.randomBytes(4).toString('hex')}`; }

// An ACTIVE original claim (with a pin), set up directly at the DB level.
function setupActiveClaim({ owner = 'alice', cid = null, sizeBytes = 5_000_000, paidHours = 5, copies = 1, startOffsetMs = 0 }) {
  cid = cid || ('Qm' + crypto.randomBytes(8).toString('hex'));
  const sizeMB = pricing.billableMB(sizeBytes);
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: paidHours, copies }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `m:${tx}`, block_num: 1, status: 'confirmed' });
  const startTs = quota.now() - startOffsetMs;
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id, sizeBytes, sizeMB,
    rateLocked: pricing.RATE_PER_MB_HOUR, paidHours, copies,
    amountPaid: amount, currency: 'TEST', startTs, expiryTs
  });
  return { claim_id, cid, pin_id: pin.id, amount };
}

// A DORMANT backstop (no pin), set up directly at the DB level.
function setupBackstop({ owner = 'bob', cid, sizeBytes = 5_000_000, pledgedHours = 5, copies = 1 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: pledgedHours, copies }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `ipfs-gate:backstop:${cid}`, block_num: 1, status: 'confirmed' });
  const tnow = quota.now();
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: null, paymentId: payment.id, sizeBytes,
    sizeMB: pricing.billableMB(sizeBytes), rateLocked: pricing.RATE_PER_MB_HOUR,
    paidHours: pledgedHours, copies, amountPaid: amount, currency: 'TEST',
    startTs: tnow, expiryTs: tnow, kind: 'backstop', state: 'dormant'
  });
  return { claim_id, cid, amount };
}

// ─── pledge shape ────────────────────────────────────────────────────────────

test('a pledge creates a dormant backstop claim with no pin', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const { claim_id } = setupBackstop({ owner: 'bob', cid });
  const c = quota.getClaim(claim_id);
  assert.equal(c.kind, 'backstop');
  assert.equal(c.state, 'dormant');
  assert.equal(c.pin_id, null);
  // dormant contributes nothing to the live pin set
  assert.equal(quota.getActiveClaimsForCid(cid).length, 1);  // just alice
  assert.equal(quota.getDormantBackstopsForCid(cid).length, 1);
});

// ─── FIFO baton-pass ──────────────────────────────────────────────────────────

test('expiry promotes the dormant backstop instead of unpinning (sweep)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 1, startOffsetMs: 2 * pricing.HOUR_MS }); // already expired
  const bar = setupBackstop({ owner: 'bob', cid, pledgedHours: 5 });

  const res = quota.sweep();
  assert.ok(res.activated_backstops >= 1);
  assert.ok(!res.cids_to_unpin.includes(cid));            // NOT unpinned — backstop took over

  assert.equal(quota.getClaim(foo.claim_id).state, 'expired');
  const promoted = quota.getClaim(bar.claim_id);
  assert.equal(promoted.state, 'active');
  assert.ok(promoted.pin_id);                             // got a fresh pin
  assert.ok(promoted.expiry_ts > quota.now());            // metering its 5h now
  assert.equal(quota.hasActivePinForCid(cid), true);      // file still alive
});

test('cancelling the active funder promotes the backstop (not an unpin)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 5, startOffsetMs: 0 });
  const bar = setupBackstop({ owner: 'bob', cid, pledgedHours: 3 });

  const r = quota.cancelClaim(foo.claim_id, 'alice');
  assert.equal(r.fully_unpinned, false);
  assert.equal(r.activated, bar.claim_id);
  assert.equal(quota.getClaim(bar.claim_id).state, 'active');
  assert.equal(quota.hasActivePinForCid(cid), true);
});

test('FIFO: the FIRST-pledged backstop activates first', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 5 });
  const first = setupBackstop({ owner: 'bob', cid });
  const second = setupBackstop({ owner: 'carol', cid });

  quota.cancelClaim(foo.claim_id, 'alice');
  assert.equal(quota.getClaim(first.claim_id).state, 'active');   // head of queue
  assert.equal(quota.getClaim(second.claim_id).state, 'dormant'); // still waiting
});

test('no backstop queued → cancelling the last funder unpins', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid });
  const r = quota.cancelClaim(foo.claim_id, 'alice');
  assert.equal(r.fully_unpinned, true);
  assert.equal(r.activated, null);
  assert.equal(quota.hasActivePinForCid(cid), false);
});

// ─── dormant-cancel refund (full minus fee) ──────────────────────────────────

test('dormant-cancel returns escrow minus BACKSTOP_CANCEL_FEE_PCT', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const bar = setupBackstop({ owner: 'bob', cid, sizeBytes: 5_000_000, pledgedHours: 5 }); // escrow = 25

  const r = quota.cancelClaim(bar.claim_id, 'bob');
  assert.equal(r.was_dormant, true);
  assert.equal(r.fully_unpinned, false);     // dormant cancel doesn't touch the live file
  assert.equal(r.activated, null);

  const refund = pricing.calculateDormantRefund(r.claim); // default fee 1%
  assert.equal(refund.fee, 0.25);            // 25 × 1%
  assert.equal(refund.amount, 24.75);        // 25 − 0.25
  assert.equal(refund.dust, false);
  // the live file is untouched by a dormant cancel
  assert.equal(quota.hasActivePinForCid(cid), true);
});

test('admin-forced dormant void charges no cancel fee (feePct=0)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const bar = setupBackstop({ owner: 'bob', cid, sizeBytes: 5_000_000, pledgedHours: 5 });
  const refund = pricing.calculateDormantRefund(quota.getClaim(bar.claim_id), 0);
  assert.equal(refund.fee, 0);
  assert.equal(refund.amount, 25);           // full escrow, no fee
});

// ─── extend / top-up ─────────────────────────────────────────────────────────

test('extend pushes paid_hours + expiry at the locked rate, syncing the pin', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 5, startOffsetMs: 0 });
  const before = quota.getClaim(foo.claim_id);

  const updated = quota.extendClaim(foo.claim_id, 'alice', 3);
  assert.equal(updated.paid_hours, 8);
  assert.equal(updated.expiry_ts, before.expiry_ts + 3 * pricing.HOUR_MS);

  const db = quota.open();
  const pin = db.prepare('SELECT expires_at FROM pins WHERE id = ?').get(before.pin_id);
  assert.equal(pin.expires_at, updated.expiry_ts);   // pin mirrors the claim timer
});

test('extend guards: not found / wrong owner / non-active', () => {
  assert.throws(() => quota.extendClaim('clm_nope', 'alice', 1), /not found/);
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid });
  assert.throws(() => quota.extendClaim(foo.claim_id, 'mallory', 1), /not your claim/);
  quota.cancelClaim(foo.claim_id, 'alice');
  assert.throws(() => quota.extendClaim(foo.claim_id, 'alice', 1), /not active/);
});
