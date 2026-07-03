-- ipfs-gate v1 — Guardian feature (guardian-feature handover doc).
-- The Stage-1b "backstop" becomes the GUARDIAN (same lifecycle: a dormant,
-- prepaid claim that takes the FIFO baton when the last live host ends). The
-- spec locks the internal kind values to original | own_copy | guardian, and
-- adds two explicit guardian fields to the claim record:
--   pledge_order  — FIFO activation position, assigned at pledge time
--   pledge_budget — the escrow pledged at pledge time (max spend once live)
--
-- SQLite can't ALTER a CHECK constraint, so this is the documented 12-step
-- table rebuild. refunds.claim_id references claims — foreign_keys goes OFF
-- for the swap (the runner execs this file outside any transaction, so the
-- PRAGMA takes effect).

PRAGMA foreign_keys=OFF;

BEGIN;

CREATE TABLE claims_new (
  claim_id          TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL,
  cid               TEXT NOT NULL,
  owner             TEXT NOT NULL,
  host_gate         TEXT NOT NULL DEFAULT 'self',
  pin_id            INTEGER,
  size_bytes        INTEGER NOT NULL,
  size_mb           INTEGER NOT NULL,
  rate_locked       REAL NOT NULL,
  paid_hours        INTEGER NOT NULL,
  copies_requested  INTEGER NOT NULL DEFAULT 1,
  kind              TEXT NOT NULL DEFAULT 'original'
                      CHECK (kind IN ('original','own_copy','guardian')),
  state             TEXT NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active','dormant','cancelled','expired')),
  amount_paid       REAL NOT NULL,
  currency          TEXT NOT NULL,
  payment_id        INTEGER,
  start_ts          INTEGER NOT NULL,
  expiry_ts         INTEGER NOT NULL,
  created_ts        INTEGER NOT NULL,
  pledge_order      INTEGER,            -- guardians only: FIFO activation position (per cid)
  pledge_budget     REAL,               -- guardians only: escrow pledged (max spend once activated)
  FOREIGN KEY (order_id)   REFERENCES orders(order_id),
  FOREIGN KEY (pin_id)     REFERENCES pins(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

-- ORDER BY rowid preserves true insertion order, so the FIFO tiebreaker
-- (created_ts, rowid) keeps working across the rebuild.
INSERT INTO claims_new
  (claim_id, order_id, cid, owner, host_gate, pin_id, size_bytes, size_mb,
   rate_locked, paid_hours, copies_requested, kind, state,
   amount_paid, currency, payment_id, start_ts, expiry_ts, created_ts,
   pledge_order, pledge_budget)
SELECT
  claim_id, order_id, cid, owner, host_gate, pin_id, size_bytes, size_mb,
  rate_locked, paid_hours, copies_requested,
  CASE kind WHEN 'backstop' THEN 'guardian' ELSE kind END,
  state,
  amount_paid, currency, payment_id, start_ts, expiry_ts, created_ts,
  NULL,
  CASE kind WHEN 'backstop' THEN amount_paid ELSE NULL END
FROM claims
ORDER BY rowid ASC;

DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;

-- Backfill pledge_order per cid in pledge (FIFO) order — 1-based, all guardian
-- rows regardless of state, matching the queue's created_ts/rowid ordering.
UPDATE claims SET pledge_order = (
  SELECT COUNT(*) FROM claims AS c2
  WHERE c2.cid = claims.cid AND c2.kind = 'guardian'
    AND (c2.created_ts < claims.created_ts
         OR (c2.created_ts = claims.created_ts AND c2.rowid <= claims.rowid))
) WHERE kind = 'guardian';

CREATE INDEX IF NOT EXISTS idx_claims_cid_state    ON claims(cid, state);
CREATE INDEX IF NOT EXISTS idx_claims_owner_state  ON claims(owner, state);
CREATE INDEX IF NOT EXISTS idx_claims_expiry_state ON claims(expiry_ts, state);
CREATE INDEX IF NOT EXISTS idx_claims_pin          ON claims(pin_id);

COMMIT;

PRAGMA foreign_keys=ON;

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (6, CAST(strftime('%s','now') AS INTEGER) * 1000);
