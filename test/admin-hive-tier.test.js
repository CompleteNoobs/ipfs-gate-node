// ipfs-gate v1 — Hive-account admin tier + whitelist CRUD, Stage C tests.
// Covers the moderation.js + quota.js layer: whitelist add/remove/list with
// audit attribution, admin_id threading through ban/unban/takedown/untakedown
// (backward-compatible 'operator' default), re-add-after-remove semantics,
// and cancelClaim's asAdmin ownership bypass (the delete-others'-pin
// primitive). The HTTP dual-auth path (verifyAdminAuth) is boot-smoked —
// its signature verification is verifySignedUserRequest, already proven by
// the signed user endpoints in production.
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
const moderation = require('../moderation');

const db = quota.open();
quota.runMigrations();

process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

function lastAuditRow() {
  return db.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT 1').get();
}

// Full active claim, same recipe as the other suites.
let txCounter = 0;
function setupClaim({ owner, cid = null, sizeBytes = 5_000_000, paidHours = 5 }) {
  cid = cid || ('Qm' + crypto.randomBytes(8).toString('hex'));
  const quotedAmount = pricing.calculateCost({ sizeBytes, hoursRequested: paidHours, copies: 1 }).total;
  const resv = quota.createReservation(owner, sizeBytes, 'public', { hoursRequested: paidHours, copies: 1, quotedAmount });
  const txId = `tx_admin_${++txCounter}_${crypto.randomBytes(4).toString('hex')}`;
  quota.markReservationPaid(resv.id, txId);
  const payment = quota.recordPayment({
    tx_id: txId, reservation_id: resv.id, uploader: owner, currency: 'TEST',
    amount: quotedAmount, memo: quota.getMemoForReservation(resv.id), block_num: 1, status: 'confirmed'
  });
  const startTs = quota.now();
  const expiryTs = startTs + paidHours * pricing.HOUR_MS;
  const pin = quota.createPin({ cid, uploader: owner, size_bytes: sizeBytes, payment_id: payment.id, expires_at: expiryTs });
  quota.markReservationUploaded(resv.id, pin.id);
  const { claim_id } = quota.createOrderWithClaim({
    cid, owner, pinId: pin.id, paymentId: payment.id,
    sizeBytes, sizeMB: pricing.billableMB(sizeBytes), rateLocked: pricing.RATE_PER_MB_HOUR,
    paidHours, copies: 1, amountPaid: quotedAmount, currency: 'TEST', startTs, expiryTs
  });
  return { claim_id, cid };
}

// ─── whitelist CRUD ──────────────────────────────────────────────────────────

test('addToWhitelist records the entry + attributes the audit row to the admin', () => {
  moderation.addToWhitelist({
    hive_account: 'Guest1', added_by: 'hive:familyadmin',
    quota_bytes: 10_000_000_000, fee_exempt: true, note: 'cousin'
  });
  const entry = quota.getWhitelistEntry('guest1');   // lowercased on write
  assert.ok(entry, 'entry exists');
  assert.equal(entry.added_by, 'hive:familyadmin');
  assert.equal(entry.quota_bytes, 10_000_000_000);
  assert.equal(entry.fee_exempt, 1);
  assert.equal(entry.note, 'cousin');
  const a = lastAuditRow();
  assert.equal(a.action, 'whitelist_add');
  assert.equal(a.target, 'guest1');
  assert.equal(a.admin_id, 'hive:familyadmin');
});

test('removeFromWhitelist soft-deletes + audits; removing twice → not_found', () => {
  moderation.addToWhitelist({ hive_account: 'guest2' });
  moderation.removeFromWhitelist({ hive_account: 'guest2', removed_by: 'hive:familyadmin' });
  assert.equal(quota.isAccountWhitelisted('guest2'), false);
  const a = lastAuditRow();
  assert.equal(a.action, 'whitelist_remove');
  assert.equal(a.admin_id, 'hive:familyadmin');
  assert.throws(
    () => moderation.removeFromWhitelist({ hive_account: 'guest2' }),
    (e) => e.code === 'not_found'
  );
});

test('re-adding a removed account resets the soft-delete', () => {
  moderation.addToWhitelist({ hive_account: 'guest3' });
  moderation.removeFromWhitelist({ hive_account: 'guest3' });
  moderation.addToWhitelist({ hive_account: 'guest3', quota_bytes: 5_000_000 });
  const entry = quota.getWhitelistEntry('guest3');
  assert.ok(entry, 'active again');
  assert.equal(entry.removed_at, null);
  assert.equal(entry.quota_bytes, 5_000_000, 'add doubles as update');
});

test('listWhitelist returns only active entries', () => {
  moderation.addToWhitelist({ hive_account: 'guest4' });
  moderation.addToWhitelist({ hive_account: 'guest5' });
  moderation.removeFromWhitelist({ hive_account: 'guest5' });
  const names = moderation.listWhitelist().map(w => w.hive_account);
  assert.ok(names.includes('guest4'));
  assert.ok(!names.includes('guest5'));
});

test('addToWhitelist validates quota_bytes', () => {
  assert.throws(
    () => moderation.addToWhitelist({ hive_account: 'badguest', quota_bytes: -1 }),
    (e) => e.code === 'bad_request'
  );
  assert.throws(
    () => moderation.addToWhitelist({ hive_account: 'badguest', quota_bytes: 1.5 }),
    (e) => e.code === 'bad_request'
  );
});

// ─── admin_id threading (backward-compatible) ────────────────────────────────

test('banAccount attributes banned_by + audit to the Hive-tier admin', () => {
  moderation.banAccount({ hive_account: 'villain1', reason: 'test', refund_policy: 'none', admin_id: 'hive:familyadmin' });
  const row = db.prepare("SELECT * FROM banned_accounts WHERE hive_account = 'villain1'").get();
  assert.equal(row.banned_by, 'hive:familyadmin');
  assert.equal(lastAuditRow().admin_id, 'hive:familyadmin');
  moderation.unbanAccount({ hive_account: 'villain1', admin_id: 'hive:familyadmin' });
  const row2 = db.prepare("SELECT * FROM banned_accounts WHERE hive_account = 'villain1'").get();
  assert.equal(row2.unbanned_by, 'hive:familyadmin');
});

test('omitting admin_id keeps the v0.1 operator attribution (backward compat)', () => {
  moderation.banAccount({ hive_account: 'villain2', reason: 'test', refund_policy: 'none' });
  const row = db.prepare("SELECT * FROM banned_accounts WHERE hive_account = 'villain2'").get();
  assert.equal(row.banned_by, 'operator');
  assert.equal(lastAuditRow().admin_id, 'operator');
});

test('takedownCid / untakedownCid thread admin_id the same way', () => {
  const cid = 'QmAdminTier' + crypto.randomBytes(4).toString('hex');
  moderation.takedownCid({ cid, reason: 'test', refund_policy: 'none', admin_id: 'hive:familyadmin' });
  const row = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(cid);
  assert.equal(row.blocked_by, 'hive:familyadmin');
  moderation.untakedownCid({ cid, admin_id: 'hive:familyadmin' });
  const row2 = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(cid);
  assert.equal(row2.unblocked_by, 'hive:familyadmin');
});

// ─── cancelClaim asAdmin (delete-others'-pin primitive) ──────────────────────

test('cancelClaim without asAdmin still enforces ownership', () => {
  const { claim_id } = setupClaim({ owner: 'victim1' });
  assert.throws(
    () => quota.cancelClaim(claim_id, 'someoneelse'),
    (e) => e.code === 'forbidden'
  );
});

test('cancelClaim asAdmin ends another account\'s claim; refund math is the offender path', () => {
  const { claim_id, cid } = setupClaim({ owner: 'victim2', paidHours: 5 });
  const r = quota.cancelClaim(claim_id, null, { asAdmin: true });
  assert.equal(r.claim.owner, 'victim2');
  assert.equal(quota.getClaim(claim_id).state, 'cancelled');
  assert.equal(r.fully_unpinned, true, 'sole funder gone → unpin');
  assert.equal(quota.getActiveClaimsForCid(cid).length, 0);
  // prorata for the freshly-started claim: min 1h consumed of 5h paid.
  const refund = pricing.calculateRefund(r.claim);
  assert.equal(refund.hours_refunded, 4);
  // policy 'none' forfeits regardless.
  assert.equal(pricing.forcedRefundAmount(r.claim, { policy: 'none', innocent: false }), 0);
});

test('admin pin-delete of one host leaves another host\'s claim on the same CID alive', () => {
  const cid = 'QmShared' + crypto.randomBytes(6).toString('hex');
  const a = setupClaim({ owner: 'hosta', cid });
  const b = setupClaim({ owner: 'hostb', cid });
  const r = quota.cancelClaim(a.claim_id, null, { asAdmin: true });
  assert.equal(r.fully_unpinned, false, 'hostb still funds the CID');
  const remaining = quota.getActiveClaimsForCid(cid);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].owner, 'hostb');
  assert.equal(remaining[0].claim_id, b.claim_id);
});
