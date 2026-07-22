// ── ipfs-gate-node/escrow-box-mode.js — box-mode settlement orchestration (ESCROW_MODE=box) ──
//
// Adapted from v4call-node/escrow-box-mode.js (proven live): settleCall → settleClaim.
// Ties together the three node-side pieces of the escrow split: the durable pending-report
// QUEUE (escrow-settlement-queue.js), the Nostr box CLIENT (escrow-box-client.mjs), and a
// DRAINER. In box mode the node is KEYLESS: it builds a claim-settle `event-report` from the
// claim row + its payment rows, hands it to the box, and finalizes (refund row pending→sent)
// only when the box returns a signed `settlement-receipt`. The BOX is the settlement
// authority — it re-verifies every payment on-chain and disburses with the only money key.
// The node only reports and displays; it holds NO money key.
//
// IDEMPOTENCY: the queue's UNIQUE(ref) is the single-winner guard; the stable `ref:settle`
// nonce lets the box dedup republished reports; and markSettled(pending→settled) fires the
// finalize handler EXACTLY once per claim — whether the receipt arrives promptly or after a
// restart via the drainer.
//
// ROBUSTNESS: the queue stores the UNSIGNED facts; the drainer signs fresh on each publish,
// so a report enqueued before the reporting key is readable still settles once the key
// appears, and a transient publish failure simply retries on the next drain tick —
// "retry until received".

'use strict';

function createEscrowBoxMode({
  escrowAdapter, escrowReporter, queue, boxPubkey, relays, selfSkHex,
  drainIntervalMs = 30000, log = console,
  clientFactory = null,   // test seam: inject a fake transport; default = the real Nostr client
}) {
  if (!escrowAdapter || !escrowReporter || !queue) throw new Error('createEscrowBoxMode: escrowAdapter, escrowReporter, queue are required');
  if (!/^[0-9a-f]{64}$/i.test(String(boxPubkey || ''))) throw new Error('createEscrowBoxMode: boxPubkey must be 64-hex');

  const box = String(boxPubkey).toLowerCase();
  let client = null;
  let onSettledHandler = async () => {};
  let onCompletedHandler = async () => {};

  const L = {
    info: (m) => log.log && log.log(`[escrow-box] ${m}`),
    warn: (m) => log.warn && log.warn(`[escrow-box] ${m}`),
    error: (m) => log.error && log.error(`[escrow-box] ${m}`),
  };

  /** Register the finalize handler. Called EXACTLY once per settled claim with
   *  (ref, { facts, receipt, meta }) — server.js flips the refund row pending→sent/failed. */
  function onSettled(fn) { onSettledHandler = fn; }

  /** Register the COMPLETION handler: a finalized-as-pending settlement whose refund
   *  later landed via the box's recovery retry (or flipped to failed). Called EXACTLY
   *  once per pending→settled/failed transition with (ref, { facts, receipt, meta }). */
  function onCompleted(fn) { onCompletedHandler = fn; }

  // Lazily create the transport. Returns the client, or null if the reporting key isn't
  // readable yet — settlements stay durably queued and the drainer retries.
  async function ensureClient() {
    if (client) return client;
    const sk = selfSkHex();
    if (!sk) return null;
    if (clientFactory) {
      client = clientFactory({ relays, selfSkHex: sk, boxPubkey: box, log: (lvl, m) => L.info(m) });
    } else {
      const { createEscrowBoxClient } = await import('./escrow-box-client.mjs');
      client = createEscrowBoxClient({ relays, selfSkHex: sk, boxPubkey: box, log: (lvl, m) => L.info(m) });
    }
    client.start(handleReceipt);
    L.info(`transport up — node reporting pubkey ${escrowReporter.pubkey() || '(deriving)'} (add it to the box's ESCROW_EXPECTED_REPORTERS)`);
    return client;
  }

  // Inbound box → node: a signed settlement-receipt. Verify under the BOX key, match a
  // pending report, finalize exactly once. Anything that doesn't verify is dropped.
  async function handleReceipt(receipt) {
    const ref = receipt && receipt.ref;
    if (!ref) return;
    if (!escrowReporter.verifyReceiptFromBox(receipt, box)) {
      L.warn(`receipt for ${ref} failed verify under box key — ignored`);
      return;
    }
    const row = queue.get(ref);
    if (!row) { L.warn(`receipt for unknown/!queued ref ${ref} — ignored`); return; }
    // A status:'failed' receipt is the box's TERMINAL rejection of this report. Park the
    // row as 'failed' — ends the drainer's retry loop — and still fire the finalize
    // handler exactly once so server.js marks the refund row failed.
    const marked = receipt.status === 'failed'
      ? queue.markFailed(ref, receipt)
      : queue.markSettled(ref, receipt);
    if (marked) {
      let facts = {}, meta = null;
      try { facts = JSON.parse(row.facts_json); } catch {}
      try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch {}
      try { await onSettledHandler(ref, { facts, receipt, meta }); }
      catch (e) { L.error(`finalize ${ref} threw: ${e.message}`); }
      if (receipt.status === 'failed') {
        L.error(`${ref} REJECTED by box (terminal): ${receipt.reason || 'no reason given'} — parked as failed; nothing was disbursed. Operator action needed if a real payment is stranded.`);
      } else {
        L.info(`settled ${ref} via box: retained=${receipt.settlement} refund=${receipt.refund} status=${receipt.status}`);
      }
    } else {
      // Row already terminal. If the STORED receipt said 'pending' and this one is a
      // definitive settled/failed, it's the box's COMPLETION receipt — the recovery
      // retry finished the refund (or gave up). Fire onCompleted EXACTLY once for the
      // pending→terminal transition; duplicates are no-ops.
      let stored = null;
      try { stored = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch {}
      if (stored && stored.status === 'pending' && (receipt.status === 'settled' || receipt.status === 'failed')) {
        queue.updateReceipt(ref, receipt);
        let facts = {}, meta = null;
        try { facts = JSON.parse(row.facts_json); } catch {}
        try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch {}
        try { await onCompletedHandler(ref, { facts, receipt, meta }); }
        catch (e) { L.error(`onCompleted ${ref} threw: ${e.message}`); }
        L.info(`${ref} settlement COMPLETED (was pending): status=${receipt.status}`);
      } // else: plain duplicate receipt — no-op
    }
  }

  // Sign (fresh, under the stable nonce) and publish one pending row. Stays pending on any
  // failure (no key yet / transient relay error) so the next drain retries — never lost.
  async function publishRow(row) {
    const c = await ensureClient();
    if (!c) { L.warn(`${row.ref}: reporting key not ready — stays queued`); return false; }
    let facts; try { facts = JSON.parse(row.facts_json); } catch (e) { L.error(`${row.ref}: corrupt facts_json — skipping`); return false; }
    const signed = escrowReporter.buildSignedReport({ ref: row.ref, subject: row.ref, facts, nonce: row.nonce, createdAt: row.created_at });
    if (!signed) { L.warn(`${row.ref}: could not sign report (key not ready) — stays queued`); return false; }
    queue.markAttempt(row.ref, Date.now());
    try { await c.publishReport(signed); return true; }
    catch (e) { L.warn(`${row.ref}: publish failed (will retry): ${e.message}`); return false; }
  }

  // Republish every still-pending report (boot recovery + the periodic retry).
  async function drainOnce() {
    const rows = queue.pending();
    for (const row of rows) await publishRow(row);
    return rows.length;
  }

  /**
   * Settle a claim via the box. Builds the claim-settle envelope from the claim row + its
   * payment rows (synthetic whitelist rows are filtered by the adapter builder), durably
   * enqueues it (single-winner), and publishes. Finalization happens asynchronously in
   * handleReceipt when the box returns a signed receipt. NON-blocking on the box's response.
   *
   * @param claimId   the claim id (the report `ref`)
   * @param claim     the claims row (pre-flip state — state reflects what it WAS)
   * @param payRows   the claim's payment rows (original + extend top-ups)
   * @param trigger   broadcastRefund's reason string (the trigger vocabulary)
   * @param now       settlement-clock epoch ms
   * @param meta      finalize context (e.g. { refund_id }) for onSettled/onCompleted
   * @returns true iff a NEW report was enqueued (false on a duplicate)
   */
  async function settleClaim({ claimId, claim, payRows, trigger, now, meta = null }) {
    const facts = escrowAdapter.buildClaimSettleReportFacts({ claim, payRows, trigger, now });
    const nonce = escrowReporter.settleNonce(claimId);
    const won = queue.enqueue(claimId, facts, nonce, now, meta);
    if (!won) { L.info(`${claimId} already queued (duplicate settle) — ignored`); return false; }
    await publishRow(queue.get(claimId));
    return true;
  }

  /**
   * Settle a single (non-claim) payment via the box — reserved for a future admin
   * orphan-refund path. Same durable enqueue + publish + async-finalize pattern.
   */
  async function settlePayment({ ref, txId, sender, amount, currency, memo, payoutTo, platformFee = 0, now, meta = null }) {
    const facts = escrowAdapter.buildSinglePaymentReportFacts({ txId, sender, amount, currency, memo, payoutTo, platformFee });
    const nonce = escrowReporter.settleNonce(ref);
    const won = queue.enqueue(ref, facts, nonce, now, meta);
    if (!won) { L.info(`${ref} already queued (duplicate settle) — ignored`); return false; }
    await publishRow(queue.get(ref));
    return true;
  }

  // Boot: bring up the transport (if the key is ready) and drain any reports left pending
  // from a prior run, then retry on an interval. Never throws (a transport problem must
  // not crash the gate).
  async function start() {
    try { await ensureClient(); } catch (e) { L.error(`transport init failed (will retry on drain): ${e.message}`); }
    try { const n = await drainOnce(); if (n) L.info(`drained ${n} pending report(s) on boot`); } catch (e) { L.error(`boot drain failed: ${e.message}`); }
    const t = setInterval(() => { drainOnce().catch(e => L.error(`drain tick failed: ${e.message}`)); }, drainIntervalMs);
    if (t && typeof t.unref === 'function') t.unref();
  }

  return { start, settleClaim, settlePayment, onSettled, onCompleted, drainOnce, _handleReceipt: handleReceipt };
}

module.exports = { createEscrowBoxMode };
