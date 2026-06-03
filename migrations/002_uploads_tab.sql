-- ipfs-gate v0.2 — uploads-management tab + public/plaintext upload mode.
-- Applied exactly once by the version-aware runner in quota.js (gated on
-- schema_version). Additive + back-compat: existing rows default to
-- mode='encrypted' / mime=NULL, preserving the v0.1 encrypted-only behaviour.
--
-- NOTE: column-level CHECK on `mode` is enforced in code (createReservation /
-- createPin validate mode ∈ {'encrypted','public'}) rather than via ALTER ...
-- ADD COLUMN ... CHECK, to keep the ALTER portable across SQLite versions.
--
-- User-initiated deletes reuse the existing pins.status='expired' value with
-- status_reason='user_deleted' (no new enum value → no risky table rebuild of
-- the status CHECK on a live DB). hasActivePinForCid / getDiskUsage already
-- treat any non-'active' row as freed, so quota is released automatically.

ALTER TABLE reservations ADD COLUMN mode TEXT NOT NULL DEFAULT 'encrypted';
ALTER TABLE pins         ADD COLUMN mode TEXT NOT NULL DEFAULT 'encrypted';
ALTER TABLE pins         ADD COLUMN mime TEXT;

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (2, CAST(strftime('%s','now') AS INTEGER) * 1000);
