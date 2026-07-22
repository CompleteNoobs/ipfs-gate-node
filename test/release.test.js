// ipfs-gate v1 — Stage 3 release-authority tests (node:test).
// Pure policy evaluation (owner_only / any_of / all_of + owner override) AND the
// DB lifecycle: a met threshold ENDS the owner's active claim, then the §5
// lifecycle runs — release ≠ deletion, so a queued guardian still takes the baton;
// and an unmet all_of never blocks the normal expiry timer.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-rel-${crypto.randomBytes(6).toString('hex')}.db`);
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

function setupActiveClaim({ owner, cid, releasePolicy = null, sizeBytes = 5_000_000, paidHours = 5, startOffsetMs = 0 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: paidHours, copies: 1 }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `m:${tx}`, block_num: 1, status: 'confirmed' });
  const startTs = quota.now() - startOffsetMs;
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  const { claim_id, order_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id, sizeBytes, sizeMB: pricing.billableMB(sizeBytes),
    rateLocked: pricing.RATE_PER_MB_HOUR, paidHours, copies: 1, amountPaid: amount, currency: 'TEST', startTs, expiryTs, releasePolicy
  });
  return { claim_id, order_id, cid, owner };
}

function setupGuardian({ owner, cid, pledgedHours = 5, sizeBytes = 5_000_000 }) {
  const amount = pricing.calculateCost({ sizeBytes, hoursRequested: pledgedHours, copies: 1 }).total;
  const tx = newTx();
  const payment = quota.recordPayment({ tx_id: tx, reservation_id: null, uploader: owner, currency: 'TEST', amount, memo: `ipfs-gate:guardian:${cid}`, block_num: 1, status: 'confirmed' });
  const tnow = quota.now();
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: null, paymentId: payment.id, sizeBytes, sizeMB: pricing.billableMB(sizeBytes),
    rateLocked: pricing.RATE_PER_MB_HOUR, paidHours: pledgedHours, copies: 1, amountPaid: amount, currency: 'TEST',
    startTs: tnow, expiryTs: tnow, kind: 'guardian', state: 'dormant'
  });
  return { claim_id, cid };
}

// ─── pure policy evaluation ──────────────────────────────────────────────────

test('normalizeReleasePolicy validates + normalises addresses', () => {
  assert.deepEqual(releaseAuth.normalizeReleasePolicy({ type: 'owner_only' }), { type: 'owner_only', addresses: [] });
  assert.deepEqual(releaseAuth.normalizeReleasePolicy({ type: 'any_of', addresses: ['@Bob', 'bob', 'Carol'] }), { type: 'any_of', addresses: ['bob', 'carol'] });
  assert.throws(() => releaseAuth.normalizeReleasePolicy({ type: 'bogus' }), /must be one of/);
  assert.throws(() => releaseAuth.normalizeReleasePolicy({ type: 'all_of', addresses: [] }), /non-empty/);
});

test('owner_only — only the owner releases', () => {
  const policy = { type: 'owner_only' };
  assert.deepEqual(releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'alice' }), { authorized: true, ends: true, records_consent: false });
  assert.equal(releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'bob' }).authorized, false);
});

test('any_of — any listed recipient (or owner) ends it', () => {
  const policy = { type: 'any_of', addresses: ['bob', 'carol'] };
  assert.equal(releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'bob' }).ends, true);
  assert.equal(releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'dave' }).authorized, false);
  assert.equal(releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'alice' }).ends, true); // owner override
});

test('all_of — ends only once EVERY listed recipient has consented', () => {
  const policy = { type: 'all_of', addresses: ['bob', 'carol'] };
  const d1 = releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'bob', consented: [] });
  assert.equal(d1.authorized, true); assert.equal(d1.ends, false); assert.equal(d1.records_consent, true);
  const d2 = releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'carol', consented: ['bob'] });
  assert.equal(d2.ends, true);
  assert.equal(releaseAuth.evaluateRelease({ policy, owner: 'alice', releaser: 'alice' }).ends, true); // owner override skips the queue
});

// ─── DB lifecycle ────────────────────────────────────────────────────────────

test('all_of release ends the claim only after the last consent, then a guardian promotes', () => {
  const cid = newCid();
  const r1 = u('recip'), r2 = u('recip');
  const policy = { type: 'all_of', addresses: [r1, r2] };
  const { claim_id, order_id, owner } = setupActiveClaim({ owner: u('alice'), cid, releasePolicy: policy });
  const bar = setupGuardian({ owner: u('bob'), cid });

  // r1 consents → not yet
  const d1 = releaseAuth.evaluateRelease({ policy, owner, releaser: r1, consented: quota.getReleaseConsents(order_id) });
  assert.equal(d1.ends, false);
  quota.recordReleaseConsent(order_id, r1);
  assert.equal(quota.getClaim(claim_id).state, 'active');     // still hosting

  // r2 consents → threshold met
  const d2 = releaseAuth.evaluateRelease({ policy, owner, releaser: r2, consented: quota.getReleaseConsents(order_id) });
  assert.equal(d2.ends, true);
  quota.recordReleaseConsent(order_id, r2);

  const { claim, activated, fully_unpinned } = quota.endActiveClaimForRelease(quota.getActiveClaimForOrder(order_id).claim_id);
  assert.equal(claim.claim_id, claim_id);
  assert.equal(quota.getClaim(claim_id).state, 'cancelled');  // released
  assert.equal(fully_unpinned, false);                        // release ≠ deletion
  assert.equal(activated, bar.claim_id);                      // guardian took the baton
  assert.equal(quota.getClaim(bar.claim_id).state, 'active');
  assert.equal(quota.hasActivePinForCid(cid), true);          // file still alive
});

test('release with no guardian unpins the file', () => {
  const cid = newCid();
  const { order_id } = setupActiveClaim({ owner: u('alice'), cid, releasePolicy: { type: 'owner_only' } });
  const { fully_unpinned, activated } = quota.endActiveClaimForRelease(quota.getActiveClaimForOrder(order_id).claim_id);
  assert.equal(fully_unpinned, true);
  assert.equal(activated, null);
  assert.equal(quota.hasActivePinForCid(cid), false);
});

test('release consent is idempotent (re-signing does not double-count)', () => {
  const cid = newCid();
  const r1 = u('recip');
  const { order_id } = setupActiveClaim({ owner: u('alice'), cid, releasePolicy: { type: 'all_of', addresses: [r1, u('recip')] } });
  quota.recordReleaseConsent(order_id, r1);
  quota.recordReleaseConsent(order_id, r1);
  assert.equal(quota.getReleaseConsents(order_id).length, 1);
});

test('timer still expires if nobody consents (release is orthogonal to expiry)', () => {
  const cid = newCid();
  const r1 = u('recip'), r2 = u('recip');
  // already past expiry, all_of policy, zero consents
  const { claim_id } = setupActiveClaim({ owner: u('alice'), cid, releasePolicy: { type: 'all_of', addresses: [r1, r2] }, paidHours: 1, startOffsetMs: 2 * pricing.HOUR_MS });
  const res = quota.sweep();
  assert.ok(res.expired_claims >= 1);
  assert.equal(quota.getClaim(claim_id).state, 'expired');
  assert.equal(quota.hasActivePinForCid(cid), false);
});
