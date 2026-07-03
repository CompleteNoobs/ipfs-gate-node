// ipfs-gate v1 — migration 006 (Guardian) upgrade test (node:test).
// Proves that a REAL pre-Guardian database (schema_version=5, kind='backstop'
// rows) upgrades cleanly: kinds renamed, pledge_order backfilled in FIFO order,
// pledge_budget = escrowed amount, new CHECK accepts own_copy/guardian and
// rejects the retired 'backstop'. Applies 001–005 by hand, seeds, then runs 006
// through the real runner (quota.runMigrations) — the exact prod upgrade path.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const TMP_DB = path.join(os.tmpdir(), `ipfs-gate-mig-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = TMP_DB;

const MIG_DIR = path.join(__dirname, '..', 'migrations');

// ── Build a schema_version=5 DB by hand (the runner would apply 006 too) ─────
{
  const db = new Database(TMP_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    const ver = parseInt(f.match(/^(\d+)/)[1], 10);
    if (ver > 5) continue;
    db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  }
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 5);

  // Seed: 1 payment + 1 active original + 2 dormant BACKSTOPS (old kind) on one
  // CID, pledged in a known order (created_ts 1000 then 2000).
  const pay = db.prepare(`INSERT INTO payments (tx_id, reservation_id, uploader, currency, amount, memo, block_num, verified_at, status)
    VALUES (?, NULL, ?, 'TEST', ?, ?, 1, 1000, 'confirmed')`);
  const p1 = pay.run('tx_orig', 'alice', 25, 'm:orig').lastInsertRowid;
  const p2 = pay.run('tx_bs1', 'bob', 25, 'ipfs-gate:backstop:QmMIG').lastInsertRowid;
  const p3 = pay.run('tx_bs2', 'carol', 10, 'ipfs-gate:backstop:QmMIG').lastInsertRowid;

  db.prepare(`INSERT INTO orders (order_id, cid, owner, created_ts) VALUES ('ord_o', 'QmMIG', 'alice', 1000),
    ('ord_b1', 'QmMIG', 'bob', 1000), ('ord_b2', 'QmMIG', 'carol', 2000)`).run();
  const ins = db.prepare(`INSERT INTO claims
    (claim_id, order_id, cid, owner, pin_id, size_bytes, size_mb, rate_locked, paid_hours,
     copies_requested, kind, state, amount_paid, currency, payment_id, start_ts, expiry_ts, created_ts)
    VALUES (?, ?, 'QmMIG', ?, NULL, 5000000, 5, 1, 5, 1, ?, ?, ?, 'TEST', ?, 1000, ?, ?)`);
  ins.run('clm_orig', 'ord_o', 'alice', 'original', 'active', 25, p1, 99999999999, 1000);
  ins.run('clm_bs1', 'ord_b1', 'bob', 'backstop', 'dormant', 25, p2, 1000, 1000);
  ins.run('clm_bs2', 'ord_b2', 'carol', 'backstop', 'dormant', 10, p3, 2000, 2000);
  db.close();
}

// ── Upgrade through the real runner (applies only 006) ──────────────────────
const quota = require('../quota');
quota.open();
quota.runMigrations();
process.on('exit', () => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

test('006 renames backstop→guardian and preserves every other column', () => {
  const db = quota.open();
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM claims WHERE kind = 'backstop'").get().c, 0);

  const orig = quota.getClaim('clm_orig');
  assert.equal(orig.kind, 'original');            // untouched
  assert.equal(orig.state, 'active');
  assert.equal(orig.pledge_order, null);          // non-guardian gets no slot
  assert.equal(orig.pledge_budget, null);

  const g1 = quota.getClaim('clm_bs1');
  assert.equal(g1.kind, 'guardian');
  assert.equal(g1.state, 'dormant');
  assert.equal(g1.amount_paid, 25);               // data survived the rebuild
  assert.equal(g1.payment_id !== null, true);
});

test('006 backfills pledge_order in FIFO order + pledge_budget = escrow', () => {
  const g1 = quota.getClaim('clm_bs1');
  const g2 = quota.getClaim('clm_bs2');
  assert.equal(g1.pledge_order, 1);               // pledged first (created_ts 1000)
  assert.equal(g2.pledge_order, 2);               // pledged second (created_ts 2000)
  assert.equal(g1.pledge_budget, 25);
  assert.equal(g2.pledge_budget, 10);

  // and the queue reads back in that order
  const q = quota.getDormantGuardiansForCid('QmMIG');
  assert.deepEqual(q.map(c => c.claim_id), ['clm_bs1', 'clm_bs2']);
});

test('new CHECK accepts own_copy + guardian, rejects the retired backstop kind', () => {
  const db = quota.open();
  const ins = db.prepare(`INSERT INTO claims
    (claim_id, order_id, cid, owner, size_bytes, size_mb, rate_locked, paid_hours,
     kind, state, amount_paid, currency, start_ts, expiry_ts, created_ts)
    VALUES (?, 'ord_o', 'QmMIG', 'x', 1, 1, 1, 1, ?, 'active', 1, 'TEST', 1, 1, 1)`);
  ins.run('clm_chk_oc', 'own_copy');              // accepted
  ins.run('clm_chk_gd', 'guardian');              // accepted
  assert.throws(() => ins.run('clm_chk_bs', 'backstop'), /CHECK/);
});

test('post-migration FIFO promotion still works end-to-end', () => {
  // Cancel the original — bob (pledge_order 1) must take the baton, not carol.
  // clm_orig has no pin row (seeded pinless), so give it one first via the
  // real path: create a pin + link it, then cancel.
  const db = quota.open();
  const payId = db.prepare("SELECT id FROM payments WHERE tx_id = 'tx_orig'").get().id;
  const pin = db.prepare(`INSERT INTO pins (cid, uploader, size_bytes, payment_id, created_at, expires_at, status)
    VALUES ('QmMIG', 'alice', 5000000, ?, 1000, 99999999999, 'active')`).run(payId);
  db.prepare("UPDATE claims SET pin_id = ? WHERE claim_id = 'clm_orig'").run(pin.lastInsertRowid);

  const r = quota.cancelClaim('clm_orig', 'alice');
  assert.equal(r.fully_unpinned, false);
  assert.equal(r.activated, 'clm_bs1');           // FIFO head, from the backfilled order
  assert.equal(quota.getClaim('clm_bs1').state, 'active');
  assert.equal(quota.getClaim('clm_bs2').state, 'dormant');
});
