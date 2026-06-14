// ipfs-gate v1 — Stage 1b (part 2) moderation × escrow tests (node:test).
// Covers cohosting §7: CID ban (content kill) voids the active claim AND the
// whole dormant backstop queue, registry-blocks re-upload, and classifies refunds
// (innocent backstoppers = full escrow; offender per refund_policy); user ban
// (identity kill) voids only that user's claims and lets the file SURVIVE via
// another user's backstop. DB-level, no Kubo/Hive/network.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-mod-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = TMP_DB;

const quota = require('../quota');
const pricing = require('../pricing');
const moderation = require('../moderation');

quota.open();
quota.runMigrations();
process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

let n = 0;
const u = (p) => `${p}_${++n}`;
const newCid = () => 'Qm' + crypto.randomBytes(8).toString('hex');
const newTx = () => `tx_${++n}_${crypto.randomBytes(4).toString('hex')}`;

function setupActiveClaim({ owner, cid, sizeBytes = 5_000_000, paidHours = 5, startOffsetMs = 0 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: paidHours, copies: 1 }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `m:${tx}`, block_num: 1, status: 'confirmed' });
  const startTs = quota.now() - startOffsetMs;
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id, sizeBytes, sizeMB: pricing.billableMB(sizeBytes),
    rateLocked: pricing.RATE_PER_MB_HOUR, paidHours, copies: 1, amountPaid: amount, currency: 'TEST', startTs, expiryTs
  });
  return { claim_id, cid, amount };
}

function setupBackstop({ owner, cid, sizeBytes = 5_000_000, pledgedHours = 5 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: pledgedHours, copies: 1 }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `ipfs-gate:backstop:${cid}`, block_num: 1, status: 'confirmed' });
  const tnow = quota.now();
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: null, paymentId: payment.id, sizeBytes, sizeMB: pricing.billableMB(sizeBytes),
    rateLocked: pricing.RATE_PER_MB_HOUR, paidHours: pledgedHours, copies: 1, amountPaid: amount, currency: 'TEST',
    startTs: tnow, expiryTs: tnow, kind: 'backstop', state: 'dormant'
  });
  return { claim_id, cid, amount };
}

// ─── CID ban (content kill) ──────────────────────────────────────────────────

test('CID ban voids the active claim AND the whole backstop queue + blocks re-upload', () => {
  const cid = newCid();
  const foo = setupActiveClaim({ owner: u('alice'), cid });
  const bar = setupBackstop({ owner: u('bob'), cid });
  const baz = setupBackstop({ owner: u('carol'), cid });

  const r = moderation.takedownCid({ cid, reason: 'dmca', refund_policy: 'prorata' });

  assert.equal(r.voided_claims.length, 3);                       // active + 2 dormant
  assert.equal(quota.getClaim(foo.claim_id).state, 'cancelled');
  assert.equal(quota.getClaim(bar.claim_id).state, 'cancelled');
  assert.equal(quota.getClaim(baz.claim_id).state, 'cancelled');
  assert.equal(quota.getDormantBackstopsForCid(cid).length, 0);  // queue voided
  assert.equal(quota.isCidBlocked(cid), true);                   // registry blocks re-upload
  assert.equal(quota.hasActivePinForCid(cid), false);            // pin → takedown
});

test('CID ban refunds: innocent backstoppers FULL escrow; active offender pro-rata', () => {
  const cid = newCid();
  const foo = setupActiveClaim({ owner: u('alice'), cid, sizeBytes: 5_000_000, paidHours: 5, startOffsetMs: 0 });
  const bar = setupBackstop({ owner: u('bob'), cid, sizeBytes: 5_000_000, pledgedHours: 5 }); // escrow 25

  const r = moderation.takedownCid({ cid, reason: 'dmca', refund_policy: 'prorata' });
  const byId = Object.fromEntries(r.voided_claims.map(c => [c.claim_id, c]));

  // innocent backstopper → full escrow, no fee
  assert.equal(pricing.forcedRefundAmount(byId[bar.claim_id], { policy: r.refund_policy, innocent: true }), 25);
  // active offender → pro-rata (used 1h of 5h → 4h × 5MB × 1 = 20)
  assert.equal(pricing.forcedRefundAmount(byId[foo.claim_id], { policy: r.refund_policy, innocent: false }), 20);
});

test('CID ban with refund_policy=none: offender forfeits, backstopper still full', () => {
  const cid = newCid();
  const foo = setupActiveClaim({ owner: u('alice'), cid });
  const bar = setupBackstop({ owner: u('bob'), cid });

  const r = moderation.takedownCid({ cid, reason: 'illegal', refund_policy: 'none' });
  const byId = Object.fromEntries(r.voided_claims.map(c => [c.claim_id, c]));

  assert.equal(r.refund_policy, 'none');
  assert.equal(pricing.forcedRefundAmount(byId[foo.claim_id], { policy: 'none', innocent: false }), 0);  // forfeit
  assert.equal(pricing.forcedRefundAmount(byId[bar.claim_id], { policy: 'none', innocent: true }), 25);  // innocent override
});

// ─── User ban (identity kill) ────────────────────────────────────────────────

test('user ban voids the user’s claim but the file SURVIVES via another user’s backstop', () => {
  const cid = newCid();
  const alice = u('alice');
  const foo = setupActiveClaim({ owner: alice, cid });
  const bar = setupBackstop({ owner: u('bob'), cid });

  const r = moderation.banAccount({ hive_account: alice, reason: 'spam', refund_policy: 'prorata' });

  assert.equal(r.voided_claims.length, 1);                       // only alice's claim
  assert.equal(quota.getClaim(foo.claim_id).state, 'cancelled');
  assert.equal(quota.getClaim(bar.claim_id).state, 'active');    // bob's backstop took the baton
  assert.deepEqual(r.activated, [bar.claim_id]);
  assert.ok(!r.cids_to_unpin.includes(cid));                     // survived → not unpinned
  assert.equal(quota.hasActivePinForCid(cid), true);
  assert.equal(quota.isCidBlocked(cid), false);                  // user ban does NOT ban content
});

test('user ban unpins when nobody else funds the file', () => {
  const cid = newCid();
  const alice = u('alice');
  const foo = setupActiveClaim({ owner: alice, cid });

  const r = moderation.banAccount({ hive_account: alice, reason: 'spam', refund_policy: 'prorata' });
  assert.equal(r.voided_claims.length, 1);
  assert.equal(r.activated.length, 0);
  assert.ok(r.cids_to_unpin.includes(cid));
  assert.equal(quota.hasActivePinForCid(cid), false);
});

test('user ban voids the banned user’s OWN dormant backstop (per policy, not innocent)', () => {
  const cid = newCid();
  const bob = u('bob');
  const alice = u('alice');
  setupActiveClaim({ owner: bob, cid });                         // bob keeps the file alive
  const aliceBs = setupBackstop({ owner: alice, cid, sizeBytes: 5_000_000, pledgedHours: 5 }); // escrow 25

  const r = moderation.banAccount({ hive_account: alice, reason: 'spam', refund_policy: 'prorata' });
  assert.equal(r.voided_claims.length, 1);
  assert.equal(r.voided_claims[0].claim_id, aliceBs.claim_id);
  assert.equal(quota.getClaim(aliceBs.claim_id).state, 'cancelled');
  assert.equal(quota.hasActivePinForCid(cid), true);             // bob's claim untouched

  // banned user's own dormant backstop, prorata → full escrow (never metered); none → forfeit
  assert.equal(pricing.forcedRefundAmount(r.voided_claims[0], { policy: 'prorata', innocent: false }), 25);
  assert.equal(pricing.forcedRefundAmount(r.voided_claims[0], { policy: 'none', innocent: false }), 0);
});
