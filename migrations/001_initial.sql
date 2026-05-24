-- ipfs-gate v0.1 initial schema
-- Applied once on first boot if schema_version table is empty.
-- All timestamps stored as INTEGER unix-ms (UTC).

-- ─── Pragmas (set every connection in code; idempotent here for completeness) ─
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

-- ─── reservations: pre-payment quota holds ──────────────────────────────────
CREATE TABLE IF NOT EXISTS reservations (
  id              TEXT PRIMARY KEY,
  uploader        TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','paid','uploaded','expired','cancelled')),
  payment_tx_id   TEXT,
  pin_id          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reservations_uploader_status
  ON reservations(uploader, status);
CREATE INDEX IF NOT EXISTS idx_reservations_expires_status
  ON reservations(expires_at, status);

-- ─── payments: confirmed on-chain transfers ─────────────────────────────────
-- tx_id UNIQUE = replay protection at schema level.
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id           TEXT NOT NULL UNIQUE,
  reservation_id  TEXT,
  uploader        TEXT NOT NULL,
  currency        TEXT NOT NULL,
  amount          REAL NOT NULL,
  memo            TEXT NOT NULL,
  block_num       INTEGER,
  verified_at     INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('confirmed','paid_unconfirmed','orphan','refunded')),
  refund_tx_id    TEXT,
  refund_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payments_reservation_id
  ON payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_payments_uploader_status
  ON payments(uploader, status);
CREATE INDEX IF NOT EXISTS idx_payments_status
  ON payments(status);

-- ─── pins: multi-pin-record table ───────────────────────────────────────────
-- cid is NOT UNIQUE — multiple pin records per CID allowed (dedup model).
-- Kubo holds the bytes once; ipfs-gate accounts per-record.
CREATE TABLE IF NOT EXISTS pins (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  cid                TEXT NOT NULL,
  uploader           TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  payment_id         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','expired','banned','takedown','refunded')),
  status_changed_at  INTEGER,
  status_reason      TEXT,
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE INDEX IF NOT EXISTS idx_pins_cid_status
  ON pins(cid, status);
CREATE INDEX IF NOT EXISTS idx_pins_uploader_status
  ON pins(uploader, status);
CREATE INDEX IF NOT EXISTS idx_pins_expires_status
  ON pins(expires_at, status);

-- ─── banned_accounts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS banned_accounts (
  hive_account    TEXT PRIMARY KEY,
  banned_at       INTEGER NOT NULL,
  banned_by       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  refund_policy   TEXT NOT NULL CHECK (refund_policy IN ('none','prorata')),
  unbanned_at     INTEGER,
  unbanned_by     TEXT
);

-- ─── blocked_cids ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocked_cids (
  cid             TEXT PRIMARY KEY,
  blocked_at      INTEGER NOT NULL,
  blocked_by      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  unblocked_at    INTEGER,
  unblocked_by    TEXT
);

-- ─── moderation_log: append-only audit trail ────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target          TEXT NOT NULL,
  reason          TEXT,
  admin_id        TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  metadata        TEXT
);

CREATE INDEX IF NOT EXISTS idx_moderation_log_timestamp
  ON moderation_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_log_target
  ON moderation_log(target_type, target);

-- ─── schema_version ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);