// ipfs-gate v1 — Guardian feature lifecycle tests (node:test).
// The Stage-1b backstop, renamed + extended per the Guardian handover doc:
// dormant pledge (pledge_order/pledge_budget), FIFO baton-pass activation (on
// expire AND on cancel), strict pledge-order FIFO, dormant-cancel FULL refund
// (spec §6 — fee only if the operator configures one), extend/top-up, own-copy
// claims (independent parallel funders), already-hosted detection, and the
// "unpin only when no funder remains" rule. DB-level, no Kubo/Hive/network.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-gd-${crypto.randomBytes(6).toString('hex')}.db`);
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
function setupActiveClaim({ owner = 'alice', cid = null, sizeBytes = 5_000_000, paidHours = 5, copies = 1, startOffsetMs = 0, kind = 'original' }) {
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
    amountPaid: amount, currency: 'TEST', startTs, expiryTs, kind
  });
  return { claim_id, cid, pin_id: pin.id, amount, payment_id: payment.id };
}

// A DORMANT guardian (no pin), set up directly at the DB level. pledge_order +
// pledge_budget are stamped by createOrderWithClaim (the pledge path).
function setupGuardian({ owner = 'bob', cid, sizeBytes = 5_000_000, pledgedHours = 5, copies = 1 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: pledgedHours, copies }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `ipfs-gate:guardian:${cid}`, block_num: 1, status: 'confirmed' });
  const tnow = quota.now();
  const { claim_id, pledge_order } = quota.createOrderWithClaim({
    cid, owner, pinId: null, paymentId: payment.id, sizeBytes,
    sizeMB: pricing.billableMB(sizeBytes), rateLocked: pricing.RATE_PER_MB_HOUR,
    paidHours: pledgedHours, copies, amountPaid: amount, currency: 'TEST',
    startTs: tnow, expiryTs: tnow, kind: 'guardian', state: 'dormant'
  });
  return { claim_id, cid, amount, pledge_order };
}

// ─── pledge shape ────────────────────────────────────────────────────────────

test('a pledge creates a dormant guardian claim with no pin + FIFO slot + budget', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const { claim_id, amount } = setupGuardian({ owner: 'bob', cid });
  const c = quota.getClaim(claim_id);
  assert.equal(c.kind, 'guardian');
  assert.equal(c.state, 'dormant');
  assert.equal(c.pin_id, null);
  assert.equal(c.pledge_order, 1);            // first pledge on this CID
  assert.equal(c.pledge_budget, amount);      // budget = escrow pledged
  // dormant contributes nothing to the live pin set
  assert.equal(quota.getActiveClaimsForCid(cid).length, 1);  // just alice
  assert.equal(quota.getDormantGuardiansForCid(cid).length, 1);
});

test('pledge_order increments per CID, in pledge order', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const g1 = setupGuardian({ owner: 'bob', cid });
  const g2 = setupGuardian({ owner: 'carol', cid });
  const g3 = setupGuardian({ owner: 'dave', cid });
  assert.deepEqual([g1.pledge_order, g2.pledge_order, g3.pledge_order], [1, 2, 3]);
  // a different CID starts its own sequence
  const cid2 = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid: cid2 });
  assert.equal(setupGuardian({ owner: 'erin', cid: cid2 }).pledge_order, 1);
});

// ─── FIFO baton-pass ──────────────────────────────────────────────────────────

test('expiry promotes the dormant guardian instead of unpinning (sweep)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 1, startOffsetMs: 2 * pricing.HOUR_MS }); // already expired
  const bar = setupGuardian({ owner: 'bob', cid, pledgedHours: 5 });

  const res = quota.sweep();
  assert.ok(res.activated_guardians >= 1);
  assert.ok(!res.cids_to_unpin.includes(cid));            // NOT unpinned — guardian took over

  assert.equal(quota.getClaim(foo.claim_id).state, 'expired');
  const promoted = quota.getClaim(bar.claim_id);
  assert.equal(promoted.state, 'active');
  assert.ok(promoted.pin_id);                             // got a fresh pin
  assert.ok(promoted.expiry_ts > quota.now());            // metering its 5h now
  assert.equal(quota.hasActivePinForCid(cid), true);      // file still alive
});

test('cancelling the active funder promotes the guardian (not an unpin)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 5, startOffsetMs: 0 });
  const bar = setupGuardian({ owner: 'bob', cid, pledgedHours: 3 });

  const r = quota.cancelClaim(foo.claim_id, 'alice');
  assert.equal(r.fully_unpinned, false);
  assert.equal(r.activated, bar.claim_id);
  assert.equal(quota.getClaim(bar.claim_id).state, 'active');
  assert.equal(quota.hasActivePinForCid(cid), true);
});

test('FIFO: strictly pledge order — the FIRST-pledged guardian activates first', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 5 });
  const first = setupGuardian({ owner: 'bob', cid });
  const second = setupGuardian({ owner: 'carol', cid });

  quota.cancelClaim(foo.claim_id, 'alice');
  assert.equal(quota.getClaim(first.claim_id).state, 'active');   // head of queue
  assert.equal(quota.getClaim(second.claim_id).state, 'dormant'); // still waiting
});

test('no guardian queued → cancelling the last funder unpins', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid });
  const r = quota.cancelClaim(foo.claim_id, 'alice');
  assert.equal(r.fully_unpinned, true);
  assert.equal(r.activated, null);
  assert.equal(quota.hasActivePinForCid(cid), false);
});

// ─── own copy (spec §2/§3) ───────────────────────────────────────────────────

test('an own copy is an independent live funder — original cancelling does not fire the guardian', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const orig = setupActiveClaim({ owner: 'alice', cid, paidHours: 5 });
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: 'cnoobz', currency: 'TEST', amount: 25, memo: `ipfs-gate:owncopy:${cid}`, block_num: 1, status: 'confirmed' });
  const own = quota.createOwnCopyClaim({
    cid, owner: 'cnoobz', paymentId: payment.id, paidHours: 5, copies: 1,
    rateLocked: pricing.RATE_PER_MB_HOUR, amountPaid: 25, currency: 'TEST'
  });
  const guard = setupGuardian({ owner: 'bob', cid });

  const c = quota.getClaim(own.claim_id);
  assert.equal(c.kind, 'own_copy');
  assert.equal(c.state, 'active');
  assert.ok(c.pin_id);

  // original cancels → own copy still funds the file; the guardian does NOT
  // fire (it guards the FILE, not a person — spec §4)
  const r = quota.cancelClaim(orig.claim_id, 'alice');
  assert.equal(r.fully_unpinned, false);
  assert.equal(r.activated, null);
  assert.equal(quota.getClaim(guard.claim_id).state, 'dormant');
  assert.equal(quota.hasActivePinForCid(cid), true);

  // own copy cancels too → NOW the guardian takes the baton
  const r2 = quota.cancelClaim(own.claim_id, 'cnoobz');
  assert.equal(r2.fully_unpinned, false);
  assert.equal(r2.activated, guard.claim_id);
});

test('createOwnCopyClaim refuses a CID with no live host', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: 'cnoobz', currency: 'TEST', amount: 25, memo: `ipfs-gate:owncopy:${cid}`, block_num: 1, status: 'confirmed' });
  assert.throws(() => quota.createOwnCopyClaim({
    cid, owner: 'cnoobz', paymentId: payment.id, paidHours: 5, copies: 1,
    rateLocked: pricing.RATE_PER_MB_HOUR, amountPaid: 25, currency: 'TEST'
  }), /not currently hosted/);
});

// ─── already-hosted detection (spec §3) ──────────────────────────────────────

test('alreadyHostedForCid reports expiry + hosts + queue depth; null when not hosted', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  assert.equal(quota.alreadyHostedForCid(cid), null);

  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 5 });
  setupGuardian({ owner: 'bob', cid });
  setupGuardian({ owner: 'carol', cid });

  const info = quota.alreadyHostedForCid(cid);
  assert.equal(info.active_hosts, 1);
  assert.equal(info.guardian_queue_depth, 2);
  assert.equal(info.hosted_until, quota.getClaim(foo.claim_id).expiry_ts);
  assert.equal(info.size_bytes, 5_000_000);
});

// ─── dormant-cancel refund (spec §6: FULL — fee only if operator configures) ─

test('dormant-cancel refunds the FULL escrow by default (no fee)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const bar = setupGuardian({ owner: 'bob', cid, sizeBytes: 5_000_000, pledgedHours: 5 }); // escrow = 25

  const r = quota.cancelClaim(bar.claim_id, 'bob');
  assert.equal(r.was_dormant, true);
  assert.equal(r.fully_unpinned, false);     // dormant cancel doesn't touch the live file
  assert.equal(r.activated, null);

  const refund = pricing.calculateDormantRefund(r.claim); // default fee 0 (spec §6)
  assert.equal(refund.fee, 0);
  assert.equal(refund.amount, 25);           // full escrow back
  assert.equal(refund.dust, false);
  // the live file is untouched by a dormant cancel
  assert.equal(quota.hasActivePinForCid(cid), true);
});

test('an operator-configured cancel fee still works when passed explicitly', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const bar = setupGuardian({ owner: 'bob', cid, sizeBytes: 5_000_000, pledgedHours: 5 });
  const refund = pricing.calculateDormantRefund(quota.getClaim(bar.claim_id), 1); // 1%
  assert.equal(refund.fee, 0.25);            // 25 × 1%
  assert.equal(refund.amount, 24.75);        // 25 − 0.25
});

test('admin-forced dormant void charges no cancel fee (feePct=0)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  setupActiveClaim({ owner: 'alice', cid });
  const bar = setupGuardian({ owner: 'bob', cid, sizeBytes: 5_000_000, pledgedHours: 5 });
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

test('extending the live host delays guardian activation (guardian just waits)', () => {
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid, paidHours: 1, startOffsetMs: 0 });
  const guard = setupGuardian({ owner: 'bob', cid });

  quota.extendClaim(foo.claim_id, 'alice', 5);       // push expiry well out
  const res = quota.sweep();                         // nothing should fire
  assert.equal(res.activated_guardians, 0);
  assert.equal(quota.getClaim(guard.claim_id).state, 'dormant');
  assert.equal(quota.getClaim(foo.claim_id).state, 'active');
});

test('extend guards: not found / wrong owner / non-active', () => {
  assert.throws(() => quota.extendClaim('clm_nope', 'alice', 1), /not found/);
  const cid = 'Qm' + crypto.randomBytes(8).toString('hex');
  const foo = setupActiveClaim({ owner: 'alice', cid });
  assert.throws(() => quota.extendClaim(foo.claim_id, 'mallory', 1), /not your claim/);
  quota.cancelClaim(foo.claim_id, 'alice');
  assert.throws(() => quota.extendClaim(foo.claim_id, 'alice', 1), /not active/);
});
