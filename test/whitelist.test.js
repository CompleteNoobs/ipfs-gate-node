// ipfs-gate v1 — Whitelist / gated-server mode, Stage A tests (node:test).
// Covers: migration 007 applies, WHITELIST_MODE=false is a byte-for-byte
// no-op (the critical regression check), membership gate at createReservation,
// per-account quota_bytes cap (additive to the global disk check), soft-delete
// semantics (removed_at blocks new reservations only), and getAccountUsage
// scoping (own pins/reservations only).
//
// The gate is flipped via process.env at CALL time (quota.whitelistModeEnabled
// reads env per call, not at module load) so both modes run in one process.
// Whitelist rows are inserted with raw SQL — the admin CRUD is Stage C.
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
delete process.env.WHITELIST_MODE; // start with the default: OFF

const quota = require('../quota');

const db = quota.open();
quota.runMigrations();

process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function addWhitelistRow(account, { quota_bytes = null, fee_exempt = 0, removed_at = null } = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO whitelisted_accounts
      (hive_account, added_at, added_by, quota_bytes, fee_exempt, note, removed_at, removed_by)
    VALUES (?, ?, 'operator', ?, ?, NULL, ?, ?)
  `).run(account, quota.now(), quota_bytes, fee_exempt, removed_at, removed_at ? 'operator' : null);
}

function withWhitelistMode(fn) {
  process.env.WHITELIST_MODE = 'true';
  try { return fn(); }
  finally { delete process.env.WHITELIST_MODE; }
}

// ─── migration ───────────────────────────────────────────────────────────────

test('migration 007 applies: whitelisted_accounts exists, schema_version = 7', () => {
  const t = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'whitelisted_accounts'"
  ).get();
  assert.ok(t, 'whitelisted_accounts table exists');
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  assert.equal(v, 7);
});

// ─── the critical regression check: OFF = zero behavior change ───────────────

test('WHITELIST_MODE off (default): a non-whitelisted account reserves normally', () => {
  assert.equal(quota.whitelistModeEnabled(), false);
  const r = quota.createReservation('randomguest', 1_000_000, 'public',
    { hoursRequested: 1, copies: 1, quotedAmount: 1 });
  assert.ok(r.id, 'reservation created with mode off');
  assert.equal(quota.isAccountWhitelisted('randomguest'), false);
});

test('WHITELIST_MODE off: assertWhitelistAllows is a no-op even with a tiny quota row', () => {
  addWhitelistRow('cappedbutoff', { quota_bytes: 1 });
  // 1 GB against a 1-byte cap — must NOT throw while the mode is off.
  assert.doesNotThrow(() => quota.assertWhitelistAllows('cappedbutoff', 1_000_000_000));
});

// ─── membership gate ─────────────────────────────────────────────────────────

test('WHITELIST_MODE on: non-whitelisted account is rejected with forbidden', () => {
  withWhitelistMode(() => {
    assert.equal(quota.whitelistModeEnabled(), true);
    assert.throws(
      () => quota.createReservation('stranger', 1_000_000, 'public',
        { hoursRequested: 1, copies: 1, quotedAmount: 1 }),
      (e) => e.code === 'forbidden' && /invite-only/.test(e.message)
    );
  });
});

test('WHITELIST_MODE on: whitelisted account reserves normally', () => {
  addWhitelistRow('familymember');
  withWhitelistMode(() => {
    const r = quota.createReservation('familymember', 1_000_000, 'public',
      { hoursRequested: 1, copies: 1, quotedAmount: 1 });
    assert.ok(r.id);
    assert.equal(quota.isAccountWhitelisted('familymember'), true);
  });
});

test('soft-delete: a removed_at entry no longer counts as whitelisted', () => {
  addWhitelistRow('exguest', { removed_at: quota.now() });
  withWhitelistMode(() => {
    assert.equal(quota.isAccountWhitelisted('exguest'), false);
    assert.equal(quota.getWhitelistEntry('exguest'), null);
    assert.throws(
      () => quota.createReservation('exguest', 1_000_000, 'public',
        { hoursRequested: 1, copies: 1, quotedAmount: 1 }),
      (e) => e.code === 'forbidden'
    );
  });
});

// ─── per-account quota_bytes cap ─────────────────────────────────────────────

test('quota_bytes cap: second reservation over the cap → insufficient_storage', () => {
  addWhitelistRow('smallguest', { quota_bytes: 8_000_000 }); // 8 MB cap
  withWhitelistMode(() => {
    const r1 = quota.createReservation('smallguest', 5_000_000, 'public',
      { hoursRequested: 1, copies: 1, quotedAmount: 5 });
    assert.ok(r1.id, 'first 5 MB fits under the 8 MB cap');
    // 5 MB pending + 5 MB new = 10 MB > 8 MB cap.
    assert.throws(
      () => quota.createReservation('smallguest', 5_000_000, 'public',
        { hoursRequested: 1, copies: 1, quotedAmount: 5 }),
      (e) => e.code === 'insufficient_storage' && /per-account quota/.test(e.message)
    );
    // 2 MB still fits exactly (5 + 2 ≤ 8; hard cap is inclusive).
    const r3 = quota.createReservation('smallguest', 3_000_000, 'public',
      { hoursRequested: 1, copies: 1, quotedAmount: 3 });
    assert.ok(r3.id, 'exact fit up to the cap is allowed');
  });
});

test('quota_bytes NULL = no per-account cap (global disk check still owns the ceiling)', () => {
  addWhitelistRow('unlimitedguest', { quota_bytes: null });
  withWhitelistMode(() => {
    const r = quota.createReservation('unlimitedguest', 9_000_000, 'public',
      { hoursRequested: 1, copies: 1, quotedAmount: 9 });
    assert.ok(r.id, 'no per-account cap applies when quota_bytes is NULL');
  });
});

// ─── getAccountUsage scoping ─────────────────────────────────────────────────

test('getAccountUsage counts only the account\'s own pending reservations + active pins', () => {
  addWhitelistRow('userx');
  addWhitelistRow('usery');
  withWhitelistMode(() => {
    quota.createReservation('userx', 2_000_000, 'public', { hoursRequested: 1, copies: 1, quotedAmount: 2 });
    const ux = quota.getAccountUsage('userx');
    const uy = quota.getAccountUsage('usery');
    assert.equal(ux.used_bytes, 2_000_000, "userx's own pending reservation counts");
    assert.equal(uy.used_bytes, 0, "usery is unaffected by userx's reservation");
    assert.equal(ux.active_bytes, 0);
    assert.equal(ux.reserved_bytes, 2_000_000);
  });
});
