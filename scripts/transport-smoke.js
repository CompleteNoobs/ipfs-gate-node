#!/usr/bin/env node
// ── transport-smoke.js — prove the node↔box escrow wire end-to-end, zero funds ──
// Publishes a single-payment report with a FABRICATED txId to the real box over
// the real relay. The box re-verifies on-chain, finds nothing (structural), and
// terminally rejects with a SIGNED status:'failed' receipt — which this script
// verifies under the pinned box key and uses to flip its queue row to 'failed'.
// A 'failed' outcome here is the SUCCESS condition: it proves publish → relay →
// box hard gates → on-chain verify → signed receipt → node verify → exactly-once
// finalize, without a single coin moving.
//
// Env (same names as box mode): ESCROW_BOX_PUBKEY, NOSTR_RELAYS,
// ESCROW_REPORTING_KEY_PATH, IPFS_GATE_HIVE_ACCOUNT. Run with --env-file=.env.

'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const escrowCore = require('escrow-core');
const { createEscrowBoxMode } = require('../escrow-box-mode');
const { createSettlementQueue } = require('../escrow-settlement-queue');
const { createEscrowReporter } = require('../escrow-report');

const BOX_PUB = (process.env.ESCROW_BOX_PUBKEY || '').toLowerCase();
const RELAYS = (process.env.NOSTR_RELAYS || 'wss://nostr.v4call.com').split(',').map(s => s.trim()).filter(Boolean);
const KEY_PATH = process.env.ESCROW_REPORTING_KEY_PATH || './data/escrow-reporting-key.json';
const ACCOUNT = process.env.IPFS_GATE_HIVE_ACCOUNT || 'smoke';
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS || '45000', 10);

async function main() {
  if (!/^[0-9a-f]{64}$/.test(BOX_PUB)) { console.error('FATAL: ESCROW_BOX_PUBKEY required'); process.exit(1); }
  const skHex = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')).sk_hex.toLowerCase();

  const db = new Database(':memory:');
  const queue = createSettlementQueue({ db });
  const reporter = createEscrowReporter({ escrowCore, getSkHex: () => skHex, reporter: ACCOUNT, service: 'ipfs-gate' });
  const adapter = escrowCore.createIpfsGateAdapter({ account: ACCOUNT, currency: 'CNOOBS', keyEnv: 'IPFS_GATE_ACTIVE_KEY' });

  // A FIXED ref (SMOKE_REF) makes the smoke two-run-safe on flaky/lab relays:
  // run 1 publishes and may time out while the box grinds through live-chain
  // verification; the box's receipt is STORED on the relay, so run 2 with the
  // same ref receives it from history and passes.
  const ref = process.env.SMOKE_REF || `smoke-${Date.now()}`;
  let done = false;

  const bm = createEscrowBoxMode({
    escrowAdapter: adapter, escrowReporter: reporter, queue,
    boxPubkey: BOX_PUB, relays: RELAYS, selfSkHex: () => skHex,
    log: console,
  });
  bm.onSettled(async (r, { receipt }) => {
    if (r !== ref) return;
    done = true;
    const row = queue.get(ref);
    console.log(`\nRECEIPT RECEIVED for ${r}: status=${receipt.status} reason=${receipt.reason || '-'}`);
    console.log(`queue row status: ${row.status}`);
    if (receipt.status === 'failed' && row.status === 'failed') {
      console.log('\x1b[32mTRANSPORT SMOKE PASSED\x1b[0m — full node→relay→box→relay→node round-trip, signed both ways, exactly-once finalize.');
      process.exit(0);
    } else {
      console.error(`\x1b[31mUNEXPECTED OUTCOME\x1b[0m — a fabricated tx should terminally fail, got '${receipt.status}'.`);
      process.exit(1);
    }
  });

  await bm.start();
  console.log(`publishing fabricated single-payment report ref=${ref} → box ${BOX_PUB.slice(0, 12)}…`);
  // The fake txId MUST be 40-hex: a malformed id makes Hive nodes throw an
  // UNCODED JSON-RPC error ("Invalid hex character") which classifies as
  // transient → the box silently retries forever and no receipt ever comes.
  // A well-formed-but-nonexistent id yields unprocessable_entity (structural)
  // → terminal failed receipt → the round-trip completes. (Found live 2026-07-22.)
  await bm.settlePayment({
    ref, txId: 'ab'.repeat(20), sender: ACCOUNT, amount: 0.001,
    currency: process.env.PAYMENT_CURRENCY || 'CNOOBS',
    memo: `ipfs-gate:upload:${ref}`, payoutTo: ACCOUNT, platformFee: 0, now: Date.now(),
  });

  setTimeout(() => {
    if (!done) {
      console.error(`\x1b[31mTIMED OUT\x1b[0m after ${TIMEOUT_MS}ms — no receipt. Check the box log, relay reachability, and that this node's pubkey (${reporter.pubkey()}) is in the box's ESCROW_EXPECTED_REPORTERS.`);
      process.exit(1);
    }
  }, TIMEOUT_MS);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
