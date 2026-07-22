-- ipfs-gate v1 — Stage 6 (proof-of-receipt). Per-recipient decryption receipts.
-- Applied once by the version-aware runner (gated on schema_version).
--
-- WHY a separate stored hash (orders.receipt_hash) instead of reusing the salted
-- commitment that rides in the v4call Reveal link: that commitment is PUBLIC
-- (anyone holding the link has it + the salt), so presenting it proves nothing.
-- `receipt_hash` = SHA-256(plaintext bytes) is NOT in the link — a bystander has
-- only the ciphertext, so they cannot reproduce it; only an account that actually
-- decrypted can. The receipt endpoint checks the recipient's signed hash against
-- this value, records the receipt, and feeds it into the Stage-3 release threshold
-- (recordReleaseConsent / evaluateRelease). See STAGE-4-HANDOFF.md §5.

-- The plaintext hash the sender committed to at upload (NULL for pre-Stage-6
-- uploads + public uploads → those orders can't accept receipts).
ALTER TABLE orders ADD COLUMN receipt_hash TEXT;

CREATE TABLE IF NOT EXISTS receipts (
  order_id     TEXT NOT NULL,
  recipient    TEXT NOT NULL,         -- Hive account that proved decryption (lowercased)
  proof_hash   TEXT NOT NULL,         -- the SHA-256(plaintext) they reproduced (== orders.receipt_hash)
  received_at  INTEGER NOT NULL,
  sig          TEXT,                  -- the receipt signature (audit)
  PRIMARY KEY (order_id, recipient),  -- idempotent: one receipt per recipient per order
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_receipts_order ON receipts(order_id);

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (5, CAST(strftime('%s','now') AS INTEGER) * 1000);
