// ipfs-gate v1 — Stage 2 replication-dial tests (node:test). Pure pricing — no DB.
// copies is capped at the live node_count; the cost scales by copies; and the
// copies count maps to an IPFS-Cluster replication_factor (max / max−leeway).
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const pricing = require('../pricing');

test('copies are capped at node_count (single-node v1 offers only 1)', () => {
  assert.equal(pricing.cappedCopies(5, 1), 1);   // 1-node gate → backstop is the only co-host
  assert.equal(pricing.cappedCopies(1, 1), 1);
  assert.equal(pricing.cappedCopies(5, 5), 5);   // 5-node cluster → up to 5
  assert.equal(pricing.cappedCopies(3, 5), 3);
  assert.equal(pricing.cappedCopies(0, 5), 1);   // floor 1
});

test('getNodeCount() returns the configured value (1 by default)', () => {
  assert.equal(pricing.getNodeCount(), 1);
});

test('cost scales by copies, after capping at node_count', () => {
  // 5 MB × 1 h × rate 1
  assert.equal(pricing.calculateCost({ sizeBytes: 5_000_000, hoursRequested: 1, copies: 5, nodeCount: 5 }).total, 25); // 5×
  assert.equal(pricing.calculateCost({ sizeBytes: 5_000_000, hoursRequested: 1, copies: 5, nodeCount: 1 }).total, 5);  // capped to 1×
  const q = pricing.calculateCost({ sizeBytes: 5_000_000, hoursRequested: 1, copies: 5, nodeCount: 5 });
  assert.equal(q.copies, 5);
});

test('replicationConfig maps copies → Cluster factor (max / max−leeway), self-heal on', () => {
  assert.deepEqual(pricing.replicationConfig(5, { leeway: 2 }), {
    replication_factor_max: 5, replication_factor_min: 3, disable_repinning: false
  });
  assert.deepEqual(pricing.replicationConfig(1), {
    replication_factor_max: 1, replication_factor_min: 1, disable_repinning: false  // min floored at 1
  });
  // min never drops below 1 even when leeway exceeds copies
  assert.equal(pricing.replicationConfig(2, { leeway: 5 }).replication_factor_min, 1);
});
