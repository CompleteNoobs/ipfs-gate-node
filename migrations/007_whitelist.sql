-- ipfs-gate v1 — Whitelist / gated-server mode (WHITELIST-MODE-DESIGN-NOTES.md).
-- Applied exactly once by the version-aware runner in quota.js (gated on
-- schema_version). Purely additive — a brand-new table, no existing table
-- touched, so (unlike 006) this needs no CHECK-constraint rebuild.
--
-- Mirrors banned_accounts' shape (hive_account PK + who/when + soft-delete via
-- removed_at/removed_by, same pattern as banned_accounts.unbanned_at/by).
-- Two knobs beyond the ban-table shape:
--   quota_bytes  — per-account byte cap, checked IN ADDITION to the global
--                  DISK_LIMIT_BYTES (tightest wins). NULL = no per-account cap.
--   fee_exempt   — 1 = pricing runs at rate 0 for this account (Stage B wires
--                  the call sites; the column ships now so 007 is the only
--                  whitelist migration).

CREATE TABLE IF NOT EXISTS whitelisted_accounts (
  hive_account    TEXT PRIMARY KEY,
  added_at        INTEGER NOT NULL,
  added_by        TEXT NOT NULL,       -- 'operator' (ADMIN_KEY tier) or 'hive:<account>' (Hive-tier admin)
  quota_bytes     INTEGER,             -- NULL = unlimited (shared-disk fallback)
  fee_exempt      INTEGER NOT NULL DEFAULT 0 CHECK (fee_exempt IN (0,1)),
  note            TEXT,
  removed_at      INTEGER,
  removed_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_whitelisted_accounts_active
  ON whitelisted_accounts(hive_account, removed_at);

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (7, CAST(strftime('%s','now') AS INTEGER) * 1000);
