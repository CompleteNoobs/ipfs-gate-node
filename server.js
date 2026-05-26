// ipfs-gate v0.1 — HTTP server (Express).
// Public endpoints: /reserve, /upload, /status/:cid, /ipfs/:cid
// Admin endpoints: /admin/* (Bearer ADMIN_KEY)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');

const quota = require('./quota');
const envelope = require('./envelope');
const hive = require('./hive-verify');
const moderation = require('./moderation');
const sweeper = require('./sweeper');
const kubo = require('./backends/kubo');

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);
// Default 0.0.0.0 — ipfs-gate is meant to live behind nginx in a docker network.
// Override to 127.0.0.1 only when running outside Docker (local dev on a laptop).
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PAYMENT_CURRENCY = process.env.PAYMENT_CURRENCY || 'CNOOBS';
const PAYMENT_AMOUNT = process.env.PAYMENT_AMOUNT || '1';
const IPFS_GATE_HIVE_ACCOUNT = (process.env.IPFS_GATE_HIVE_ACCOUNT || '').toLowerCase();
// parseFloat allows fractional days for testing (e.g. 0.001 ≈ 86s)
const DEFAULT_TTL_DAYS = parseFloat(process.env.DEFAULT_TTL_DAYS || '7');
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const RATE_LIMIT_RESERVE = parseInt(process.env.RATE_LIMIT_RESERVE_PER_MIN || '30', 10);
const RATE_LIMIT_UPLOAD = parseInt(process.env.RATE_LIMIT_UPLOAD_PER_MIN || '30', 10);
const PUBLIC_GATEWAY_BASE = process.env.PUBLIC_GATEWAY_BASE ||
  `https://ipfs.${process.env.SERVER_DOMAIN || 'localhost'}`;
// v0.1.4 — Cache-Control max-age for /ipfs/:cid responses. Browsers honour
// this; during dev/testing keep it short (e.g. 3600 = 1h) so pin expiry is
// observable without incognito tricks. Production default 86400 (1 day).
const GATEWAY_CACHE_MAX_AGE = parseInt(process.env.GATEWAY_CACHE_MAX_AGE || '86400', 10);

if (!IPFS_GATE_HIVE_ACCOUNT) {
  console.error('FATAL: IPFS_GATE_HIVE_ACCOUNT not set. Refusing to start.');
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.warn('WARN: ADMIN_KEY is empty — admin endpoints are unprotected. Set ADMIN_KEY in .env.');
}

// ─── App ────────────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '64kb' }));

// ─── Helpers ────────────────────────────────────────────────────────────────

function respondError(res, code, message, details) {
  const codeToStatus = {
    bad_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    gone: 410,
    payload_too_large: 413,
    rate_limited: 429,
    unprocessable_entity: 422,
    legal_takedown: 451,
    insufficient_storage: 507,
    internal_error: 500,
    bad_gateway: 502,
    not_implemented: 501
  };
  const status = codeToStatus[code] || 500;
  res.status(status).json({ error: code, message, details: details || {} });
}

function handleError(res, err, fallbackCode = 'internal_error') {
  if (err && err.code && (
    typeof err.code === 'string' && err.code !== 'SQLITE_CONSTRAINT_UNIQUE'
  )) {
    return respondError(res, err.code, err.message);
  }
  console.error('[server] unhandled error:', err && err.stack || err);
  return respondError(res, fallbackCode, err && err.message || String(err));
}

function requireAdmin(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!ADMIN_KEY || !m || m[1] !== ADMIN_KEY) {
    return respondError(res, 'unauthorized', 'admin auth required');
  }
  next();
}

function isoFromMs(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

// ─── Rate limiters ──────────────────────────────────────────────────────────

const reserveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_RESERVE,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => respondError(res, 'rate_limited', 'too many /reserve requests')
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_UPLOAD,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => respondError(res, 'rate_limited', 'too many /upload requests')
});

// ─── Multer for ciphertext uploads ──────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES + 1024 } // tiny slop for header overhead
});

// ─── Public endpoints ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'ipfs-gate',
    version: '0.1.0-dev',
    operator: IPFS_GATE_HIVE_ACCOUNT,
    payment: { currency: PAYMENT_CURRENCY, amount: PAYMENT_AMOUNT, max_size_mb: MAX_FILE_SIZE_MB, ttl_days: DEFAULT_TTL_DAYS }
  });
});

/**
 * POST /reserve
 * Body: { uploader, size_bytes }
 * Returns: { reservation_id, expires_at, payment: { currency, amount, escrow_account, memo, ttl_days }, max_size_bytes }
 */
app.post('/reserve', reserveLimiter, (req, res) => {
  try {
    const { uploader, size_bytes } = req.body || {};
    if (typeof uploader !== 'string' || !Number.isInteger(size_bytes)) {
      return respondError(res, 'bad_request', 'uploader (string) and size_bytes (integer) required');
    }

    const r = quota.createReservation(uploader.toLowerCase(), size_bytes);

    res.json({
      reservation_id: r.id,
      expires_at: isoFromMs(r.expires_at),
      payment: {
        currency: PAYMENT_CURRENCY,
        amount: String(PAYMENT_AMOUNT),
        escrow_account: IPFS_GATE_HIVE_ACCOUNT,
        memo: quota.getMemoForReservation(r.id),
        ttl_days: DEFAULT_TTL_DAYS
      },
      max_size_bytes: quota.MAX_FILE_SIZE_BYTES
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /upload
 * multipart/form-data with fields: reservation_id, tx_id, uploader_pubkey,
 *                                   upload_proof_sig, ciphertext (file)
 * Returns: { cid, size_bytes, expires_at, gateway_url, deduped, existing_expires_at }
 */
app.post('/upload', uploadLimiter, upload.single('ciphertext'), async (req, res) => {
  try {
    const { reservation_id, tx_id, uploader_pubkey, upload_proof_sig } = req.body || {};

    if (!reservation_id || !tx_id || !uploader_pubkey || !upload_proof_sig) {
      return respondError(res, 'bad_request', 'reservation_id, tx_id, uploader_pubkey, upload_proof_sig all required');
    }
    if (!req.file || !req.file.buffer) {
      return respondError(res, 'bad_request', 'ciphertext file field required');
    }

    const ciphertext = req.file.buffer;
    const sizeBytes = ciphertext.length;
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      return respondError(res, 'payload_too_large', `ciphertext exceeds ${MAX_FILE_SIZE_MB}MB`);
    }

    // 1. Look up reservation
    const r = quota.getReservation(reservation_id);
    if (!r) return respondError(res, 'not_found', 'reservation not found');
    if (r.status === 'expired') return respondError(res, 'gone', 'reservation expired');
    if (r.status !== 'pending') {
      return respondError(res, 'conflict', `reservation is ${r.status}, expected pending`);
    }
    if (r.expires_at < quota.now()) {
      return respondError(res, 'gone', 'reservation expired');
    }
    if (sizeBytes > r.size_bytes) {
      return respondError(res, 'payload_too_large', `ciphertext (${sizeBytes}) exceeds reserved size (${r.size_bytes})`);
    }

    const uploader = r.uploader;

    // 2. Banned-account check (banlist could've been added between reserve and upload)
    if (quota.isAccountBanned(uploader)) {
      return respondError(res, 'forbidden', 'uploader is banned');
    }

    // 3. Verify upload_proof_sig
    const ciphertextSha256Hex = envelope.sha256Hex(ciphertext);
    const sigOk = envelope.verifyUploadProof({
      ciphertextSha256Hex,
      reservationId: reservation_id,
      uploader,
      uploaderPubkey: uploader_pubkey,
      sigStr: upload_proof_sig
    });
    if (!sigOk) {
      return respondError(res, 'unauthorized', 'upload_proof_sig verification failed');
    }

    // 4. Replay protection (UNIQUE on payments.tx_id is the schema-level guarantee,
    //    but check here so we can return a clean error before doing Hive work)
    if (quota.getPaymentByTxId(tx_id)) {
      return respondError(res, 'conflict', 'tx_id already used');
    }

    // 5. Verify Hive payment (tx_id lookup + balance check)
    const expectedMemo = quota.getMemoForReservation(reservation_id);
    let payResult;
    try {
      payResult = await hive.verifyPayment({
        tx_id,
        sender: uploader,
        expectedMemo
      });
    } catch (e) {
      return handleError(res, e, 'unprocessable_entity');
    }

    // Sidechain confirmation — HARD reject. v0.1.2 (and earlier) used a balance
    // comparison which was useless: the escrow's existing balance always exceeded
    // the per-payment amount, so an under-balanced sender whose transfer was
    // rejected by the Hive-Engine sidechain still passed the check, and the file
    // got pinned for free. v0.1.3 polls getTransactionInfo on the Hive-Engine
    // blockchain RPC for an authoritative success/fail signal.
    let paymentStatus = 'confirmed';
    let sidechainResult;
    try {
      sidechainResult = await hive.verifyHiveEngineSidechain(tx_id);
    } catch (e) {
      console.error(`[server] sidechain RPC failed for ${tx_id}: ${e.message}`);
      quota.markReservationCancelled(reservation_id);
      return respondError(res, 'unprocessable_entity', `Hive-Engine sidechain unreachable: ${e.message}`);
    }
    if (sidechainResult.confirmed === false) {
      quota.markReservationCancelled(reservation_id);
      if (sidechainResult.reason === 'rejected') {
        const detail = (sidechainResult.errors || []).join('; ') || 'sidechain rejected the transfer';
        console.warn(`[server] sidechain rejected tx ${tx_id}: ${detail}`);
        return respondError(res, 'unprocessable_entity', `Hive-Engine rejected the transfer: ${detail}`);
      }
      // 'pending' — exhausted retries; safer to reject than to pin a phantom payment
      console.warn(`[server] sidechain still pending for tx ${tx_id} after retries`);
      return respondError(res, 'unprocessable_entity', 'Hive-Engine sidechain did not confirm the transfer within the retry budget. Try uploading again in ~30s.');
    }
    // Belt-and-braces: also record balance for the audit log
    try {
      payResult.balance_after = await hive.getHiveEngineBalance(IPFS_GATE_HIVE_ACCOUNT, PAYMENT_CURRENCY);
    } catch (e) {
      console.warn(`[server] post-confirm balance read failed: ${e.message}`);
    }

    // 6. Record payment + mark reservation paid (atomic)
    let payment;
    try {
      payment = quota.recordPayment({
        tx_id,
        reservation_id,
        uploader,
        currency: payResult.currency,
        amount: payResult.paid,
        memo: expectedMemo,
        block_num: payResult.block_num,
        status: paymentStatus
      });
    } catch (e) {
      return handleError(res, e);
    }
    quota.markReservationPaid(reservation_id, tx_id);

    // 7. Compute CID locally (defence: also verify against Kubo's response after pin)
    // For v0.1 we trust Kubo's returned CID since it's the same machine.

    // 8. Pin to Kubo
    let pinResult;
    try {
      pinResult = await kubo.pin(ciphertext);
    } catch (e) {
      // Pin failed. Mark reservation cancelled. Payment stays as 'confirmed' for now —
      // operator should refund manually + log via /admin/log-refund.
      quota.markReservationCancelled(reservation_id);
      console.error(`[server] kubo.pin failed for reservation ${reservation_id}: ${e.message}`);
      return handleError(res, e, 'bad_gateway');
    }
    const cid = pinResult.cid;

    // 9. Block list check on CID (could have been added between reserve and pin)
    if (quota.isCidBlocked(cid)) {
      // Unpin immediately
      try { await kubo.unpin(cid); } catch (e) { /* best-effort */ }
      quota.markReservationCancelled(reservation_id);
      return respondError(res, 'legal_takedown', 'this CID is blocked on this server');
    }

    // 10. Create pin record + mark reservation uploaded
    const pin = quota.createPin({
      cid,
      uploader,
      size_bytes: sizeBytes,
      payment_id: payment.id,
      ttl_days: DEFAULT_TTL_DAYS
    });
    quota.markReservationUploaded(reservation_id, pin.id);

    // 11. Dedup info (was there already an active pin for this CID before us?)
    const allActive = quota.getActivePinsForCid(cid);
    const deduped = allActive.length > 1;
    const otherExpiries = allActive.filter(p => p.id !== pin.id).map(p => p.expires_at);
    const existing_expires_at = otherExpiries.length > 0
      ? isoFromMs(Math.max(...otherExpiries))
      : null;

    res.json({
      cid,
      size_bytes: sizeBytes,
      expires_at: isoFromMs(pin.expires_at),
      gateway_url: `${PUBLIC_GATEWAY_BASE}/ipfs/${cid}`,
      deduped,
      existing_expires_at
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * GET /status/:cid
 */
app.get('/status/:cid', (req, res) => {
  try {
    const cid = req.params.cid;
    if (quota.isCidBlocked(cid)) {
      return respondError(res, 'legal_takedown', 'this CID has been removed');
    }
    const active = quota.getActivePinsForCid(cid);
    if (active.length === 0) {
      return respondError(res, 'not_found', 'CID not pinned');
    }
    const maxExpiry = Math.max(...active.map(p => p.expires_at));
    res.json({
      cid,
      pinned: true,
      expires_at: isoFromMs(maxExpiry),
      active_pin_count: active.length
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * GET /ipfs/:cid — gateway pass-through
 */
app.get('/ipfs/:cid', async (req, res) => {
  try {
    const cid = req.params.cid;
    if (quota.isCidBlocked(cid)) {
      return respondError(res, 'legal_takedown', 'this CID has been removed');
    }
    if (!quota.hasActivePinForCid(cid)) {
      return respondError(res, 'not_found', 'CID not pinned here');
    }
    const upstream = await kubo.cat(cid);
    res.set('Content-Type', 'application/octet-stream');
    // Cache-Control max-age is env-configurable (v0.1.4). Default 86400 (1 day)
    // for production; recommend 3600 or less during dev/testing so pin expiry
    // is visible without browser cache lying. Set GATEWAY_CACHE_MAX_AGE in .env.
    res.set('Cache-Control', `public, max-age=${GATEWAY_CACHE_MAX_AGE}`);
    // Stream the response
    upstream.body.pipeTo(new WritableStream({
      write(chunk) { res.write(Buffer.from(chunk)); },
      close() { res.end(); }
    })).catch(e => {
      console.warn(`[server] gateway stream failed for ${cid}: ${e.message}`);
      try { res.end(); } catch (_) {}
    });
  } catch (e) {
    return handleError(res, e);
  }
});

// ─── Admin endpoints ────────────────────────────────────────────────────────

app.post('/admin/ban', requireAdmin, async (req, res) => {
  try {
    const { hive_account, reason, refund_policy } = req.body || {};
    const result = moderation.banAccount({ hive_account, reason, refund_policy });

    // Unpin from Kubo (best-effort) for CIDs with no remaining active pin
    let unpinned = 0;
    for (const cid of result.cids_to_unpin) {
      try {
        await kubo.unpin(cid);
        unpinned++;
      } catch (e) {
        console.warn(`[admin/ban] failed to unpin ${cid}: ${e.message}`);
      }
    }
    if (unpinned > 0) {
      try { await kubo.gc(); } catch (e) { /* best-effort */ }
    }

    // Refunds — v0.1 stub. refund_policy='prorata' is recorded but not auto-executed.
    // Operator must do manual refunds + POST /admin/log-refund.
    res.json({
      banned: hive_account.toLowerCase(),
      pins_affected: result.pins_affected,
      cids_unpinned: unpinned,
      refunds_issued: 0,
      refunds_failed: 0,
      refunds_pending: refund_policy === 'prorata' ? result.pins_affected : 0,
      moderation_log_id: result.moderation_log_id
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/unban', requireAdmin, (req, res) => {
  try {
    const { hive_account } = req.body || {};
    const result = moderation.unbanAccount({ hive_account });
    res.json({ unbanned: hive_account.toLowerCase(), moderation_log_id: result.moderation_log_id });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/takedown', requireAdmin, async (req, res) => {
  try {
    const { cid, reason } = req.body || {};
    const result = moderation.takedownCid({ cid, reason });
    let unpinned = false;
    try {
      await kubo.unpin(cid);
      await kubo.gc();
      unpinned = true;
    } catch (e) {
      console.warn(`[admin/takedown] kubo.unpin failed: ${e.message}`);
    }
    res.json({
      cid,
      pins_affected: result.pins_affected,
      unpinned_from_kubo: unpinned,
      moderation_log_id: result.moderation_log_id
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/untakedown', requireAdmin, (req, res) => {
  try {
    const { cid } = req.body || {};
    const result = moderation.untakedownCid({ cid });
    res.json({ cid, moderation_log_id: result.moderation_log_id });
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/uploads', requireAdmin, (req, res) => {
  try {
    const account = (req.query.account || '').toLowerCase();
    if (!account) return respondError(res, 'bad_request', 'account query param required');
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const uploads = quota.listUploadsForAccount(account, limit, offset).map(u => ({
      pin_id: u.pin_id,
      cid: u.cid,
      size_bytes: u.size_bytes,
      created_at: isoFromMs(u.created_at),
      expires_at: isoFromMs(u.expires_at),
      status: u.status,
      status_reason: u.status_reason,
      payment: { tx_id: u.tx_id, amount: u.amount, currency: u.currency }
    }));
    res.json({
      account,
      total: quota.countUploadsForAccount(account),
      limit,
      offset,
      uploads
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/bans', requireAdmin, (req, res) => {
  try {
    const bans = moderation.listBans().map(b => ({
      hive_account: b.hive_account,
      banned_at: isoFromMs(b.banned_at),
      banned_by: b.banned_by,
      reason: b.reason,
      refund_policy: b.refund_policy
    }));
    res.json({ bans });
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/takedowns', requireAdmin, (req, res) => {
  try {
    const takedowns = moderation.listTakedowns().map(t => ({
      cid: t.cid,
      blocked_at: isoFromMs(t.blocked_at),
      blocked_by: t.blocked_by,
      reason: t.reason
    }));
    res.json({ takedowns });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/takedowns/import', requireAdmin, (req, res) => {
  try {
    const list = (req.body && req.body.takedowns) || [];
    const result = moderation.importTakedowns(list);
    res.json(result);
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/moderation/log', requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const { log, total } = moderation.listModerationLog(limit, offset);
    res.json({
      log: log.map(r => ({
        id: r.id,
        action: r.action,
        target_type: r.target_type,
        target: r.target,
        reason: r.reason,
        admin_id: r.admin_id,
        timestamp: isoFromMs(r.timestamp),
        metadata: r.metadata
      })),
      total,
      limit,
      offset
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const db = quota.open();
    const diskUsage = quota.getDiskUsage();
    const pinsByStatus = db.prepare(
      "SELECT status, COUNT(*) AS c FROM pins GROUP BY status"
    ).all().reduce((acc, r) => (acc[r.status] = r.c, acc), {});
    const paymentsByStatus = db.prepare(
      "SELECT status, COUNT(*) AS c FROM payments GROUP BY status"
    ).all().reduce((acc, r) => (acc[r.status] = r.c, acc), {});
    const totalRevenue = db.prepare(
      "SELECT currency, COALESCE(SUM(amount),0) AS total FROM payments WHERE status='confirmed' GROUP BY currency"
    ).all().reduce((acc, r) => (acc[r.currency] = r.total, acc), {});
    const activeBans = db.prepare(
      "SELECT COUNT(*) AS c FROM banned_accounts WHERE unbanned_at IS NULL"
    ).get().c;
    const activeTakedowns = db.prepare(
      "SELECT COUNT(*) AS c FROM blocked_cids WHERE unblocked_at IS NULL"
    ).get().c;
    const recentActions24h = db.prepare(
      "SELECT COUNT(*) AS c FROM moderation_log WHERE timestamp > ?"
    ).get(quota.now() - 24 * 60 * 60 * 1000).c;

    const kuboStats = await kubo.stats();

    res.json({
      disk: {
        limit_bytes: diskUsage.limit_bytes,
        used_bytes: diskUsage.used_bytes,
        available_bytes: diskUsage.available_bytes,
        used_percent: diskUsage.limit_bytes > 0
          ? Math.round((diskUsage.used_bytes / diskUsage.limit_bytes) * 10000) / 100
          : 0
      },
      pins: {
        active_count: pinsByStatus.active || 0,
        expired_count: pinsByStatus.expired || 0,
        banned_count: pinsByStatus.banned || 0,
        takedown_count: pinsByStatus.takedown || 0
      },
      payments: {
        confirmed_count: paymentsByStatus.confirmed || 0,
        orphan_count: paymentsByStatus.orphan || 0,
        paid_unconfirmed_count: paymentsByStatus.paid_unconfirmed || 0,
        refunded_count: paymentsByStatus.refunded || 0,
        total_revenue: totalRevenue
      },
      moderation: {
        active_bans: activeBans,
        active_takedowns: activeTakedowns,
        recent_actions_24h: recentActions24h
      },
      kubo: kuboStats
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/orphan-payments', requireAdmin, (req, res) => {
  try {
    const orphans = moderation.listOrphanPayments().map(p => ({
      payment_id: p.id,
      tx_id: p.tx_id,
      uploader: p.uploader,
      currency: p.currency,
      amount: p.amount,
      memo: p.memo,
      verified_at: isoFromMs(p.verified_at),
      status: p.status,
      reason_unmatched: p.memo && !quota.parseMemoReservationId(p.memo)
        ? 'memo did not match ipfs-gate:upload:<id> pattern'
        : 'matched memo but sidechain unconfirmed'
    }));
    res.json({ orphans });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/log-refund', requireAdmin, (req, res) => {
  try {
    const { payment_id, refund_tx_id, reason } = req.body || {};
    const result = moderation.logManualRefund({ payment_id, refund_tx_id, reason });
    res.json(result);
  } catch (e) {
    return handleError(res, e);
  }
});

// ─── 404 ────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  respondError(res, 'not_found', `no route for ${req.method} ${req.path}`);
});

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  quota.open();
  quota.runMigrations();

  // Probe Kubo (non-fatal — server can run, just won't be useful)
  try {
    const s = await kubo.stats();
    if (s.status !== 'ok') {
      console.warn(`[server] kubo backend status: ${s.status} (${s.error || 'unknown'})`);
    } else {
      console.log(`[server] kubo backend OK, version ${s.version}, used ${s.used_bytes} bytes`);
    }
  } catch (e) {
    console.warn(`[server] kubo probe failed at boot: ${e.message} — will continue, but uploads will fail until Kubo is reachable.`);
  }

  sweeper.start();

  app.listen(PORT, BIND_HOST, () => {
    console.log(`ipfs-gate v0.1 listening on ${BIND_HOST}:${PORT}`);
    console.log(`  operator account: @${IPFS_GATE_HIVE_ACCOUNT}`);
    console.log(`  payment: ${PAYMENT_AMOUNT} ${PAYMENT_CURRENCY} per upload (≤${MAX_FILE_SIZE_MB}MB, ${DEFAULT_TTL_DAYS}-day TTL)`);
    console.log(`  CORS origin: ${CORS_ORIGIN}`);
  });
}

boot().catch(e => {
  console.error('[server] boot failed:', e);
  process.exit(1);
});

// Graceful shutdown
function shutdown(sig) {
  console.log(`[server] received ${sig}, shutting down...`);
  sweeper.stop();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));