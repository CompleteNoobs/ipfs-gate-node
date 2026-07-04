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
const pricing = require('./pricing');
const releaseAuth = require('./release-policy');

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
// parseFloat allows fractional days for testing (e.g. 0.001 ≈ 86s). In the v1
// claim model this is only the DEFAULT duration when a /reserve omits
// hours_requested — the authoritative timer is the claim's expiry_ts.
const DEFAULT_TTL_DAYS = parseFloat(process.env.DEFAULT_TTL_DAYS || '7');
const DEFAULT_HOURS = Math.max(pricing.MIN_HOURS, Math.round(DEFAULT_TTL_DAYS * 24));
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
// v0.2 — freshness window for signed user-API requests (replay protection on
// /uploads/by-user + /uploads/delete). The signed message embeds a unix-second
// timestamp; requests outside ±SKEW are rejected.
const SIGNED_REQUEST_MAX_SKEW_SEC = parseInt(process.env.SIGNED_REQUEST_MAX_SKEW_SEC || '300', 10);
// v0.2 — MIME types we will NOT serve inline on PUBLIC CIDs, even when claimed.
// These can host active content that would execute on the gate's own origin
// (stored-XSS). Public uploads of these types are forced to octet-stream +
// attachment disposition. Encrypted CIDs are always octet-stream regardless.
const PUBLIC_INLINE_DENY = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

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
// Behind nginx (one proxy hop), so the client IP is in X-Forwarded-For. Without
// this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and would
// otherwise key every request off the nginx container IP. '1' = trust the first
// proxy only (don't blindly trust a client-spoofed XFF chain).
app.set('trust proxy', 1);
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

/**
 * Verify a signed user-API request (no on-chain payment to anchor identity, so
 * this is the sole auth gate). Three checks, all must pass:
 *   1. ts is within ±SIGNED_REQUEST_MAX_SKEW_SEC of now (replay window).
 *   2. sig is a valid Hive signature over `message` by `pubkey`.
 *   3. pubkey is a CURRENT posting key of `account` on Hive (binds key→account).
 * Throws { code:'bad_request'|'unauthorized' } on failure; resolves on success.
 */
async function verifySignedUserRequest({ account, ts, pubkey, sig, message }) {
  if (typeof account !== 'string' || !/^[a-z0-9][a-z0-9.\-]*$/.test(account)) {
    throw Object.assign(new Error('valid hive_account required'), { code: 'bad_request' });
  }
  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum)) {
    throw Object.assign(new Error('ts (unix seconds) required'), { code: 'bad_request' });
  }
  if (typeof pubkey !== 'string' || typeof sig !== 'string' || !pubkey || !sig) {
    throw Object.assign(new Error('pubkey and sig required'), { code: 'bad_request' });
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skew > SIGNED_REQUEST_MAX_SKEW_SEC) {
    throw Object.assign(new Error('request timestamp outside freshness window'), { code: 'unauthorized' });
  }
  if (!envelope.verifyHiveSig(message, sig, pubkey)) {
    throw Object.assign(new Error('signature verification failed'), { code: 'unauthorized' });
  }
  let postingKeys;
  try {
    postingKeys = await hive.getAccountPostingPubkeys(account);
  } catch (e) {
    // Fail closed: if Hive is unreachable we cannot prove key ownership.
    throw Object.assign(new Error(`could not verify account keys: ${e.message}`), { code: 'unprocessable_entity' });
  }
  if (!postingKeys.includes(pubkey)) {
    throw Object.assign(new Error('pubkey is not a current posting key for this account'), { code: 'unauthorized' });
  }
}

// ─── Hive-account admin tier (WHITELIST-MODE-DESIGN-NOTES.md §5) ─────────────

/**
 * The Hive-account admin roster. Read at CALL time (same reasoning as
 * quota.whitelistModeEnabled — env is fixed per container, but tests flip it
 * in-process). Empty list = the tier is disabled and ADMIN_KEY is the only
 * admin auth, exactly as before.
 */
function serverAdminHiveAccounts() {
  return (process.env.SERVER_ADMIN_HIVE_ACCOUNTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Dual admin auth: Bearer ADMIN_KEY (box owner, unconditional, all powers) OR
 * a Hive-signed request from an account in SERVER_ADMIN_HIVE_ACCOUNTS (the
 * narrower tier — only the routes that call this accept it). The signed
 * message binds action AND target, so a signature authorising "ban bob" can't
 * be replayed to ban alice:
 *   ipfs-gate:admin-action:v1:<action>:<target>:<account>:<ts>
 * Auth fields (admin_account/admin_ts/admin_pubkey/admin_sig) are deliberately
 * distinct from each route's own primary fields — e.g. hive_account on
 * /admin/ban is the ban TARGET, never the admin.
 * Returns { adminId }: 'operator' for the Bearer tier, 'hive:<account>' for
 * the Hive tier — passed straight into moderation.js's admin_id param.
 * Throws { code:'unauthorized'|'forbidden'|...} on failure.
 */
async function verifyAdminAuth(req, { action, target }) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (ADMIN_KEY && m && m[1] === ADMIN_KEY) return { adminId: 'operator' };

  const src = (req.method === 'GET') ? req.query : (req.body || {});
  const { admin_account, admin_ts, admin_pubkey, admin_sig } = src;
  if (!admin_account || !admin_sig) {
    throw Object.assign(new Error('admin auth required'), { code: 'unauthorized' });
  }
  const account = String(admin_account).toLowerCase();
  if (!serverAdminHiveAccounts().includes(account)) {
    throw Object.assign(new Error('account is not a server admin'), { code: 'forbidden' });
  }
  const message = `ipfs-gate:admin-action:v1:${action}:${target}:${account}:${admin_ts}`;
  await verifySignedUserRequest({ account, ts: admin_ts, pubkey: admin_pubkey, sig: admin_sig, message });
  return { adminId: `hive:${account}` };
}

/**
 * Settle one already-cancelled (or expired) claim: compute the pro-rata refund,
 * record it in the durable refund ledger, and attempt the on-chain broadcast.
 * NEVER throws — the claim is closed regardless; the refund row carries
 * sent / pending / failed / skipped so the operator can see + retry. Returns a
 * small summary. 'pending' is the key-optional gate path (no IPFS_GATE_ACTIVE_KEY).
 */
/**
 * Record a refund of `amount` to claim.owner in the durable ledger and attempt
 * the on-chain broadcast. NEVER throws. Returns { amount, status, ... } where
 * status ∈ sent | pending | failed | skipped. `pending` is the key-optional path
 * (no IPFS_GATE_ACTIVE_KEY → operator settles manually). Shared by every refund
 * path (user cancel + admin force-action).
 */
async function broadcastRefund(claim, amount, reason) {
  const memo = `ipfs-gate:refund:${claim.claim_id}`;

  if (!amount || amount <= 0) {
    quota.recordRefund({
      claim_id: claim.claim_id, to_account: claim.owner, amount: 0,
      currency: claim.currency, memo, status: 'skipped',
      reason: `${reason}: nothing refundable (consumed/forfeit/dust)`
    });
    return { amount: 0, status: 'skipped' };
  }

  const rec = quota.recordRefund({
    claim_id: claim.claim_id, to_account: claim.owner, amount,
    currency: claim.currency, memo, status: 'pending', reason
  });

  try {
    const sent = await hive.sendRefund({ to: claim.owner, amount, currency: claim.currency, memo });
    quota.markRefundSettled(rec.refund_id, 'sent', sent.tx_id);
    return { amount, status: 'sent', tx_id: sent.tx_id, refund_id: rec.refund_id };
  } catch (e) {
    if (e.code === 'no_refund_key') {
      console.warn(`[refund] ${rec.refund_id} pending (no escrow key): ${amount} ${claim.currency} → @${claim.owner}`);
      return { amount, status: 'pending', refund_id: rec.refund_id };
    }
    quota.markRefundSettled(rec.refund_id, 'failed', null);
    console.error(`[refund] ${rec.refund_id} broadcast failed: ${e.message}`);
    return { amount, status: 'failed', refund_id: rec.refund_id, error: e.message };
  }
}

/**
 * Settle a user-initiated cancel refund (guardian spec §6). DORMANT guardian →
 * FULL escrow (minus the optional GUARDIAN_CANCEL_FEE_PCT, default 0); ACTIVE
 * claim (original / own_copy / activated guardian) → pro-rata. (claim is the
 * pre-flip row, so claim.state still reflects what it WAS.)
 */
async function settleClaimRefund(claim, reason = 'cancel') {
  const isDormant = claim.state === 'dormant';
  const amount = isDormant
    ? pricing.calculateDormantRefund(claim).amount
    : pricing.calculateRefund(claim, Date.now()).amount;
  return broadcastRefund(claim, amount, isDormant ? 'dormant_cancel' : reason);
}

/**
 * Settle a refund for an ADMIN force-action (cohosting §7). innocent=true (a
 * CID-ban guardian) → full escrow no fee; otherwise per refund_policy.
 */
async function settleForcedRefund(claim, { policy = 'prorata', innocent = false } = {}) {
  const amount = pricing.forcedRefundAmount(claim, { policy, innocent });
  const reason = innocent
    ? 'admin_void_innocent_guardian'
    : (policy === 'none' ? 'admin_void_forfeit' : 'admin_void_prorata');
  return broadcastRefund(claim, amount, reason);
}

// ─── Whitelist fee exemption (WHITELIST-MODE-DESIGN-NOTES.md §4) ─────────────

/**
 * The account's live whitelist entry IF it is currently fee-exempt, else null.
 * Recomputed fresh at every quote/pay call site — guardian pledge and own-copy
 * bypass /reserve, so there's no stored flag to reuse there.
 */
function feeExemptEntryFor(account) {
  if (!quota.whitelistModeEnabled()) return null;
  const entry = quota.getWhitelistEntry(account);
  return (entry && entry.fee_exempt) ? entry : null;
}

/**
 * Verify an on-chain payment, OR — when feeExempt — skip verification entirely
 * and record a synthetic zero-amount payment row so the FK-required
 * pins.payment_id / claims.payment_id still resolve. The synthetic tx_id must
 * still be globally unique (payments.tx_id UNIQUE) — callers namespace it off
 * the purpose + cid + account + timestamp. Throws with a `code` the caller
 * routes through handleError; the non-exempt path preserves the exact error
 * behavior the pledge/own-copy routes had inline before this refactor.
 */
async function verifyOrSkipPayment({ feeExempt, tx_id, sender, expectedMemo, expectedAmount, syntheticTxId }) {
  if (feeExempt) {
    const payment = quota.recordPayment({
      tx_id: syntheticTxId, reservation_id: null, uploader: sender,
      currency: PAYMENT_CURRENCY, amount: 0, memo: expectedMemo,
      block_num: null, status: 'confirmed'
    });
    return {
      payResult: { tx_id: syntheticTxId, sender, paid: 0, currency: PAYMENT_CURRENCY, block_num: null },
      payment
    };
  }

  let payResult;
  try {
    payResult = await hive.verifyPayment({ tx_id, sender, expectedMemo, expectedAmount });
  } catch (e) {
    if (!e.code) e.code = 'unprocessable_entity';
    throw e;
  }

  let sc;
  try {
    sc = await hive.verifyHiveEngineSidechain(tx_id);
  } catch (e) {
    throw Object.assign(
      new Error(`Hive-Engine sidechain unreachable: ${e.message}`),
      { code: 'unprocessable_entity' }
    );
  }
  if (sc.confirmed === false) {
    const detail = sc.reason === 'rejected'
      ? ((sc.errors || []).join('; ') || 'sidechain rejected the transfer')
      : 'sidechain did not confirm within the retry budget — try again in ~30s';
    throw Object.assign(
      new Error(`Hive-Engine did not confirm: ${detail}`),
      { code: 'unprocessable_entity' }
    );
  }

  const payment = quota.recordPayment({
    tx_id, reservation_id: null, uploader: sender,
    currency: payResult.currency, amount: payResult.paid,
    memo: expectedMemo, block_num: payResult.block_num, status: 'confirmed'
  });
  return { payResult, payment };
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

const userApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_USER_API_PER_MIN || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => respondError(res, 'rate_limited', 'too many requests')
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
    version: '1.0.0-dev',
    operator: IPFS_GATE_HIVE_ACCOUNT,
    // v1 claim model: cost is computed per upload (size × time × copies). The
    // flat `amount` is retired — clients must POST /reserve with size_bytes (and
    // optional hours_requested/copies) to get a quote. `currency`, `max_size_mb`
    // and the default duration stay advertised here for the picker UI.
    payment: {
      model: 'claim-mb-hour',
      currency: PAYMENT_CURRENCY,
      max_size_mb: MAX_FILE_SIZE_MB,
      default_hours: DEFAULT_HOURS,
      ttl_days: DEFAULT_TTL_DAYS
    },
    pricing: {
      rate_per_mb_hour: pricing.RATE_PER_MB_HOUR,
      min_hours: pricing.MIN_HOURS,
      mb_divisor: pricing.MB_DIVISOR,
      node_count: pricing.getNodeCount(),
      // copies selector range the gate offers (1..node_count) + the Cluster
      // self-heal leeway. node_count=1 → guardian is the only co-host option.
      copies_max: pricing.getNodeCount(),
      replication_leeway: pricing.REPLICATION_LEEWAY,
      guardian_cancel_fee_pct: pricing.GUARDIAN_CANCEL_FEE_PCT
    },
    features: {
      public_uploads: true, uploads_tab: true, claim_model: true,
      // Guardian feature (multi-participant hosting of the same CID):
      // POST /check (already-hosted detection), POST /claims/own-copy,
      // GET|POST /guardian/* (the dormant-pledge queue).
      guardian: true, own_copy: true, cid_check: true,
      // Whitelist / gated-server mode. Mode only — this endpoint has no caller
      // identity, so "am I whitelisted / am I admin" rides on the SIGNED
      // /uploads/by-user response instead. The admin roster is never listed.
      whitelist_mode: quota.whitelistModeEnabled()
    }
  });
});

/**
 * POST /reserve
 * Body: { uploader, size_bytes, hours_requested?, copies?, mode? }
 * v1 claim model: the gate computes a per-claim quote (size × time × copies) and
 * returns it as payment.amount. hours_requested defaults to DEFAULT_HOURS; copies
 * defaults to 1 (capped at NODE_COUNT). The flat-fee path is retired.
 * Returns: { reservation_id, expires_at, mode, payment:{currency,amount,escrow_account,memo}, quote:{...}, max_size_bytes }
 */
app.post('/reserve', reserveLimiter, (req, res) => {
  try {
    const { uploader, size_bytes } = req.body || {};
    // v0.2 — optional upload mode. 'encrypted' (default) = ciphertext, served
    // as octet-stream (unchanged). 'public' = plaintext, shareable link served
    // with the claimed MIME. Same reserve→pay→upload billing for both.
    const mode = (req.body && req.body.mode) || 'encrypted';
    if (typeof uploader !== 'string' || !Number.isInteger(size_bytes)) {
      return respondError(res, 'bad_request', 'uploader (string) and size_bytes (integer) required');
    }
    if (mode !== 'encrypted' && mode !== 'public') {
      return respondError(res, 'bad_request', "mode must be 'encrypted' or 'public'");
    }

    // Quote inputs. hours_requested / copies are optional; defaults keep a bare
    // {uploader,size_bytes} request working (it just gets the default duration).
    const rawHours = (req.body && req.body.hours_requested);
    const hoursRequested = (rawHours === undefined || rawHours === null) ? DEFAULT_HOURS : Number(rawHours);
    const rawCopies = (req.body && req.body.copies);
    const copiesRequested = (rawCopies === undefined || rawCopies === null) ? 1 : Number(rawCopies);
    if (!Number.isFinite(hoursRequested) || hoursRequested <= 0) {
      return respondError(res, 'bad_request', 'hours_requested must be a positive number');
    }

    // Whitelist fee exemption: quote at rate 0 for a fee-exempt account. The
    // resulting quoted_amount=0 on the reservation is the signal /upload uses
    // to skip on-chain payment verification. Surfaced in the response so the
    // $0 is never silent (same philosophy as copies_capped).
    const feeExempt = !!feeExemptEntryFor(uploader.toLowerCase());

    let quote;
    try {
      quote = pricing.calculateCost({
        sizeBytes: size_bytes, hoursRequested, copies: copiesRequested,
        ...(feeExempt ? { rate: 0 } : {})
      });
    } catch (e) {
      return handleError(res, e);
    }

    const r = quota.createReservation(uploader.toLowerCase(), size_bytes, mode, {
      hoursRequested: quote.billable_hrs,
      copies: quote.copies,
      quotedAmount: quote.total
    });

    res.json({
      reservation_id: r.id,
      expires_at: isoFromMs(r.expires_at),
      mode,
      payment: {
        currency: PAYMENT_CURRENCY,
        amount: String(quote.total),
        escrow_account: IPFS_GATE_HIVE_ACCOUNT,
        memo: quota.getMemoForReservation(r.id)
      },
      quote: {
        billable_mb: quote.billable_mb,
        billable_hrs: quote.billable_hrs,
        copies: quote.copies,
        // honest surfacing: if the client asked for more copies than the gate has
        // nodes, the granted `copies` is capped — don't let that be silent.
        copies_requested: Math.max(1, Math.floor(copiesRequested) || 1),
        copies_capped: quote.copies < Math.max(1, Math.floor(copiesRequested) || 1),
        node_count: pricing.getNodeCount(),
        replication: pricing.replicationConfig(quote.copies),
        rate_per_mb_hour: quote.rate,
        total: quote.total,
        currency: PAYMENT_CURRENCY,
        fee_exempt: feeExempt
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
    // v0.2 — public uploads carry a claimed plaintext MIME (rendering hint only,
    // never a security input — see GET /ipfs/:cid hardening). `kind` is v4call's
    // kind_hint, accepted for audit but not otherwise used by the gate.
    const claimedMime = (req.body && req.body.mime) || null;

    // tx_id is validated AFTER the reservation is loaded — a fee-exempt
    // reservation (quoted_amount 0, whitelist mode) legitimately has no
    // on-chain payment, so no tx_id to present.
    if (!reservation_id || !uploader_pubkey || !upload_proof_sig) {
      return respondError(res, 'bad_request', 'reservation_id, uploader_pubkey, upload_proof_sig all required');
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

    // 1b. Resolve upload mode from the (paid) reservation and validate the
    //     claimed MIME for public uploads BEFORE doing any Hive payment work,
    //     so malformed requests are rejected cheaply.
    const mode = r.mode || 'encrypted';
    let mime = null;
    if (mode === 'public') {
      if (typeof claimedMime !== 'string' || !MIME_RE.test(claimedMime) || claimedMime.length > 255) {
        return respondError(res, 'bad_request', 'public upload requires a valid `mime` field');
      }
      mime = claimedMime.toLowerCase();
    }

    // 1c. Optional release-authority policy (Stage 3). Validated up-front so a bad
    //     policy is rejected before any payment work. Defaults to owner_only.
    let releasePolicyObj = null;
    if (req.body && req.body.release_policy) {
      let parsed;
      try { parsed = JSON.parse(req.body.release_policy); }
      catch (e) { return respondError(res, 'bad_request', 'release_policy must be valid JSON'); }
      try { releasePolicyObj = releaseAuth.normalizeReleasePolicy(parsed); }
      catch (e) { return handleError(res, e); }
    }

    // 1d. Optional proof-of-receipt commitment (Stage 6). SHA-256(plaintext) the
    //     sender commits to; stored on the order so a recipient can later prove
    //     decryption (POST /claims/receipt). NOT in the public Reveal link, so a
    //     bystander (ciphertext only) can't reproduce it. NULL for public uploads.
    let receiptHash = null;
    if (req.body && req.body.receipt_hash) {
      const rh = String(req.body.receipt_hash).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(rh)) {
        return respondError(res, 'bad_request', 'receipt_hash must be a 64-char hex sha256');
      }
      receiptHash = rh;
    }

    // 2. Banned-account check (banlist could've been added between reserve and upload)
    if (quota.isAccountBanned(uploader)) {
      return respondError(res, 'forbidden', 'uploader is banned');
    }
    // 2b. Whitelist re-check (membership could've been revoked between reserve
    //     and upload — same defensive pattern as the ban re-check above).
    if (quota.whitelistModeEnabled() && !quota.isAccountWhitelisted(uploader)) {
      return respondError(res, 'forbidden', 'this server is invite-only — uploader is no longer whitelisted');
    }
    // 2c. Fee exemption: a $0 quote captured at /reserve (quoted_amount 0) plus
    //     a CURRENTLY fee-exempt whitelist entry means there is no on-chain
    //     payment to verify — a synthetic zero-amount payment row is recorded
    //     instead. Both conditions required: a paid-rate reservation is never
    //     skipped just because the account became exempt afterwards.
    const isFeeExempt = !!(feeExemptEntryFor(uploader) && r.quoted_amount === 0);
    if (!isFeeExempt && !tx_id) {
      return respondError(res, 'bad_request', 'tx_id required');
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

    // 4–6. Payment. Fee-exempt (whitelist) reservations skip the on-chain
    //    verify entirely and record a synthetic zero-amount payment row (the
    //    pins/claims FK still needs a payments row). The synthetic tx_id is
    //    namespaced off the reservation_id — one payment per reservation, and
    //    payments.tx_id UNIQUE stays the replay guard for both paths.
    const expectedMemo = quota.getMemoForReservation(reservation_id);
    const effectiveTxId = isFeeExempt ? `whitelist-free:upload:${reservation_id}` : tx_id;

    // 4. Replay protection (UNIQUE on payments.tx_id is the schema-level guarantee,
    //    but check here so we can return a clean error before doing Hive work)
    if (quota.getPaymentByTxId(effectiveTxId)) {
      return respondError(res, 'conflict', 'tx_id already used');
    }

    let payResult;
    if (isFeeExempt) {
      payResult = { tx_id: effectiveTxId, paid: 0, currency: PAYMENT_CURRENCY, block_num: null };
    } else {
      // 5. Verify Hive payment (tx_id lookup + amount/memo/currency validation).
      //    v1 claim model: the required amount is the per-claim QUOTE captured at
      //    /reserve (size × time × copies), not a flat fee.
      try {
        payResult = await hive.verifyPayment({
          tx_id,
          sender: uploader,
          expectedMemo,
          expectedAmount: r.quoted_amount
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
    }

    // 6. Record payment + mark reservation paid (atomic)
    let payment;
    try {
      payment = quota.recordPayment({
        tx_id: effectiveTxId,
        reservation_id,
        uploader,
        currency: payResult.currency,
        amount: payResult.paid,
        memo: expectedMemo,
        block_num: payResult.block_num,
        status: 'confirmed'
      });
    } catch (e) {
      return handleError(res, e);
    }
    quota.markReservationPaid(reservation_id, effectiveTxId);

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

    // 10. Derive the claim from the (paid) reservation's quote, then create the
    //     pin (mirroring the claim's expiry_ts) + the order/claim atomically.
    //     The claim's expiry_ts is the lifecycle authority; the pin row carries
    //     the same timestamp so disk/serve accounting and the sweeper agree.
    //     Guardian spec §2: if the CID is ALREADY live-hosted, this uploader is
    //     not the original host — their claim is an independent own_copy (same
    //     mechanics, distinct role). Checked before our own pin row lands.
    const hostedBefore = quota.alreadyHostedForCid(cid);
    const claimKind = hostedBefore ? 'own_copy' : 'original';
    const hoursPaid = (r.hours_requested && r.hours_requested > 0) ? r.hours_requested : DEFAULT_HOURS;
    const copies = pricing.cappedCopies(r.copies || 1);
    const sizeMB = pricing.billableMB(sizeBytes);
    // Fee-exempt claims lock rate 0 — the charged rate and the persisted
    // rate_locked must agree or a later pro-rata refund/extend would silently
    // bill the real rate on a claim that was free.
    const rateLocked = isFeeExempt ? 0 : pricing.RATE_PER_MB_HOUR;
    const startTs = quota.now();
    const expiryTs = startTs + hoursPaid * pricing.HOUR_MS;

    const pin = quota.createPin({
      cid,
      uploader,
      size_bytes: sizeBytes,
      payment_id: payment.id,
      expires_at: expiryTs,
      mode,
      mime
    });
    quota.markReservationUploaded(reservation_id, pin.id);

    const claim = quota.createOrderWithClaim({
      cid,
      owner: uploader,
      pinId: pin.id,
      paymentId: payment.id,
      sizeBytes,
      sizeMB,
      rateLocked,
      paidHours: hoursPaid,
      copies,
      amountPaid: payResult.paid,
      currency: payResult.currency,
      startTs,
      expiryTs,
      kind: claimKind,
      releasePolicy: releasePolicyObj,
      receiptHash
    });

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
      existing_expires_at,
      claim_id: claim.claim_id,
      order_id: claim.order_id,
      claim: {
        kind: claimKind,
        paid_hours: hoursPaid,
        copies,
        size_mb: sizeMB,
        rate_per_mb_hour: rateLocked,
        amount_paid: payResult.paid,
        currency: payResult.currency
      }
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * GET /status/:cid
 * Guardian feature: also surfaces the "already hosted" snapshot (how long the
 * file is paid to stay up + the co-hosting options) so a client that knows the
 * CID can offer own-copy / guardian without uploading anything.
 */
app.get('/status/:cid', (req, res) => {
  try {
    const cid = req.params.cid;
    if (quota.isCidBlocked(cid)) {
      return respondError(res, 'legal_takedown', 'this CID has been removed');
    }
    const hosted = quota.alreadyHostedForCid(cid);
    if (!hosted) {
      return respondError(res, 'not_found', 'CID not pinned');
    }
    res.json({
      cid,
      pinned: true,
      already_hosted: true,
      expires_at: isoFromMs(hosted.hosted_until),
      hosted_until: isoFromMs(hosted.hosted_until),
      active_pin_count: hosted.active_hosts,
      active_hosts: hosted.active_hosts,
      guardian_queue_depth: hosted.guardian_queue_depth
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /check — already-hosted detection (guardian spec §3 / §8 item 1).
 * multipart/form-data with a `ciphertext` file field (same field as /upload).
 * Computes the CID via Kubo only-hash — nothing is stored, pinned or paid —
 * and reports whether the file is already hosted here, how long it's paid to
 * stay up, and the two co-hosting options (own copy / guardian). Clients call
 * this FIRST, before /reserve + payment, so the user can choose to back the
 * existing copy instead of re-uploading and re-paying from scratch.
 */
app.post('/check', uploadLimiter, upload.single('ciphertext'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return respondError(res, 'bad_request', 'ciphertext file field required');
    }
    if (req.file.buffer.length > MAX_FILE_SIZE_BYTES) {
      return respondError(res, 'payload_too_large', `file exceeds ${MAX_FILE_SIZE_MB}MB`);
    }

    const { cid } = await kubo.cidOf(req.file.buffer);
    if (quota.isCidBlocked(cid)) {
      return respondError(res, 'legal_takedown', 'this CID is blocked on this server');
    }

    const hosted = quota.alreadyHostedForCid(cid);
    if (!hosted) {
      return res.json({ cid, already_hosted: false });
    }

    // Quote hints for both options at the default duration — the client re-quotes
    // with the user's chosen hours via /claims/own-copy/quote / /guardian/quote.
    const quote = pricing.calculateCost({ sizeBytes: hosted.size_bytes, hoursRequested: DEFAULT_HOURS, copies: 1 });
    res.json({
      cid,
      already_hosted: true,
      hosted_until: isoFromMs(hosted.hosted_until),
      active_hosts: hosted.active_hosts,
      guardian_queue_depth: hosted.guardian_queue_depth,
      options: {
        own_copy: {
          description: 'Pay now for your own independent copy (own timer, own refund).',
          quote_url: `/claims/own-copy/quote?cid=${encodeURIComponent(cid)}`,
          default_quote: { hours: quote.billable_hrs, amount: quote.total, currency: PAYMENT_CURRENCY }
        },
        guardian: {
          description: 'Pledge a budget that only spends if the file would otherwise be dropped; takes over hosting FIFO when the last live host ends.',
          quote_url: `/guardian/quote?cid=${encodeURIComponent(cid)}`,
          default_quote: { hours: quote.billable_hrs, amount: quote.total, currency: PAYMENT_CURRENCY }
        }
      }
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
    const serve = quota.getServeInfoForCid(cid);
    if (!serve) {
      return respondError(res, 'not_found', 'CID not pinned here');
    }
    const upstream = await kubo.cat(cid);

    // v0.2 — content-type. Encrypted CIDs are opaque ciphertext → octet-stream.
    // Public CIDs are served with their claimed MIME so links render directly,
    // EXCEPT active-content types (html/svg/...), which are forced to download
    // so a public link can't become stored-XSS on the gate's own origin. The
    // claimed MIME is a rendering hint, never trusted for a security decision.
    res.set('X-Content-Type-Options', 'nosniff');
    if (serve.mode === 'public' && serve.mime && MIME_RE.test(serve.mime) && !PUBLIC_INLINE_DENY.has(serve.mime)) {
      res.set('Content-Type', serve.mime);
    } else {
      res.set('Content-Type', 'application/octet-stream');
      if (serve.mode === 'public') {
        res.set('Content-Disposition', 'attachment');
      }
    }
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

// ─── Signed user endpoints (Hive posting-key auth, no payment) ───────────────
// These let a user manage their OWN uploads. Unlike /upload there is no
// on-chain payment to anchor identity, so the signed request IS the auth — see
// verifySignedUserRequest (proves the supplied pubkey is the account's posting
// key on Hive, not just that some key signed).

/**
 * GET /uploads/by-user
 * Query: hive_account, ts (unix seconds), pubkey, sig
 * Signed message: ipfs-gate:list-uploads:v1:<hive_account>:<ts>
 * Returns the caller's pinned uploads + (shared-disk) quota snapshot.
 */
app.get('/uploads/by-user', userApiLimiter, async (req, res) => {
  try {
    const account = String(req.query.hive_account || '').toLowerCase();
    const ts = req.query.ts;
    const pubkey = req.query.pubkey;
    const sig = req.query.sig;

    const message = `ipfs-gate:list-uploads:v1:${account}:${ts}`;
    await verifySignedUserRequest({ account, ts, pubkey, sig, message });

    const disk = quota.getDiskUsage();
    const rows = quota.listUploadsForAccount(account, 500, 0);
    const uploads = rows.map(p => {
      let guardians = null;
      if (p.status === 'active') {
        const dormant = quota.getDormantGuardiansForCid(p.cid);
        const activeOthers = quota.getActiveClaimsForCid(p.cid).filter(c => c.pin_id !== p.pin_id);
        guardians = {
          queue_depth: dormant.length,
          pledged_hours_total: dormant.reduce((s, c) => s + c.paid_hours, 0),
          co_hosts: activeOthers.length
        };
      }
      return {
        cid: p.cid,
        size_bytes: p.size_bytes,
        mime: p.mime || null,
        mode: p.mode || 'encrypted',
        kind: p.claim_kind || null,
        // claim_id enables extend/top-up from the client (null on pre-claim
        // legacy pins — those can't be extended, only re-uploaded).
        claim_id: p.claim_id || null,
        uploaded_at: isoFromMs(p.created_at),
        expires_at: isoFromMs(p.expires_at),
        pinned: p.status === 'active',
        status: p.status,
        public_url: (p.mode === 'public') ? `${PUBLIC_GATEWAY_BASE}/ipfs/${p.cid}` : null,
        guardians
      };
    });

    // Whitelist mode: this response already proves the caller's identity (the
    // signature above), so it's the privacy-safe place to answer "what am I on
    // this server" — whitelisted? fee-exempt? admin? — without a new signed
    // round-trip. With a per-account quota_bytes cap, the quota block switches
    // from the shared-disk figures to the caller's own cap (tightest-wins:
    // the global disk ceiling still applies at reserve time regardless).
    const wlMode = quota.whitelistModeEnabled();
    const wlEntry = wlMode ? quota.getWhitelistEntry(account) : null;
    const hasOwnCap = !!(wlEntry && wlEntry.quota_bytes != null);
    const ownUsage = hasOwnCap ? quota.getAccountUsage(account) : null;

    res.json({
      hive_account: account,
      quota: {
        // quota_scope keeps the client's "X of Y" label honest: shared_disk =
        // the gate-wide figures (no per-account cap), per_account = this
        // caller's own whitelist quota_bytes cap.
        quota_scope: hasOwnCap ? 'per_account' : 'shared_disk',
        used_bytes: hasOwnCap ? ownUsage.used_bytes : disk.used_bytes,
        limit_bytes: hasOwnCap ? wlEntry.quota_bytes : disk.limit_bytes,
        available_bytes: hasOwnCap
          ? Math.max(0, wlEntry.quota_bytes - ownUsage.used_bytes)
          : disk.available_bytes,
        pending_count: quota.getAccountPendingCount(account),
        whitelisted: wlMode ? !!wlEntry : null,
        fee_exempt: !!(wlEntry && wlEntry.fee_exempt)
      },
      is_admin: serverAdminHiveAccounts().includes(account),
      uploads
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * GET /claims/mine
 * Query: hive_account, ts (unix seconds), pubkey, sig
 * Signed message: ipfs-gate:list-claims:v1:<hive_account>:<ts>
 * Every claim this account holds, any kind/state (original/own_copy/guardian).
 * The client filters to kind='guardian' to render "My Guardian Pledges".
 */
app.get('/claims/mine', userApiLimiter, async (req, res) => {
  try {
    const account = String(req.query.hive_account || '').toLowerCase();
    const ts = req.query.ts;
    const pubkey = req.query.pubkey;
    const sig = req.query.sig;

    const message = `ipfs-gate:list-claims:v1:${account}:${ts}`;
    await verifySignedUserRequest({ account, ts, pubkey, sig, message });

    const claims = quota.listClaimsForOwner(account).map(c => ({
      claim_id: c.claim_id,
      order_id: c.order_id,
      cid: c.cid,
      kind: c.kind,
      state: c.state,
      paid_hours: c.paid_hours,
      copies_requested: c.copies_requested,
      size_mb: c.size_mb,
      rate_locked: c.rate_locked,
      amount_paid: c.amount_paid,
      currency: c.currency,
      pledge_order: c.pledge_order,
      pledge_budget: c.pledge_budget,
      start_ts: isoFromMs(c.start_ts),
      expiry_ts: isoFromMs(c.expiry_ts),
      created_ts: isoFromMs(c.created_ts)
    }));
    res.json({ hive_account: account, claims });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /uploads/delete
 * Body: { cid, hive_account, ts (unix seconds), pubkey, sig }
 * Signed message: ipfs-gate:delete-pin:v1:<cid>:<hive_account>:<ts>
 * Unpins ONLY the caller's pin row(s) for the CID. Kubo-unpins + GCs only when
 * no active pin remains for the CID (multi-pin-record dedup model).
 */
app.post('/uploads/delete', userApiLimiter, async (req, res) => {
  try {
    const { cid } = req.body || {};
    const account = String((req.body && req.body.hive_account) || '').toLowerCase();
    const ts = req.body && req.body.ts;
    const pubkey = req.body && req.body.pubkey;
    const sig = req.body && req.body.sig;

    if (typeof cid !== 'string' || !cid) {
      return respondError(res, 'bad_request', 'cid required');
    }

    const message = `ipfs-gate:delete-pin:v1:${cid}:${account}:${ts}`;
    await verifySignedUserRequest({ account, ts, pubkey, sig, message });

    // v1 claim model: "delete my upload" = cancel the caller's active claim(s)
    // on this CID → pro-rata refund. Fall back to the legacy pin-delete only for
    // pre-claim rows (no claim row exists for the CID/owner).
    const myActiveClaims = quota.getActiveClaimsForCid(cid).filter(c => c.owner === account);
    let removed = 0;
    let fullyUnpinned = false;
    const refunds = [];

    if (myActiveClaims.length > 0) {
      for (const c of myActiveClaims) {
        const r = quota.cancelClaim(c.claim_id, account);
        removed++;
        if (r.fully_unpinned) fullyUnpinned = true;
        const refund = await settleClaimRefund(r.claim, 'user_deleted');
        refunds.push({ claim_id: c.claim_id, activated_guardian: r.activated || null, ...refund });
      }
    } else {
      const result = quota.removePinForUploader(cid, account);
      removed = result.removed;
      fullyUnpinned = result.fully_unpinned;
    }

    if (removed === 0) {
      return respondError(res, 'not_found', 'no active upload for this account + cid');
    }

    if (fullyUnpinned) {
      try {
        await kubo.unpin(cid);
        await kubo.gc();
      } catch (e) {
        // Row is already freed in the DB; a stale Kubo pin is harmless (the next
        // sweeper GC will reclaim it). Log + report fully_unpinned honestly.
        console.warn(`[uploads/delete] kubo unpin/gc failed for ${cid}: ${e.message}`);
      }
    }

    res.json({ ok: true, cid, removed, fully_unpinned: fullyUnpinned, refunds });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /claims/cancel  (signed user request — Hive posting-key auth)
 * Body: { claim_id, hive_account, ts (unix seconds), pubkey, sig }
 * Signed message: ipfs-gate:cancel-claim:v1:<claim_id>:<hive_account>:<ts>
 * Cancels the caller's OWN active claim early → pro-rata refund (PRICING-V1 §3)
 * → unpins the CID iff no other active claim remains (last-funder unpin).
 */
app.post('/claims/cancel', userApiLimiter, async (req, res) => {
  try {
    const { claim_id } = req.body || {};
    const account = String((req.body && req.body.hive_account) || '').toLowerCase();
    const ts = req.body && req.body.ts;
    const pubkey = req.body && req.body.pubkey;
    const sig = req.body && req.body.sig;

    if (typeof claim_id !== 'string' || !claim_id) {
      return respondError(res, 'bad_request', 'claim_id required');
    }

    const message = `ipfs-gate:cancel-claim:v1:${claim_id}:${account}:${ts}`;
    await verifySignedUserRequest({ account, ts, pubkey, sig, message });

    // Atomic, status-locked cancel (quota.cancelClaim) — only one cancel wins, so
    // the refund settled below can't double-pay on a concurrent cancel. Cancelling
    // an ACTIVE claim may promote a queued guardian (FIFO) instead of unpinning;
    // cancelling a DORMANT guardian just voids the pledge (full-escrow refund).
    const { claim, fully_unpinned, activated, was_dormant } = quota.cancelClaim(claim_id, account);
    const refund = await settleClaimRefund(claim, 'cancel');

    if (fully_unpinned) {
      try {
        await kubo.unpin(claim.cid);
        await kubo.gc();
      } catch (e) {
        console.warn(`[claims/cancel] kubo unpin/gc failed for ${claim.cid}: ${e.message}`);
      }
    }

    res.json({
      ok: true, claim_id, cid: claim.cid,
      was_dormant: !!was_dormant,
      fully_unpinned,
      activated_guardian: activated || null,
      refund
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /claims/release  (signed user request — Hive posting-key auth)
 * Body: { order_id, hive_account, ts (unix seconds), pubkey, sig }
 * Signed message: ipfs-gate:release:v1:<order_id>:<hive_account>:<ts>
 * A recipient (or the owner) consents to stop hosting. When the order's
 * release_policy threshold is met (owner override / any_of / all_of), the order's
 * active claim is ENDED → pro-rata refund to the owner → the §5 lifecycle runs
 * (release ≠ deletion: a queued guardian still takes the baton).
 */
app.post('/claims/release', userApiLimiter, async (req, res) => {
  try {
    const { order_id } = req.body || {};
    const account = String((req.body && req.body.hive_account) || '').toLowerCase();
    const ts = req.body && req.body.ts;
    const pubkey = req.body && req.body.pubkey;
    const sig = req.body && req.body.sig;

    if (typeof order_id !== 'string' || !order_id) {
      return respondError(res, 'bad_request', 'order_id required');
    }

    const message = `ipfs-gate:release:v1:${order_id}:${account}:${ts}`;
    await verifySignedUserRequest({ account, ts, pubkey, sig, message });

    const order = quota.getOrder(order_id);
    if (!order) return respondError(res, 'not_found', 'order not found');

    let policy;
    try { policy = JSON.parse(order.release_policy); } catch (e) { policy = { type: 'owner_only' }; }

    const consented = quota.getReleaseConsents(order_id);
    let decision;
    try {
      decision = releaseAuth.evaluateRelease({ policy, owner: order.owner, releaser: account, consented });
    } catch (e) {
      return handleError(res, e);
    }

    if (!decision.authorized) {
      return respondError(res, 'forbidden', `@${account} is not authorised to release this order under its ${policy.type} policy`);
    }
    if (decision.records_consent) {
      quota.recordReleaseConsent(order_id, account, sig);
    }

    // all_of still waiting for the rest of the set
    if (!decision.ends) {
      const addresses = (policy.addresses || []).map(a => String(a).toLowerCase());
      const have = quota.getReleaseConsents(order_id);
      return res.json({
        ok: true, order_id, released: false, policy_type: policy.type,
        consents: have, needed: addresses.length,
        got: have.filter(a => addresses.includes(a)).length
      });
    }

    // Threshold met → end the order's active claim (idempotent if already closed).
    const activeClaim = quota.getActiveClaimForOrder(order_id);
    if (!activeClaim) {
      return res.json({ ok: true, order_id, released: true, ended: false, note: 'no active claim to end (already closed)' });
    }

    const { claim, fully_unpinned, activated } = quota.endActiveClaimForRelease(activeClaim.claim_id);
    const refund = await settleClaimRefund(claim, 'released');

    if (fully_unpinned) {
      try {
        await kubo.unpin(claim.cid);
        await kubo.gc();
      } catch (e) {
        console.warn(`[claims/release] kubo unpin/gc failed for ${claim.cid}: ${e.message}`);
      }
    }

    res.json({
      ok: true, order_id, released: true, ended: true,
      claim_id: claim.claim_id, cid: claim.cid, policy_type: policy.type,
      fully_unpinned, activated_guardian: activated || null, refund
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /claims/receipt  (Stage 6 — proof-of-receipt + release bridge)
 * Body: { order_id, hive_account, ts (unix s), pubkey, sig, proof_hash }
 * Signed message: ipfs-gate:receipt:v1:<order_id>:<hive_account>:<ts>:<proof_hash>
 *
 * proof_hash = SHA-256(decrypted plaintext). Only an account that actually
 * decrypted the file can reproduce it (it is NOT in the public Reveal link), so a
 * matching, posting-key-signed proof_hash proves decryption. We record the receipt
 * (audit) AND fold it into the order's release authority exactly like /claims/release
 * — a verified receipt IS a release consent. owner_only / not-a-listed-recipient
 * receipts are still recorded but don't end hosting (the owner releases those).
 */
app.post('/claims/receipt', userApiLimiter, async (req, res) => {
  try {
    const { order_id } = req.body || {};
    const account = String((req.body && req.body.hive_account) || '').toLowerCase();
    const ts = req.body && req.body.ts;
    const pubkey = req.body && req.body.pubkey;
    const sig = req.body && req.body.sig;
    const proofHash = String((req.body && req.body.proof_hash) || '').toLowerCase();

    if (typeof order_id !== 'string' || !order_id) {
      return respondError(res, 'bad_request', 'order_id required');
    }
    if (!/^[a-f0-9]{64}$/.test(proofHash)) {
      return respondError(res, 'bad_request', 'proof_hash must be a 64-char hex sha256');
    }

    // proof_hash is bound INTO the signed message so it can't be swapped/replayed.
    const message = `ipfs-gate:receipt:v1:${order_id}:${account}:${ts}:${proofHash}`;
    await verifySignedUserRequest({ account, ts, pubkey, sig, message });

    const order = quota.getOrder(order_id);
    if (!order) return respondError(res, 'not_found', 'order not found');
    if (!order.receipt_hash) {
      return respondError(res, 'unprocessable_entity', 'this order has no receipt commitment (uploaded before proof-of-receipt, or a public upload) — receipts unsupported');
    }

    // Proof of decryption: the recipient must reproduce SHA-256(plaintext), which
    // only an account holding the decrypted bytes can compute.
    if (proofHash !== String(order.receipt_hash).toLowerCase()) {
      return respondError(res, 'forbidden', 'proof does not match — you must actually decrypt the file to confirm receipt');
    }

    // Record the receipt (idempotent audit of who decrypted).
    quota.recordReceipt(order_id, account, proofHash, sig);

    // Bridge into release authority — a verified receipt is a release consent.
    let policy;
    try { policy = JSON.parse(order.release_policy); } catch (e) { policy = { type: 'owner_only' }; }
    const consented = quota.getReleaseConsents(order_id);
    let decision;
    try {
      decision = releaseAuth.evaluateRelease({ policy, owner: order.owner, releaser: account, consented });
    } catch (e) {
      return handleError(res, e);
    }
    const receiptList = quota.getReceipts(order_id).map(r => r.recipient);

    // Decrypted, but not a release participant under this policy (owner_only, or
    // not in addresses): receipt stands as audit, hosting is unchanged.
    if (!decision.authorized) {
      return res.json({
        ok: true, order_id, receipt_recorded: true, released: false,
        policy_type: policy.type, receipts: receiptList,
        note: `receipt recorded; @${account} is not a release participant under the ${policy.type} policy`
      });
    }
    if (decision.records_consent) {
      quota.recordReleaseConsent(order_id, account, sig);
    }

    // all_of still waiting for the rest of the set.
    if (!decision.ends) {
      const addresses = (policy.addresses || []).map(a => String(a).toLowerCase());
      const have = quota.getReleaseConsents(order_id);
      return res.json({
        ok: true, order_id, receipt_recorded: true, released: false, policy_type: policy.type,
        consents: have, needed: addresses.length,
        got: have.filter(a => addresses.includes(a)).length, receipts: receiptList
      });
    }

    // Threshold met → end the order's active claim (same as /claims/release).
    const activeClaim = quota.getActiveClaimForOrder(order_id);
    if (!activeClaim) {
      return res.json({ ok: true, order_id, receipt_recorded: true, released: true, ended: false, note: 'no active claim to end (already closed)', receipts: receiptList });
    }
    const { claim, fully_unpinned, activated } = quota.endActiveClaimForRelease(activeClaim.claim_id);
    const refund = await settleClaimRefund(claim, 'released-via-receipt');
    if (fully_unpinned) {
      try { await kubo.unpin(claim.cid); await kubo.gc(); }
      catch (e) { console.warn(`[claims/receipt] kubo unpin/gc failed for ${claim.cid}: ${e.message}`); }
    }
    res.json({
      ok: true, order_id, receipt_recorded: true, released: true, ended: true,
      claim_id: claim.claim_id, cid: claim.cid, policy_type: policy.type,
      fully_unpinned, activated_guardian: activated || null, refund, receipts: receiptList
    });
  } catch (e) {
    return handleError(res, e);
  }
});

// ─── Guardian (co-hosting safety-net; UI label "Guardian") ──────────────────
// A guardian is a prepaid, dormant claim on an already-hosted CID that activates
// (FIFO — strictly pledge order) only if the file would otherwise be deleted
// (guardian spec §4). It adds no bytes (leans on the existing copy), so it needs
// no disk reservation — just pay into escrow and the gate records the dormant
// claim. Replay-guarded by payments.tx_id UNIQUE. The pledged budget is consumed
// only across the stretch the guardian is the live host; a dormant cancel
// refunds it in full (spec §6).
//
// Routes live at /guardian/*; the pre-rename /backstop/* paths stay as aliases
// (the alias quotes/verifies the legacy ipfs-gate:backstop:<cid> memo, so a
// pledge started against an old quote still lands after an upgrade).

function guardianQuoteHandler(memoPurpose) {
  return (req, res) => {
    try {
      const cid = String(req.query.cid || '');
      const hours = (req.query.hours === undefined) ? DEFAULT_HOURS : Number(req.query.hours);
      const copies = (req.query.copies === undefined) ? 1 : Number(req.query.copies);
      if (!cid) return respondError(res, 'bad_request', 'cid required');
      if (quota.isCidBlocked(cid)) return respondError(res, 'legal_takedown', 'this CID is blocked on this server');

      const hosted = quota.alreadyHostedForCid(cid);
      if (!hosted) {
        return respondError(res, 'not_found', 'CID is not currently hosted here — you can only guard a live file');
      }
      // Optional ?hive_account= lets a fee-exempt account see its real $0 up
      // front instead of discovering the exemption at pay time. No signature —
      // this is already a public GET, and membership isn't sensitive to the
      // account asking about itself. POST /guardian/pledge recomputes it.
      const quoteAccount = String(req.query.hive_account || '').toLowerCase();
      const feeExempt = !!(quoteAccount && feeExemptEntryFor(quoteAccount));
      const quote = pricing.calculateCost({
        sizeBytes: hosted.size_bytes, hoursRequested: hours, copies,
        ...(feeExempt ? { rate: 0 } : {})
      });

      res.json({
        cid,
        mode: 'guardian',
        hosted_until: isoFromMs(hosted.hosted_until),
        payment: {
          currency: PAYMENT_CURRENCY,
          amount: String(quote.total),
          escrow_account: IPFS_GATE_HIVE_ACCOUNT,
          memo: `ipfs-gate:${memoPurpose}:${cid}`
        },
        quote: {
          billable_mb: quote.billable_mb,
          billable_hrs: quote.billable_hrs,
          copies: quote.copies,
          copies_requested: Math.max(1, Math.floor(copies) || 1),
          copies_capped: quote.copies < Math.max(1, Math.floor(copies) || 1),
          node_count: pricing.getNodeCount(),
          replication: pricing.replicationConfig(quote.copies),
          rate_per_mb_hour: quote.rate,
          total: quote.total,
          currency: PAYMENT_CURRENCY,
          fee_exempt: feeExempt
        },
        queue_depth: hosted.guardian_queue_depth
      });
    } catch (e) {
      return handleError(res, e);
    }
  };
}

function guardianPledgeHandler(memoPurpose) {
  return async (req, res) => {
    try {
      const { pledger, cid, tx_id } = req.body || {};
      const hours = (req.body && req.body.hours_requested === undefined) ? DEFAULT_HOURS : Number(req.body.hours_requested);
      const copies = (req.body && req.body.copies === undefined) ? 1 : Number(req.body.copies);
      if (typeof pledger !== 'string' || !pledger || typeof cid !== 'string' || !cid) {
        return respondError(res, 'bad_request', 'pledger, cid required');
      }
      const account = pledger.toLowerCase();
      if (quota.isAccountBanned(account)) return respondError(res, 'forbidden', 'pledger is banned');
      // Whitelist mode: this route bypasses createReservation, so the gate is
      // inlined here (same pattern as the ban check above). Membership only —
      // a dormant pledge adds no bytes, so no per-account quota check.
      if (quota.whitelistModeEnabled() && !quota.isAccountWhitelisted(account)) {
        return respondError(res, 'forbidden', 'this server is invite-only — pledger is not whitelisted');
      }
      if (quota.isCidBlocked(cid)) return respondError(res, 'legal_takedown', 'this CID is blocked on this server');

      // Fee exemption recomputed fresh — this route never saw /reserve, so
      // there's no stored flag to trust. Exempt pledges need no tx_id.
      const feeExempt = !!feeExemptEntryFor(account);
      if (!feeExempt && !tx_id) {
        return respondError(res, 'bad_request', 'tx_id required');
      }

      const hosted = quota.alreadyHostedForCid(cid);
      if (!hosted) {
        return respondError(res, 'not_found', 'CID is not currently hosted here — you can only guard a live file');
      }
      const quote = pricing.calculateCost({
        sizeBytes: hosted.size_bytes, hoursRequested: hours, copies,
        ...(feeExempt ? { rate: 0 } : {})
      });

      if (!feeExempt && quota.getPaymentByTxId(tx_id)) return respondError(res, 'conflict', 'tx_id already used');

      const expectedMemo = `ipfs-gate:${memoPurpose}:${cid}`;
      let payResult, payment;
      try {
        ({ payResult, payment } = await verifyOrSkipPayment({
          feeExempt, tx_id, sender: account, expectedMemo, expectedAmount: quote.total,
          syntheticTxId: `whitelist-free:${memoPurpose}:${cid}:${account}:${quota.now()}`
        }));
      } catch (e) {
        return handleError(res, e, 'unprocessable_entity');
      }

      // Dormant claim: no pin, placeholder start/expiry (set on activation).
      // pledge_order (FIFO slot) + pledge_budget are stamped by the DB layer.
      const tnow = quota.now();
      const claim = quota.createOrderWithClaim({
        cid, owner: account, pinId: null, paymentId: payment.id,
        sizeBytes: hosted.size_bytes, sizeMB: quote.billable_mb,
        rateLocked: feeExempt ? 0 : pricing.RATE_PER_MB_HOUR,
        paidHours: quote.billable_hrs, copies: quote.copies,
        amountPaid: payResult.paid, currency: payResult.currency,
        startTs: tnow, expiryTs: tnow,
        kind: 'guardian', state: 'dormant'
      });

      const queue = quota.getDormantGuardiansForCid(cid).map(c => c.claim_id);
      res.json({
        ok: true, claim_id: claim.claim_id, cid, kind: 'guardian', state: 'dormant',
        pledged_hours: quote.billable_hrs, copies: quote.copies,
        pledge_order: claim.pledge_order,
        pledge_budget: payResult.paid,
        amount_escrowed: payResult.paid, currency: payResult.currency,
        queue_position: queue.indexOf(claim.claim_id) + 1, queue_depth: queue.length
      });
    } catch (e) {
      return handleError(res, e);
    }
  };
}

function guardianQueueHandler(req, res) {
  try {
    const cid = String(req.query.cid || '');
    if (!cid) return respondError(res, 'bad_request', 'cid required');
    const active = quota.getActiveClaimsForCid(cid).map(c => ({
      claim_id: c.claim_id, owner: c.owner, kind: c.kind,
      paid_hours: c.paid_hours, expires_at: isoFromMs(c.expiry_ts)
    }));
    const dormant = quota.getDormantGuardiansForCid(cid).map((c, i) => ({
      position: i + 1, pledge_order: c.pledge_order, claim_id: c.claim_id, owner: c.owner,
      pledged_hours: c.paid_hours, pledge_budget: c.pledge_budget,
      amount_escrowed: c.amount_paid, currency: c.currency
    }));
    res.json({
      cid,
      active,
      guardian_queue: dormant,
      total_pledged_hours: dormant.reduce((s, c) => s + c.pledged_hours, 0)
    });
  } catch (e) {
    return handleError(res, e);
  }
}

/**
 * GET /guardian/quote?cid=<cid>&hours=<h>&copies=<c>
 * Quote the budget to guard an already-hosted CID. Pay this amount to
 * payment.escrow_account with payment.memo, then POST /guardian/pledge.
 *
 * POST /guardian/pledge
 * Body: { pledger, cid, hours_requested?, copies?, tx_id }
 * Verifies the on-chain escrow payment (memo ipfs-gate:guardian:<cid>, sender =
 * pledger, amount ≥ quote) and records a DORMANT guardian claim with the next
 * FIFO pledge_order. It activates automatically when the CID's last live host
 * ends (cancel or expiry) — never while any other live host remains.
 *
 * GET /guardian/queue?cid=<cid>
 * Public during testing (cohosting §9) — the live hosts + the FIFO guardian
 * queue (identities + budgets) for debug visibility.
 */
app.get('/guardian/quote', userApiLimiter, guardianQuoteHandler('guardian'));
app.post('/guardian/pledge', uploadLimiter, guardianPledgeHandler('guardian'));
app.get('/guardian/queue', guardianQueueHandler);
// Legacy aliases (pre-Guardian naming) — same behaviour, legacy pledge memo.
app.get('/backstop/quote', userApiLimiter, guardianQuoteHandler('backstop'));
app.post('/backstop/pledge', uploadLimiter, guardianPledgeHandler('backstop'));
app.get('/backstop/queue', guardianQueueHandler);

// ─── Own copy (guardian spec §2/§3 "Host my own copy") ──────────────────────
// A later user pays NOW for their own independent copy of an already-hosted
// CID — own timer, own pro-rata refund, survives regardless of what anyone
// else does. No byte transfer: the bytes are already in Kubo, so this is a
// pay → verify → DB-rows flow, same as a guardian pledge but live immediately.

/**
 * GET /claims/own-copy/quote?cid=<cid>&hours=<h>&copies=<c>
 * Quote an own-copy claim on an already-hosted CID. Pay to
 * payment.escrow_account with payment.memo, then POST /claims/own-copy.
 */
app.get('/claims/own-copy/quote', userApiLimiter, (req, res) => {
  try {
    const cid = String(req.query.cid || '');
    const hours = (req.query.hours === undefined) ? DEFAULT_HOURS : Number(req.query.hours);
    const copies = (req.query.copies === undefined) ? 1 : Number(req.query.copies);
    if (!cid) return respondError(res, 'bad_request', 'cid required');
    if (quota.isCidBlocked(cid)) return respondError(res, 'legal_takedown', 'this CID is blocked on this server');

    const hosted = quota.alreadyHostedForCid(cid);
    if (!hosted) {
      return respondError(res, 'not_found', 'CID is not currently hosted here — upload it via /reserve + /upload instead');
    }
    // Optional ?hive_account= — same honest $0 preview as /guardian/quote.
    const quoteAccount = String(req.query.hive_account || '').toLowerCase();
    const feeExempt = !!(quoteAccount && feeExemptEntryFor(quoteAccount));
    const quote = pricing.calculateCost({
      sizeBytes: hosted.size_bytes, hoursRequested: hours, copies,
      ...(feeExempt ? { rate: 0 } : {})
    });

    res.json({
      cid,
      mode: 'own_copy',
      hosted_until: isoFromMs(hosted.hosted_until),
      // A second copy is only real redundancy when the gate has a free node
      // (current copies < node_count) — surfaced, never silently capped (§2).
      node_count: pricing.getNodeCount(),
      current_copies: hosted.active_hosts,
      adds_redundancy: hosted.active_hosts < pricing.getNodeCount(),
      payment: {
        currency: PAYMENT_CURRENCY,
        amount: String(quote.total),
        escrow_account: IPFS_GATE_HIVE_ACCOUNT,
        memo: `ipfs-gate:owncopy:${cid}`
      },
      quote: {
        billable_mb: quote.billable_mb,
        billable_hrs: quote.billable_hrs,
        copies: quote.copies,
        copies_requested: Math.max(1, Math.floor(copies) || 1),
        copies_capped: quote.copies < Math.max(1, Math.floor(copies) || 1),
        rate_per_mb_hour: quote.rate,
        total: quote.total,
        currency: PAYMENT_CURRENCY,
        fee_exempt: feeExempt
      }
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /claims/own-copy
 * Body: { owner, cid, hours_requested?, copies?, tx_id }
 * Verifies the on-chain payment (memo ipfs-gate:owncopy:<cid>, sender = owner,
 * amount ≥ quote) and creates a LIVE own_copy claim + its own pin row on the
 * already-hosted bytes. Independent lifecycle from day one.
 */
app.post('/claims/own-copy', uploadLimiter, async (req, res) => {
  try {
    const { owner, cid, tx_id } = req.body || {};
    const hours = (req.body && req.body.hours_requested === undefined) ? DEFAULT_HOURS : Number(req.body.hours_requested);
    const copies = (req.body && req.body.copies === undefined) ? 1 : Number(req.body.copies);
    if (typeof owner !== 'string' || !owner || typeof cid !== 'string' || !cid) {
      return respondError(res, 'bad_request', 'owner, cid required');
    }
    const account = owner.toLowerCase();
    if (quota.isAccountBanned(account)) return respondError(res, 'forbidden', 'owner is banned');
    // Whitelist mode: this route bypasses createReservation, so the gate is
    // inlined here (same pattern as the ban check above).
    if (quota.whitelistModeEnabled() && !quota.isAccountWhitelisted(account)) {
      return respondError(res, 'forbidden', 'this server is invite-only — owner is not whitelisted');
    }
    if (quota.isCidBlocked(cid)) return respondError(res, 'legal_takedown', 'this CID is blocked on this server');

    // Fee exemption recomputed fresh — this route never saw /reserve, so
    // there's no stored flag to trust. Exempt own-copies need no tx_id.
    const feeExempt = !!feeExemptEntryFor(account);
    if (!feeExempt && !tx_id) {
      return respondError(res, 'bad_request', 'tx_id required');
    }

    const hosted = quota.alreadyHostedForCid(cid);
    if (!hosted) {
      return respondError(res, 'not_found', 'CID is not currently hosted here — upload it via /reserve + /upload instead');
    }
    // Unlike a dormant guardian pledge, an own copy adds accountable bytes
    // immediately — so the per-account quota cap applies here too (checked
    // before payment so nobody pays and then gets rejected on quota).
    try {
      quota.assertWhitelistAllows(account, hosted.size_bytes);
    } catch (e) {
      return handleError(res, e);
    }
    const quote = pricing.calculateCost({
      sizeBytes: hosted.size_bytes, hoursRequested: hours, copies,
      ...(feeExempt ? { rate: 0 } : {})
    });

    if (!feeExempt && quota.getPaymentByTxId(tx_id)) return respondError(res, 'conflict', 'tx_id already used');

    const expectedMemo = `ipfs-gate:owncopy:${cid}`;
    let payResult, payment;
    try {
      ({ payResult, payment } = await verifyOrSkipPayment({
        feeExempt, tx_id, sender: account, expectedMemo, expectedAmount: quote.total,
        syntheticTxId: `whitelist-free:owncopy:${cid}:${account}:${quota.now()}`
      }));
    } catch (e) {
      return handleError(res, e, 'unprocessable_entity');
    }

    const claim = quota.createOwnCopyClaim({
      cid, owner: account, paymentId: payment.id,
      paidHours: quote.billable_hrs, copies: quote.copies,
      rateLocked: feeExempt ? 0 : pricing.RATE_PER_MB_HOUR,
      amountPaid: payResult.paid, currency: payResult.currency
    });

    res.json({
      ok: true, claim_id: claim.claim_id, order_id: claim.order_id, cid,
      kind: 'own_copy', state: 'active',
      paid_hours: quote.billable_hrs, copies: quote.copies,
      expires_at: isoFromMs(claim.expiry_ts),
      amount_paid: payResult.paid, currency: payResult.currency
    });
  } catch (e) {
    return handleError(res, e);
  }
});

// ─── Extend / top-up (cohosting §8) ──────────────────────────────────────────
// A live host pays more to push their OWN expiry_ts out, billed at the claim's
// rate_locked (never the live rate). No new claim — just more hours.

/**
 * GET /claims/extend/quote?claim_id=<id>&hours=<h>
 * Quote extra hours at the claim's locked rate. Pay then POST /claims/extend.
 */
app.get('/claims/extend/quote', userApiLimiter, (req, res) => {
  try {
    const claimId = String(req.query.claim_id || '');
    const hours = (req.query.hours === undefined) ? 0 : Number(req.query.hours);
    if (!claimId) return respondError(res, 'bad_request', 'claim_id required');
    const claim = quota.getClaim(claimId);
    if (!claim) return respondError(res, 'not_found', 'claim not found');
    if (claim.state !== 'active') return respondError(res, 'conflict', `claim is ${claim.state}; only active claims can be extended`);

    let extraHrs;
    try { extraHrs = pricing.billableHours(hours); } catch (e) { return handleError(res, e); }
    const cost = pricing.roundCoins(claim.size_mb * extraHrs * claim.rate_locked * claim.copies_requested);

    res.json({
      claim_id: claimId,
      payment: {
        currency: claim.currency,
        amount: String(cost),
        escrow_account: IPFS_GATE_HIVE_ACCOUNT,
        memo: `ipfs-gate:extend:${claimId}`
      },
      quote: {
        billable_mb: claim.size_mb, extra_hrs: extraHrs, copies: claim.copies_requested,
        rate_per_mb_hour: claim.rate_locked, total: cost, currency: claim.currency
      }
    });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /claims/extend
 * Body: { claim_id, extra_hours, tx_id }
 * Verifies the escrow payment (memo ipfs-gate:extend:<claim_id>, sender = the
 * claim owner, amount ≥ quote at rate_locked) and pushes paid_hours + expiry_ts.
 */
app.post('/claims/extend', uploadLimiter, async (req, res) => {
  try {
    const { claim_id, tx_id } = req.body || {};
    if (typeof claim_id !== 'string' || !claim_id) {
      return respondError(res, 'bad_request', 'claim_id, extra_hours required');
    }
    let extraHrs;
    try { extraHrs = pricing.billableHours(req.body && req.body.extra_hours); } catch (e) { return handleError(res, e); }

    const claim = quota.getClaim(claim_id);
    if (!claim) return respondError(res, 'not_found', 'claim not found');
    if (claim.state !== 'active') return respondError(res, 'conflict', `claim is ${claim.state}; only active claims can be extended`);
    if (quota.isCidBlocked(claim.cid)) return respondError(res, 'legal_takedown', 'this CID is blocked on this server');

    const cost = pricing.roundCoins(claim.size_mb * extraHrs * claim.rate_locked * claim.copies_requested);
    // Fee-exempt extend: a rate_locked=0 claim (only creatable via whitelist
    // fee exemption) quotes 0 — demanding an on-chain tx of 0 would strand the
    // exempt owner. Skip payment ONLY when the cost is 0 AND the claim's owner
    // is STILL fee-exempt right now (payment-is-auth doesn't apply at $0, so
    // the live whitelist entry is the gate instead).
    const feeExempt = cost === 0 && !!feeExemptEntryFor(claim.owner);
    if (!feeExempt && !tx_id) {
      return respondError(res, 'bad_request', 'tx_id required');
    }
    if (!feeExempt && quota.getPaymentByTxId(tx_id)) return respondError(res, 'conflict', 'tx_id already used');

    const expectedMemo = `ipfs-gate:extend:${claim_id}`;
    if (feeExempt) {
      const syntheticTxId = `whitelist-free:extend:${claim_id}:${quota.now()}`;
      quota.recordPayment({
        tx_id: syntheticTxId, reservation_id: null, uploader: claim.owner,
        currency: claim.currency, amount: 0, memo: expectedMemo,
        block_num: null, status: 'confirmed'
      });
      const updated = quota.extendClaim(claim_id, claim.owner, extraHrs);
      return res.json({
        ok: true, claim_id, added_hours: extraHrs,
        paid_hours: updated.paid_hours, expires_at: isoFromMs(updated.expiry_ts),
        amount_paid: 0, currency: claim.currency, fee_exempt: true
      });
    }

    let payResult;
    try {
      payResult = await hive.verifyPayment({ tx_id, sender: claim.owner, expectedMemo, expectedAmount: cost });
    } catch (e) {
      return handleError(res, e, 'unprocessable_entity');
    }

    let sc;
    try {
      sc = await hive.verifyHiveEngineSidechain(tx_id);
    } catch (e) {
      return respondError(res, 'unprocessable_entity', `Hive-Engine sidechain unreachable: ${e.message}`);
    }
    if (sc.confirmed === false) {
      const detail = sc.reason === 'rejected'
        ? ((sc.errors || []).join('; ') || 'sidechain rejected the transfer')
        : 'sidechain did not confirm within the retry budget — try again in ~30s';
      return respondError(res, 'unprocessable_entity', `Hive-Engine did not confirm: ${detail}`);
    }

    try {
      quota.recordPayment({
        tx_id, reservation_id: null, uploader: claim.owner,
        currency: payResult.currency, amount: payResult.paid,
        memo: expectedMemo, block_num: payResult.block_num, status: 'confirmed'
      });
    } catch (e) {
      return handleError(res, e);
    }

    const updated = quota.extendClaim(claim_id, claim.owner, extraHrs);
    res.json({
      ok: true, claim_id, added_hours: extraHrs,
      paid_hours: updated.paid_hours, expires_at: isoFromMs(updated.expiry_ts),
      amount_paid: payResult.paid, currency: payResult.currency
    });
  } catch (e) {
    return handleError(res, e);
  }
});

// ─── Admin endpoints ────────────────────────────────────────────────────────

// The 4 moderation routes below accept BOTH admin tiers (Bearer ADMIN_KEY or a
// Hive-signed roster admin — see verifyAdminAuth). Every other /admin/* route
// stays requireAdmin/Bearer-only on purpose: narrower blast radius for a tier
// that might be a trusted family member, not the box operator (design §5).

app.post('/admin/ban', async (req, res) => {
  try {
    const { hive_account, reason, refund_policy } = req.body || {};
    const { adminId } = await verifyAdminAuth(req, { action: 'ban', target: String(hive_account || '').toLowerCase() });
    const result = moderation.banAccount({ hive_account, reason, refund_policy, admin_id: adminId });

    // Settle refunds for the banned user's voided claims — per refund_policy.
    // The banned user is NOT innocent (cohosting §7), so no full-refund override.
    const refunds = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    for (const claim of result.voided_claims) {
      const r = await settleForcedRefund(claim, { policy: result.refund_policy, innocent: false });
      refunds[r.status] = (refunds[r.status] || 0) + 1;
    }

    // Unpin from Kubo (best-effort) for CIDs with no funder left (no other user's
    // guardian took the baton).
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

    res.json({
      banned: String(hive_account).toLowerCase(),
      pins_affected: result.pins_affected,
      claims_voided: result.voided_claims.length,
      guardians_activated: result.activated.length,
      cids_unpinned: unpinned,
      refunds,
      moderation_log_id: result.moderation_log_id
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/unban', async (req, res) => {
  try {
    const { hive_account } = req.body || {};
    const { adminId } = await verifyAdminAuth(req, { action: 'unban', target: String(hive_account || '').toLowerCase() });
    const result = moderation.unbanAccount({ hive_account, admin_id: adminId });
    res.json({ unbanned: hive_account.toLowerCase(), moderation_log_id: result.moderation_log_id });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/takedown', async (req, res) => {
  try {
    const { cid, reason, refund_policy } = req.body || {};
    const { adminId } = await verifyAdminAuth(req, { action: 'takedown', target: String(cid || '') });
    const result = moderation.takedownCid({ cid, reason, refund_policy, admin_id: adminId });

    // Settle refunds (cohosting §7): dormant guardians are INNOCENT third
    // parties → full escrow, no fee; the active host/offender follows refund_policy.
    const refunds = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    let guardians_refunded = 0;
    for (const claim of result.voided_claims) {
      const innocent = claim.state === 'dormant';
      if (innocent) guardians_refunded++;
      const r = await settleForcedRefund(claim, { policy: result.refund_policy, innocent });
      refunds[r.status] = (refunds[r.status] || 0) + 1;
    }

    // Content kill — always unpin (the whole queue was voided; no guardian survives).
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
      claims_voided: result.voided_claims.length,
      guardians_refunded,
      refund_policy: result.refund_policy,
      refunds,
      unpinned_from_kubo: unpinned,
      moderation_log_id: result.moderation_log_id
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/untakedown', async (req, res) => {
  try {
    const { cid } = req.body || {};
    const { adminId } = await verifyAdminAuth(req, { action: 'untakedown', target: String(cid || '') });
    const result = moderation.untakedownCid({ cid, admin_id: adminId });
    res.json({ cid, moderation_log_id: result.moderation_log_id });
  } catch (e) {
    return handleError(res, e);
  }
});

// ─── Whitelist CRUD + admin pin delete (both admin tiers) ────────────────────

app.post('/admin/whitelist/add', async (req, res) => {
  try {
    const { target_account, quota_bytes, fee_exempt, note } = req.body || {};
    const { adminId } = await verifyAdminAuth(req, { action: 'whitelist-add', target: String(target_account || '').toLowerCase() });
    const result = moderation.addToWhitelist({
      hive_account: target_account, added_by: adminId,
      quota_bytes: quota_bytes ?? null, fee_exempt: !!fee_exempt, note: note || null
    });
    res.json({
      whitelisted: String(target_account).toLowerCase(),
      quota_bytes: quota_bytes ?? null, fee_exempt: !!fee_exempt,
      moderation_log_id: result.moderation_log_id
    });
  } catch (e) {
    return handleError(res, e);
  }
});

app.post('/admin/whitelist/remove', async (req, res) => {
  try {
    const { target_account } = req.body || {};
    const { adminId } = await verifyAdminAuth(req, { action: 'whitelist-remove', target: String(target_account || '').toLowerCase() });
    const result = moderation.removeFromWhitelist({ hive_account: target_account, removed_by: adminId });
    res.json({ removed: String(target_account).toLowerCase(), moderation_log_id: result.moderation_log_id });
  } catch (e) {
    return handleError(res, e);
  }
});

app.get('/admin/whitelist', async (req, res) => {
  try {
    await verifyAdminAuth(req, { action: 'whitelist-list', target: 'all' });
    const entries = moderation.listWhitelist().map(w => ({
      hive_account: w.hive_account,
      added_at: isoFromMs(w.added_at),
      added_by: w.added_by,
      quota_bytes: w.quota_bytes,
      fee_exempt: !!w.fee_exempt,
      note: w.note
    }));
    res.json({ whitelist_mode: quota.whitelistModeEnabled(), whitelist: entries });
  } catch (e) {
    return handleError(res, e);
  }
});

/**
 * POST /admin/pins/delete — the one genuinely-new moderation primitive
 * (design §6): remove ONE account's claim(s) on ONE CID without banning the
 * account (identity kill) or taking the CID down for everyone (content kill).
 * Body: { target_account, cid, reason?, refund_policy? } + admin auth fields.
 * Reuses cancelClaim({asAdmin}) + settleForcedRefund — the target is treated
 * as the offender per refund_policy (default prorata: unused hours back).
 * A queued guardian still takes the baton (reconcile runs inside cancelClaim).
 */
app.post('/admin/pins/delete', async (req, res) => {
  try {
    const { target_account, cid, reason, refund_policy } = req.body || {};
    const account = String(target_account || '').toLowerCase();
    if (!account || typeof cid !== 'string' || !cid) {
      return respondError(res, 'bad_request', 'target_account, cid required');
    }
    const { adminId } = await verifyAdminAuth(req, { action: 'pin-delete', target: `${cid}:${account}` });
    const policy = ['none', 'prorata'].includes(refund_policy) ? refund_policy : 'prorata';

    const targetClaims = quota.getActiveClaimsForCid(cid).filter(c => c.owner === account);
    if (targetClaims.length === 0) {
      return respondError(res, 'not_found', 'no active claim for this account + cid');
    }

    const refunds = { sent: 0, pending: 0, failed: 0, skipped: 0 };
    let fullyUnpinned = false;
    const activated = [];
    for (const c of targetClaims) {
      const r = quota.cancelClaim(c.claim_id, null, { asAdmin: true });
      if (r.fully_unpinned) fullyUnpinned = true;
      if (r.activated) activated.push(r.activated);
      const settled = await settleForcedRefund(r.claim, { policy, innocent: false });
      refunds[settled.status] = (refunds[settled.status] || 0) + 1;
    }

    if (fullyUnpinned) {
      try {
        await kubo.unpin(cid);
        await kubo.gc();
      } catch (e) {
        console.warn(`[admin/pins/delete] kubo unpin/gc failed for ${cid}: ${e.message}`);
      }
    }

    const mlId = moderation.audit({
      action: 'pin_delete', target_type: 'cid', target: cid,
      reason: reason || null,
      metadata: { target_account: account, claims_cancelled: targetClaims.length, refund_policy: policy },
      admin_id: adminId
    });

    res.json({
      cid, target_account: account,
      claims_cancelled: targetClaims.length,
      guardians_activated: activated.length,
      fully_unpinned: fullyUnpinned,
      refund_policy: policy, refunds,
      moderation_log_id: mlId
    });
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
    console.log(`ipfs-gate v1 (claim model) listening on ${BIND_HOST}:${PORT}`);
    console.log(`  operator account: @${IPFS_GATE_HIVE_ACCOUNT}`);
    console.log(`  pricing: ${pricing.RATE_PER_MB_HOUR} ${PAYMENT_CURRENCY} / MB-hour, min ${pricing.MIN_HOURS}h, ${pricing.NODE_COUNT} node(s), ≤${MAX_FILE_SIZE_MB}MB`);
    console.log(`  refunds: ${process.env.IPFS_GATE_ACTIVE_KEY ? 'auto (escrow key set)' : 'MANUAL — IPFS_GATE_ACTIVE_KEY unset, refunds recorded pending'}`);
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