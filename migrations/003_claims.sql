-- ipfs-gate v1 (Private Encrypted Hosting) — claim/order/refund model, Stage 1a.
-- Applied exactly once by the version-aware runner in quota.js (gated on
-- schema_version). Additive: existing pins/payments/reservations rows are
-- untouched; the claim layer is built on top.
--
-- WHY a separate order/claim split when v1 is always 1 order = 1 claim:
-- it is the v2 federation seam (one order fans out into N claims across N gates
-- later). Shipping the shape now with degenerate v1 values avoids a rewrite.
-- See PRICING-V1-DESIGN-NOTES.md §0–§6 and ipfs-gate-cohosting-backstop.md §2.
--
-- All timestamps INTEGER unix-ms (UTC), matching 001_initial.sql.

-- ─── orders: a user's INTENT to keep a CID alive ────────────────────────────
-- v1: 1 order ⇒ 1 claim (host_gate='self'). v2: 1 order ⇒ N claims across gates.
CREATE TABLE IF NOT EXISTS orders (
  order_id          TEXT PRIMARY KEY,
  cid               TEXT NOT NULL,
  owner             TEXT NOT NULL,
  -- v1 only: {"mode":"count","target":1}. v2 adds "pinned" + a gate list.
  placement_policy  TEXT NOT NULL DEFAULT '{"mode":"count","target":1}',
  -- Stage 3 consumes this; column shipped now. v1: {"type":"owner_only"}.
  release_policy    TEXT NOT NULL DEFAULT '{"type":"owner_only"}',
  created_ts        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','closed'))
);

CREATE INDEX IF NOT EXISTS idx_orders_cid    ON orders(cid);
CREATE INDEX IF NOT EXISTS idx_orders_owner  ON orders(owner);

-- ─── claims: one (cid, host) hosting record — timer + locked rate + money ────
-- The claim's expiry_ts is the lifecycle AUTHORITY (the pins row mirrors it for
-- display + disk accounting). kind/state carry their degenerate v1 values now;
-- 'backstop'/'dormant' are the Stage-1b seam (cohosting doc §2).
CREATE TABLE IF NOT EXISTS claims (
  claim_id          TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL,
  cid               TEXT NOT NULL,
  owner             TEXT NOT NULL,
  host_gate         TEXT NOT NULL DEFAULT 'self',
  pin_id            INTEGER,            -- the physical pins row this claim funds (1:1 in v1)
  size_bytes        INTEGER NOT NULL,
  size_mb           INTEGER NOT NULL,   -- ceil decimal-MB used for billing (bytes / 1e6)
  rate_locked       REAL NOT NULL,      -- coins per MB-hour, captured at purchase; never retro-billed
  paid_hours        INTEGER NOT NULL,   -- hours bought; drives expiry + refund math
  copies_requested  INTEGER NOT NULL DEFAULT 1,
  kind              TEXT NOT NULL DEFAULT 'original'
                      CHECK (kind IN ('original','own_copy','backstop')),
  state             TEXT NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active','dormant','cancelled','expired')),
  amount_paid       REAL NOT NULL,      -- escrowed at purchase (the quote that was paid)
  currency          TEXT NOT NULL,
  payment_id        INTEGER,            -- FK → payments.id (NULL for Stage-1b dormant pledges until activation)
  start_ts          INTEGER NOT NULL,
  expiry_ts         INTEGER NOT NULL,
  created_ts        INTEGER NOT NULL,
  FOREIGN KEY (order_id)   REFERENCES orders(order_id),
  FOREIGN KEY (pin_id)     REFERENCES pins(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE INDEX IF NOT EXISTS idx_claims_cid_state    ON claims(cid, state);
CREATE INDEX IF NOT EXISTS idx_claims_owner_state  ON claims(owner, state);
CREATE INDEX IF NOT EXISTS idx_claims_expiry_state ON claims(expiry_ts, state);
CREATE INDEX IF NOT EXISTS idx_claims_pin          ON claims(pin_id);

-- ─── refunds: custodial ledger ──────────────────────────────────────────────
-- Escrowed-but-owed-back money is a real float (cohosting §3). Every refund is
-- a durable row so a failed/pending broadcast is visible + retryable, never lost.
CREATE TABLE IF NOT EXISTS refunds (
  refund_id    TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  to_account   TEXT NOT NULL,
  amount       REAL NOT NULL,
  currency     TEXT NOT NULL,
  memo         TEXT NOT NULL,
  -- pending: recorded, broadcast not yet confirmed (or no escrow key configured)
  -- sent:    on-chain transfer broadcast OK
  -- failed:  broadcast attempted + errored (operator follow-up)
  -- skipped: refund computed to < MIN_REFUND (dust) — nothing owed
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','failed','skipped')),
  reason       TEXT,                -- cancel | expiry-noop | admin | error detail
  tx_id        TEXT,
  created_ts   INTEGER NOT NULL,
  settled_ts   INTEGER,
  FOREIGN KEY (claim_id) REFERENCES claims(claim_id)
);

CREATE INDEX IF NOT EXISTS idx_refunds_claim  ON refunds(claim_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);

-- ─── reservations: carry the quote so /upload can validate paid ≥ quote ──────
-- Defaults keep pre-cutover rows valid; new reservations always set these.
ALTER TABLE reservations ADD COLUMN hours_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN copies          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservations ADD COLUMN quoted_amount   REAL    NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (3, CAST(strftime('%s','now') AS INTEGER) * 1000);
