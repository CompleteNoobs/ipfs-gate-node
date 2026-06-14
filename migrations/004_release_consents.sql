-- ipfs-gate v1 — Stage 3 (release authority). Per-recipient release consents.
-- Applied once by the version-aware runner (gated on schema_version).
--
-- The release_policy itself already lives on `orders` (migration 003,
-- default {"type":"owner_only"}). This table records each recipient's signed
-- consent so an `all_of` policy can tell when the full set has agreed to stop
-- hosting. (cohosting / PRICING-V1 handover §12.)

CREATE TABLE IF NOT EXISTS release_consents (
  order_id     TEXT NOT NULL,
  releaser     TEXT NOT NULL,         -- Hive account that consented (lowercased)
  consented_at INTEGER NOT NULL,
  sig          TEXT,                  -- the release signature (audit)
  PRIMARY KEY (order_id, releaser),   -- idempotent: one consent per releaser per order
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_release_consents_order ON release_consents(order_id);

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (4, CAST(strftime('%s','now') AS INTEGER) * 1000);
