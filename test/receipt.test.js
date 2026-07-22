// ipfs-gate v1 — Stage 6 proof-of-receipt tests (node:test).
// Covers: receipt_hash persisted on the order at create; the proof-match gate;
// recordReceipt/getReceipts idempotency; and the receipt→release-consent bridge
// (a verified receipt advances the SAME release threshold — any_of ends on the
// first, all_of only after every recipient, owner_only records but never ends).
//   node --test test/
//
// The HTTP layer (Hive posting-key signature + freshness) reuses the exact
// verifySignedUserRequest already exercised by /claims/release; here we test the
// post-signature logic that POST /claims/receipt runs, against a real DB.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-rcpt-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = TMP_DB;

const quota = require('../quota');
const pricing = require('../pricing');
const releaseAuth = require('../release-policy');

quota.open();
quota.runMigrations();
process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

let n = 0;
const u = (p) => `${p}_${++n}`;
const newCid = () => 'Qm' + crypto.randomBytes(8).toString('hex');
const newTx = () => `tx_${++n}_${crypto.randomBytes(4).toString('hex')}`;
const h = () => crypto.randomBytes(32).toString('hex');

function setupActiveClaim({ owner, cid, releasePolicy = null, receiptHash = null, sizeBytes = 5_000_000, paidHours = 5 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: paidHours, copies: 1 }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `m:${tx}`, block_num: 1, status: 'confirmed' });
  const startTs = quota.now();
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  const { claim_id, order_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id, sizeBytes, sizeMB: pricing.billableMB(sizeBytes),
    rateLocked: pricing.RATE_PER_MB_HOUR, paidHours, copies: 1, amountPaid: amount, currency: 'TEST',
    startTs, expiryTs, releasePolicy, receiptHash
  });
  return { claim_id, order_id, cid, owner };
}

// Mirror POST /claims/receipt AFTER the signature check: proof-match gate →
// record receipt → bridge into release authority (evaluateRelease).
function applyReceipt(order_id, account, proofHash) {
  const order = quota.getOrder(order_id);
  if (!order.receipt_hash) return { error: 'unsupported' };
  if (proofHash !== order.receipt_hash) return { error: 'proof_mismatch' };
  quota.recordReceipt(order_id, account, proofHash, 'sig');
  let policy; try { policy = JSON.parse(order.release_policy); } catch (_) { policy = { type: 'owner_only' }; }
  const decision = releaseAuth.evaluateRelease({ policy, owner: order.owner, releaser: account, consented: quota.getReleaseConsents(order_id) });
  if (decision.authorized && decision.records_consent) quota.recordReleaseConsent(order_id, account, 'sig');
  let ended = false;
  if (decision.authorized && decision.ends) {
    const active = quota.getActiveClaimForOrder(order_id);
    if (active) { quota.endActiveClaimForRelease(active.claim_id); ended = true; }
  }
  return { decision, ended };
}

test('receipt_hash is persisted on the order at create', () => {
  const rh = h();
  const { order_id } = setupActiveClaim({ owner: u('alice'), cid: newCid(), receiptHash: rh });
  assert.equal(quota.getOrder(order_id).receipt_hash, rh);
});

test('order with no receipt_hash → receipts unsupported (NULL persists)', () => {
  const { order_id } = setupActiveClaim({ owner: u('alice'), cid: newCid() });
  assert.equal(quota.getOrder(order_id).receipt_hash, null);
  assert.equal(applyReceipt(order_id, u('bob'), h()).error, 'unsupported');
});

test('a mismatched proof_hash is rejected and records nothing', () => {
  const rh = h();
  const r1 = u('recip');
  const { order_id } = setupActiveClaim({ owner: u('alice'), cid: newCid(), receiptHash: rh, releasePolicy: { type: 'any_of', addresses: [r1] } });
  assert.equal(applyReceipt(order_id, r1, h()).error, 'proof_mismatch'); // wrong hash → forged
  assert.equal(quota.getReceipts(order_id).length, 0);
});

test('recordReceipt is idempotent per (order, recipient)', () => {
  const rh = h();
  const r1 = u('recip');
  const { order_id } = setupActiveClaim({ owner: u('alice'), cid: newCid(), receiptHash: rh, releasePolicy: { type: 'all_of', addresses: [r1, u('recip')] } });
  applyReceipt(order_id, r1, rh);
  applyReceipt(order_id, r1, rh);
  assert.equal(quota.getReceipts(order_id).length, 1);
});

test('any_of — one verified receipt ends hosting', () => {
  const rh = h();
  const cid = newCid();
  const r1 = u('recip');
  const { order_id, claim_id } = setupActiveClaim({ owner: u('alice'), cid, receiptHash: rh, releasePolicy: { type: 'any_of', addresses: [r1, u('recip')] } });
  const res = applyReceipt(order_id, r1, rh);
  assert.equal(res.ended, true);
  assert.equal(quota.getClaim(claim_id).state, 'cancelled');
  assert.equal(quota.getReceipts(order_id).length, 1);
});

test('all_of — claim ends only after EVERY recipient submits a verified receipt', () => {
  const rh = h();
  const cid = newCid();
  const r1 = u('recip'), r2 = u('recip');
  const { order_id, claim_id } = setupActiveClaim({ owner: u('alice'), cid, receiptHash: rh, releasePolicy: { type: 'all_of', addresses: [r1, r2] } });

  const a = applyReceipt(order_id, r1, rh);
  assert.equal(a.ended, false);                              // first receipt: still hosting
  assert.equal(quota.getClaim(claim_id).state, 'active');

  const b = applyReceipt(order_id, r2, rh);
  assert.equal(b.ended, true);                               // last receipt: threshold met
  assert.equal(quota.getClaim(claim_id).state, 'cancelled');
  assert.equal(quota.getReceipts(order_id).length, 2);
});

test('owner_only — a recipient receipt is recorded but does NOT end hosting', () => {
  const rh = h();
  const cid = newCid();
  const { order_id, claim_id } = setupActiveClaim({ owner: u('alice'), cid, receiptHash: rh, releasePolicy: { type: 'owner_only' } });
  const res = applyReceipt(order_id, u('bob'), rh);
  assert.equal(res.decision.authorized, false);              // bob can't release under owner_only
  assert.equal(res.ended, false);
  assert.equal(quota.getClaim(claim_id).state, 'active');
  assert.equal(quota.getReceipts(order_id).length, 1);       // ...but the receipt still stands
});
