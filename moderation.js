// ipfs-gate v0.1 — moderation primitives.
// All admin-side state changes go through here so audit logging is consistent.

const quota = require('./quota');

const ADMIN_ID = 'operator'; // single-admin for v0.1
// Default offender refund policy on a forced takedown when the request omits one.
const DEFAULT_REFUND_POLICY = (process.env.REFUND_POLICY === 'none') ? 'none' : 'prorata';

function audit({ action, target_type, target, reason, metadata }) {
  const db = quota.open();
  db.prepare(`
    INSERT INTO moderation_log (action, target_type, target, reason, admin_id, timestamp, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    action,
    target_type,
    target,
    reason || null,
    ADMIN_ID,
    quota.now(),
    metadata ? JSON.stringify(metadata) : null
  );
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  return row.id;
}

/**
 * Ban a Hive account — IDENTITY kill (cohosting §7). Voids ALL the user's claims
 * (active + dormant) and marks their active pins 'banned', then reconciles each
 * CID they actively hosted: the file SURVIVES if ANOTHER user has a backstop on
 * it (FIFO baton-pass), and is only unpinned if nobody else funds it. The content
 * itself is NOT banned (use takedown for that).
 *
 * Returns { voided_claims, pins_affected, cids_to_unpin, activated, refund_policy,
 * moderation_log_id }. Refund execution is the CALLER's job (server settles each
 * voided claim per refund_policy — the banned user is not innocent). cids_to_unpin
 * = CIDs with no funder left; caller kubo-unpins + GCs.
 */
function banAccount({ hive_account, reason, refund_policy }) {
  if (!hive_account) throw Object.assign(new Error('hive_account required'), { code: 'bad_request' });
  if (!reason) throw Object.assign(new Error('reason required'), { code: 'bad_request' });
  if (!['none', 'prorata'].includes(refund_policy)) {
    throw Object.assign(new Error('refund_policy must be none|prorata'), { code: 'bad_request' });
  }
  const account = String(hive_account).toLowerCase();

  const db = quota.open();
  const tx = db.transaction(() => {
    const t = quota.now();

    db.prepare(`
      INSERT OR REPLACE INTO banned_accounts
        (hive_account, banned_at, banned_by, reason, refund_policy, unbanned_at, unbanned_by)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(account, t, ADMIN_ID, reason, refund_policy);

    // Collect the user's claims to void (active + dormant) BEFORE voiding — the
    // pre-void rows drive the refund math in the caller.
    const voidedClaims = db.prepare(
      "SELECT * FROM claims WHERE owner = ? AND state IN ('active','dormant')"
    ).all(account);

    db.prepare(
      "UPDATE claims SET state = 'cancelled' WHERE owner = ? AND state IN ('active','dormant')"
    ).run(account);

    const upd = db.prepare(`
      UPDATE pins SET status = 'banned', status_changed_at = ?, status_reason = ?
      WHERE uploader = ? AND status = 'active'
    `).run(t, reason, account);

    // Reconcile each CID the user actively hosted: another user's queued backstop
    // takes the baton (file survives); unpin only where nobody else funds it.
    // The banned user's own backstops were just voided, so they can't be promoted.
    const activeCids = [...new Set(voidedClaims.filter(c => c.state === 'active').map(c => c.cid))];
    const cidsToUnpin = [];
    const activated = [];
    for (const cid of activeCids) {
      const rec = quota.reconcileCidAfterEnd(cid);
      if (rec.activated) activated.push(rec.activated);
      else if (rec.unpin) cidsToUnpin.push(cid);
    }

    const mlId = audit({
      action: 'ban',
      target_type: 'account',
      target: account,
      reason,
      metadata: { refund_policy, pins_affected: upd.changes, claims_voided: voidedClaims.length, backstops_activated: activated.length }
    });

    return { voidedClaims, pins_affected: upd.changes, cidsToUnpin, activated, moderation_log_id: mlId };
  });

  const r = tx.immediate();
  return {
    voided_claims: r.voidedClaims,
    pins_affected: r.pins_affected,
    cids_to_unpin: r.cidsToUnpin,
    activated: r.activated,
    refund_policy,
    moderation_log_id: r.moderation_log_id
  };
}

function unbanAccount({ hive_account }) {
  if (!hive_account) throw Object.assign(new Error('hive_account required'), { code: 'bad_request' });
  const account = String(hive_account).toLowerCase();
  const db = quota.open();
  const t = quota.now();
  const r = db.prepare(`
    UPDATE banned_accounts SET unbanned_at = ?, unbanned_by = ?
    WHERE hive_account = ? AND unbanned_at IS NULL
  `).run(t, ADMIN_ID, account);
  if (r.changes === 0) {
    throw Object.assign(new Error('account is not currently banned'), { code: 'not_found' });
  }
  const moderation_log_id = audit({ action: 'unban', target_type: 'account', target: account });
  return { moderation_log_id };
}

/**
 * Takedown a single CID — CONTENT kill (cohosting §7). Adds the CID to the
 * permanent banned-CID registry (blocked at /upload + backstop-pledge so it
 * cannot reappear under any user), voids the active claim(s) AND the entire
 * dormant backstop queue, and marks pins 'takedown'. The bytes are always
 * unpinned by the caller (content kill — no backstop survives).
 *
 * Returns { voided_claims, pins_affected, refund_policy, moderation_log_id }.
 * Refund execution is the CALLER's job (server settles each voided claim: active
 * host/offender per refund_policy; dormant backstoppers = innocent → full refund).
 */
function takedownCid({ cid, reason, refund_policy }) {
  if (!cid) throw Object.assign(new Error('cid required'), { code: 'bad_request' });
  if (!reason) throw Object.assign(new Error('reason required'), { code: 'bad_request' });
  const policy = ['none', 'prorata'].includes(refund_policy) ? refund_policy : DEFAULT_REFUND_POLICY;
  const db = quota.open();
  const tx = db.transaction(() => {
    const t = quota.now();
    db.prepare(`
      INSERT OR REPLACE INTO blocked_cids
        (cid, blocked_at, blocked_by, reason, unblocked_at, unblocked_by)
      VALUES (?, ?, ?, ?, NULL, NULL)
    `).run(cid, t, ADMIN_ID, reason);

    // Void the active claim(s) AND the whole dormant backstop queue for the CID.
    const voidedClaims = db.prepare(
      "SELECT * FROM claims WHERE cid = ? AND state IN ('active','dormant')"
    ).all(cid);
    db.prepare(
      "UPDATE claims SET state = 'cancelled' WHERE cid = ? AND state IN ('active','dormant')"
    ).run(cid);

    const upd = db.prepare(`
      UPDATE pins SET status = 'takedown', status_changed_at = ?, status_reason = ?
      WHERE cid = ? AND status = 'active'
    `).run(t, reason, cid);

    const mlId = audit({
      action: 'takedown',
      target_type: 'cid',
      target: cid,
      reason,
      metadata: { pins_affected: upd.changes, claims_voided: voidedClaims.length, refund_policy: policy }
    });

    return { voidedClaims, pins_affected: upd.changes, moderation_log_id: mlId, refund_policy: policy };
  });
  const r = tx.immediate();
  return {
    voided_claims: r.voidedClaims,
    pins_affected: r.pins_affected,
    refund_policy: r.refund_policy,
    moderation_log_id: r.moderation_log_id
  };
}

function untakedownCid({ cid }) {
  if (!cid) throw Object.assign(new Error('cid required'), { code: 'bad_request' });
  const db = quota.open();
  const t = quota.now();
  const r = db.prepare(`
    UPDATE blocked_cids SET unblocked_at = ?, unblocked_by = ?
    WHERE cid = ? AND unblocked_at IS NULL
  `).run(t, ADMIN_ID, cid);
  if (r.changes === 0) {
    throw Object.assign(new Error('cid is not currently in takedown'), { code: 'not_found' });
  }
  const moderation_log_id = audit({ action: 'untakedown', target_type: 'cid', target: cid });
  return { moderation_log_id };
}

/**
 * Bulk-import takedowns from a JSON array.
 * Returns { imported, skipped_existing, errors }.
 */
function importTakedowns(list) {
  if (!Array.isArray(list)) {
    throw Object.assign(new Error('list must be an array'), { code: 'bad_request' });
  }
  const out = { imported: 0, skipped_existing: 0, errors: [] };
  const db = quota.open();
  const checkExisting = db.prepare('SELECT 1 FROM blocked_cids WHERE cid = ?');
  for (const entry of list) {
    try {
      if (!entry || !entry.cid || !entry.reason) {
        out.errors.push({ entry, error: 'missing cid or reason' });
        continue;
      }
      if (checkExisting.get(entry.cid)) {
        out.skipped_existing++;
        continue;
      }
      takedownCid({ cid: entry.cid, reason: entry.reason });
      out.imported++;
    } catch (e) {
      out.errors.push({ entry, error: e.message });
    }
  }
  return out;
}

function listBans() {
  return quota.open().prepare(
    'SELECT * FROM banned_accounts WHERE unbanned_at IS NULL ORDER BY banned_at DESC'
  ).all();
}

function listTakedowns() {
  return quota.open().prepare(
    'SELECT * FROM blocked_cids WHERE unblocked_at IS NULL ORDER BY blocked_at DESC'
  ).all();
}

function listModerationLog(limit = 50, offset = 0) {
  const db = quota.open();
  const total = db.prepare('SELECT COUNT(*) AS c FROM moderation_log').get().c;
  const log = db.prepare(
    'SELECT * FROM moderation_log ORDER BY timestamp DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  // Parse metadata JSON for clients
  for (const row of log) {
    if (row.metadata) {
      try { row.metadata = JSON.parse(row.metadata); } catch (e) { /* leave as string */ }
    }
  }
  return { log, total, limit, offset };
}

function listOrphanPayments() {
  return quota.open().prepare(
    "SELECT * FROM payments WHERE status IN ('orphan','paid_unconfirmed') ORDER BY verified_at DESC"
  ).all();
}

function logManualRefund({ payment_id, refund_tx_id, reason }) {
  if (!payment_id) throw Object.assign(new Error('payment_id required'), { code: 'bad_request' });
  if (!refund_tx_id) throw Object.assign(new Error('refund_tx_id required'), { code: 'bad_request' });
  const db = quota.open();
  const pmt = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment_id);
  if (!pmt) throw Object.assign(new Error('payment not found'), { code: 'not_found' });
  if (pmt.status === 'refunded') {
    throw Object.assign(new Error('payment already marked refunded'), { code: 'conflict' });
  }
  quota.markPaymentRefunded(payment_id, refund_tx_id);
  const moderation_log_id = audit({
    action: 'refund_issued',
    target_type: 'payment',
    target: String(payment_id),
    reason,
    metadata: { refund_tx_id }
  });
  return { payment_id, marked_refunded: true, moderation_log_id };
}

module.exports = {
  banAccount,
  unbanAccount,
  takedownCid,
  untakedownCid,
  importTakedowns,
  listBans,
  listTakedowns,
  listModerationLog,
  listOrphanPayments,
  logManualRefund,
  audit,
  ADMIN_ID
};