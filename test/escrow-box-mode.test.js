// ── test/escrow-box-mode.test.js — the node-side box-mode seam, in isolation ──
// Drives the REAL queue + reporter + box-mode orchestrator with a FAKE transport
// (the clientFactory seam) and box-signed receipts minted with a test box key.
// Proves the node half of the flip:
//   - settleClaim durably enqueues claim-settle facts (synthetics filtered) and
//     publishes once; a duplicate settle is a single-winner no-op
//   - a box-signed 'settled' receipt fires onSettled EXACTLY once; duplicates no-op
//   - a 'failed' receipt parks the row failed (drainer stops) and still finalizes
//   - a 'pending' receipt finalizes, then the box's COMPLETION receipt fires
//     onCompleted exactly once
//   - a receipt not signed by the pinned box key is ignored
//   - pending reports survive a restart (fresh orchestrator, same db) and drain
//   - no reporting key → stays queued; drains once the key appears

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const escrowCore = require('escrow-core');
const { createEscrowBoxMode } = require('../escrow-box-mode');
const { createSettlementQueue } = require('../escrow-settlement-queue');
const { createEscrowReporter } = require('../escrow-report');

const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

function makeFakeClient(published) {
  return ({ boxPubkey }) => {
    const c = {
      boxPubkey,
      _onReceipt: null,
      start(onReceipt) { c._onReceipt = onReceipt; },
      async publishReport(signed) { published.push(signed); },
      close() {},
    };
    makeFakeClient.last = c;
    return c;
  };
}

function setup({ dbPath = ':memory:', skAvailable = true } = {}) {
  const db = new Database(dbPath);
  const queue = createSettlementQueue({ db });
  const nodeSk = crypto.randomBytes(32).toString('hex');
  const boxSk = crypto.randomBytes(32).toString('hex');
  const boxPub = escrowCore.getReportingPubkey(boxSk);
  let keyReady = skAvailable;
  const reporter = createEscrowReporter({
    escrowCore, getSkHex: () => (keyReady ? nodeSk : null), reporter: 'tgate', service: 'ipfs-gate' });
  const adapter = escrowCore.createIpfsGateAdapter({ account: 'tgateescrow', currency: 'HBD', keyEnv: 'TGATE_NODE_TEST_KEY' });
  const published = [];
  const mk = () => createEscrowBoxMode({
    escrowAdapter: adapter, escrowReporter: reporter, queue,
    boxPubkey: boxPub, relays: ['wss://fake'], selfSkHex: () => (keyReady ? nodeSk : null),
    log: { log() {}, warn() {}, error() {} },
    clientFactory: makeFakeClient(published),
  });
  const boxReceipt = (over = {}) => escrowCore.signReport(escrowCore.buildSettlementReceipt({
    ref: 'c1', settlement: 50, refund: 190, dust: 0, currency: 'HBD',
    disburseTx: 'boxtx1', status: 'settled', createdAt: NOW, ...over }), boxSk);
  const setKeyReady = (v) => { keyReady = v; };
  return { db, queue, adapter, reporter, boxSk, boxPub, published, mk, boxReceipt, setKeyReady };
}

const claim = (over = {}) => ({
  claim_id: 'c1', owner: 'alice', kind: 'original', state: 'active',
  size_bytes: 5_000_000, rate_locked: 1, copies_requested: 1, paid_hours: 48,
  start_ts: NOW - 10 * HOUR_MS, expiry_ts: NOW + 38 * HOUR_MS,
  amount_paid: 240, currency: 'HBD', ...over });

const payRows = () => [
  { tx_id: 'tx1', uploader: 'alice', amount: 240, memo: 'ipfs-gate:upload:r1', currency: 'HBD' },
  { tx_id: 'whitelist-free:extend:c1:123', uploader: 'alice', amount: 0, memo: 'ipfs-gate:extend:c1', currency: 'HBD' },
];

test('settleClaim enqueues claim-settle facts (synthetics filtered) and publishes once', async () => {
  const s = setup();
  const bm = s.mk();
  const won = await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(),
    trigger: 'cancel', now: NOW, meta: { refund_id: 'rf1' } });
  assert.equal(won, true);
  assert.equal(s.published.length, 1);
  const signed = s.published[0];
  assert.equal(signed.type, 'event-report');
  assert.equal(signed.service, 'ipfs-gate');
  assert.equal(signed.ref, 'c1');
  assert.equal(signed.nonce, 'c1:settle');
  assert.equal(signed.facts.kind, 'claim-settle');
  assert.equal(signed.facts.trigger, 'cancel');
  assert.equal(signed.facts.payments.length, 1, 'synthetic whitelist row filtered');
  assert.equal(signed.facts.payments[0].txId, 'tx1');
  assert.ok(escrowCore.verifyReport(signed, s.reporter.pubkey()), 'report verifies under the node key');
  const row = s.queue.get('c1');
  assert.equal(row.status, 'pending');
  assert.deepEqual(JSON.parse(row.meta_json), { refund_id: 'rf1' });

  const again = await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(),
    trigger: 'cancel', now: NOW });
  assert.equal(again, false, 'duplicate settle is a single-winner no-op');
  assert.equal(s.published.length, 1);
});

test('a box-signed settled receipt fires onSettled EXACTLY once; duplicates no-op', async () => {
  const s = setup();
  const bm = s.mk();
  const fired = [];
  bm.onSettled(async (ref, { receipt, meta }) => fired.push({ ref, status: receipt.status, meta }));
  await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(), trigger: 'cancel', now: NOW, meta: { refund_id: 'rf1' } });
  const receipt = s.boxReceipt();
  await bm._handleReceipt(receipt);
  await bm._handleReceipt(receipt);          // duplicate
  assert.deepEqual(fired, [{ ref: 'c1', status: 'settled', meta: { refund_id: 'rf1' } }]);
  assert.equal(s.queue.get('c1').status, 'settled');
});

test('a failed receipt parks the row and still finalizes exactly once', async () => {
  const s = setup();
  const bm = s.mk();
  const fired = [];
  bm.onSettled(async (ref, { receipt }) => fired.push(receipt.status));
  await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(), trigger: 'cancel', now: NOW });
  await bm._handleReceipt(s.boxReceipt({ status: 'failed', reason: 'no_verified_payments', settlement: 0, refund: 0, disburseTx: null }));
  assert.deepEqual(fired, ['failed']);
  assert.equal(s.queue.get('c1').status, 'failed');
  assert.equal(s.queue.pending().length, 0, 'drainer stops retrying a terminal row');
});

test('pending receipt finalizes; the completion receipt fires onCompleted exactly once', async () => {
  const s = setup();
  const bm = s.mk();
  const settled = [], completed = [];
  bm.onSettled(async (ref, { receipt }) => settled.push(receipt.status));
  bm.onCompleted(async (ref, { receipt }) => completed.push(receipt.status));
  await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(), trigger: 'cancel', now: NOW });
  await bm._handleReceipt(s.boxReceipt({ status: 'pending', disburseTx: null }));
  assert.deepEqual(settled, ['pending']);
  const completion = s.boxReceipt({ status: 'settled', disburseTx: 'boxtx-late' });
  await bm._handleReceipt(completion);
  await bm._handleReceipt(completion);       // duplicate completion
  assert.deepEqual(completed, ['settled'], 'onCompleted exactly once');
});

test('a receipt not signed by the pinned box key is ignored', async () => {
  const s = setup();
  const bm = s.mk();
  const fired = [];
  bm.onSettled(async () => fired.push(1));
  await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(), trigger: 'cancel', now: NOW });
  const strangerSk = crypto.randomBytes(32).toString('hex');
  const forged = escrowCore.signReport(escrowCore.buildSettlementReceipt({
    ref: 'c1', settlement: 0, refund: 240, dust: 0, currency: 'HBD',
    disburseTx: 'evil', status: 'settled', createdAt: NOW }), strangerSk);
  await bm._handleReceipt(forged);
  assert.equal(fired.length, 0);
  assert.equal(s.queue.get('c1').status, 'pending', 'row untouched by a forged receipt');
});

test('pending reports survive a restart and drain again (durable queue)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-node-queue-'));
  const dbPath = path.join(dir, 'q.db');
  const s = setup({ dbPath });
  const bm1 = s.mk();
  await bm1.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(), trigger: 'cancel', now: NOW });
  assert.equal(s.published.length, 1);

  const bm2 = s.mk();                        // "restart": same db, fresh orchestrator
  const n = await bm2.drainOnce();
  assert.equal(n, 1, 'the pending report republishes after restart');
  assert.equal(s.published.length, 2);
  assert.equal(s.published[1].nonce, 'c1:settle', 're-signed under the STABLE nonce (box dedups)');
});

test('no reporting key → stays queued; drains once the key appears', async () => {
  const s = setup({ skAvailable: false });
  const bm = s.mk();
  const won = await bm.settleClaim({ claimId: 'c1', claim: claim(), payRows: payRows(), trigger: 'cancel', now: NOW });
  assert.equal(won, true, 'still durably enqueued');
  assert.equal(s.published.length, 0, 'nothing published without a key');
  s.setKeyReady(true);
  const n = await bm.drainOnce();
  assert.equal(n, 1);
  assert.equal(s.published.length, 1, 'publishes once the key is readable');
});
