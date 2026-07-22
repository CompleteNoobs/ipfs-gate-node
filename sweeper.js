// ipfs-gate v1 — sweeper / reconcile loop.
// Periodic background job that:
//   1. Marks expired reservations as 'expired'
//   2. Expires CLAIMS past their timer (the v1 lifecycle authority) + their pins
//   3. Expires any legacy pins past their own clock
//   4. Unpins from Kubo + GCs any CIDs that now have no active pin records
//      (last-funder unpin; Stage 1b will promote a dormant guardian here instead)
//
// Runs every SWEEPER_INTERVAL_MS (default 60s).

const quota = require('./quota');
const kubo = require('./backends/kubo');

const SWEEPER_INTERVAL_MS = parseInt(process.env.SWEEPER_INTERVAL_MS || '60000', 10);

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    console.log('[sweeper] previous run still in progress, skipping');
    return;
  }
  running = true;
  try {
    const result = quota.sweep();
    if (result.expired_reservations || result.expired_claims || result.expired_pins || result.cids_to_unpin.length) {
      console.log(`[sweeper] expired_reservations=${result.expired_reservations} expired_claims=${result.expired_claims} expired_pins=${result.expired_pins} cids_to_unpin=${result.cids_to_unpin.length}`);
    }

    if (result.cids_to_unpin.length > 0) {
      let unpinned = 0;
      for (const cid of result.cids_to_unpin) {
        try {
          await kubo.unpin(cid);
          unpinned++;
        } catch (e) {
          console.warn(`[sweeper] failed to unpin ${cid}: ${e.message}`);
        }
      }
      if (unpinned > 0) {
        try {
          await kubo.gc();
          console.log(`[sweeper] unpinned ${unpinned}, ran GC`);
        } catch (e) {
          console.warn(`[sweeper] GC failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`[sweeper] run failed: ${e.message}`);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  console.log(`[sweeper] starting, interval = ${SWEEPER_INTERVAL_MS}ms`);
  // Run once on boot, then on interval
  runOnce().catch(() => {});
  timer = setInterval(() => runOnce().catch(() => {}), SWEEPER_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, runOnce };