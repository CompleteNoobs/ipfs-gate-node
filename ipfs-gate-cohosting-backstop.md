# ipfs-gate — Co-Hosting, Backstop & Refunds (multi-participant CID)

> ⚠️ **Proof of concept — not for real use.** ipfs-gate (with sister projects
> v4call and nGate) is a concept design build by independent builders. Numbers
> and policies here are design decisions for a demo, not a live service.
>
> **Status: DESIGN LOCKED (2026-06-14).** Resolves the v0.3 ↔ current-model
> vocabulary clash and pins down the backstop ("help-fund") algorithm,
> refund-on-cancel, extend/top-up, and how admin moderation composes with the
> escrow. Buildable in v1 (Stage 1b of the build plan).
>
> **Reads with:** [PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md)
> (the formula; §3 there is the refund summary), `v4call-ipfs-gate-build-handover.md`
> (the wider feature), and [roadmap_status.md](roadmap_status.md) (where this
> lands in the build plan). **Supersedes** the refund/toll stance in
> `Archive.PRICING-V0.3-DESIGN-NOTES.md`.

---

## 0. The v1 invariant (read this first)

**At most one *active* (paying, disk-occupying) claim per CID at a time, plus a
FIFO queue of *dormant* backstops.**

A second person who wants in on an already-hosted CID either:
- adds a **real extra copy** — but that needs a *free node*, so it is **not
  available on a single-node v1 gate**; or
- places a **backstop** — a prepaid, dormant safety-net that only activates if
  the file would otherwise be deleted.

So on a one-node gate, the only co-hosting option offered is **backstop**. The
handover §9 "two owners share one physical copy in parallel" idea is **dropped
for v1** and deferred to multi-node — which is what removes the old
pro-rata-vs-dedup tension entirely (every active claim is the sole funder of the
bytes it pays for, so pro-rata is always clean; see §6).

---

## 1. Plain language — three ways to fund a file (`cid1`)

1. **Original host** — first to pay. Holds the live copy, has their own timer.
2. **Own copy (co-host)** — pay **now** for your **own** extra copy on **another
   node**. Independent; survives no matter what the original does. *Needs a free
   node to be real redundancy → not offered on a single-node v1 gate.*
3. **Backstop (help-fund / safety net)** — **prepay into escrow now**, but it
   only **starts spending if the file would otherwise be deleted**. If the file
   never gets that close, your escrow is returned (minus a small cancel fee).
   You pay for hosting only across the stretch where you are the live host.

These are three *different* things. Naming them apart is the whole fix for the
earlier "word soup."

---

## 2. It's still all just claims

A claim = one `(cid, owner)` hosting record. Two new fields:

**`kind`**
- `original` / `own_copy` — a **live** hosting claim. Adds its copies to the
  pin. Bills from the start.
- `backstop` — a **standby** claim. Adds nothing while waiting. Bills only once
  activated.

**`state`**
- `active` — live, metering time, contributing its copies.
- `dormant` — a backstop waiting in the queue. Not metering, not adding copies,
  funds sitting in escrow.
- `cancelled` / `expired` — closed.

A backstop is just bar's own order on `cid1` with `kind = backstop`,
`state = dormant`. Same schema, same identity (Hive key), same money rails.

---

## 3. Money: backstops prepay into escrow

A backstop is **not** "pay nothing now" — Hive has no pull-payments and the
pledger won't be online at activation, so the funds must already be under the
gate's control. The honest model:

- **At pledge:** bar sends `cost = billable_MB × pledged_hours × rate_locked ×
  copies` to the gate escrow (`IPFS_GATE_HIVE_ACCOUNT`). The `rate_locked` is
  captured now and never retro-changes.
- **While dormant:** the escrow just sits there. bar can cancel anytime and gets
  it back **minus `BACKSTOP_CANCEL_FEE_PCT`** (admin env, default `1`% — deters
  pledge-then-cancel churn / queue-spam; `0` = off). The fee applies **only to
  user-initiated dormant cancels** (see §7 for the no-fee-on-forced rule).
- **On activation:** the held escrow begins being consumed as hosting time
  (§5). From here it behaves like any active claim.
- **Custodial note:** escrowed-but-unspent backstop funds are money the gate
  owes back. That's a real custodial float — needs a durable, backed-up balance
  ledger and an honest refund path. Small at hobby scale, but not zero; treat
  the ledger as load-bearing (same lesson the archived V0.3 prepaid-balance doc
  flagged).

### copies are capped at the **live** node_count
At pledge/selection time the copies a user can buy is capped at the number of
nodes the gate is **currently** running, so nobody escrows for phantom
redundancy the gate can't deliver (e.g. choosing "2 copies" on a 1-node gate
escrows for 1).

- **v1 (single Kubo node):** `node_count` comes from config (env, effectively
  `1`). The UI offers only 1 copy.
- **Multi-node (later):** `node_count` becomes a **live read of the healthy
  cluster peer count** at the moment of the quote. Same code path; the source
  swaps from config to a cluster query. No rework — this is the seam.

---

## 4. Replication interaction

- **active** claims' `copies` sum into `cid1`'s replication target, capped at
  the live `node_count`.
- **dormant** backstops contribute **0** copies — they lean on the copy already
  there, so a backstop needs **no free node**. (This is why a backstop is
  available even on a full single-node gate.)
- an **own_copy** needs a free node to be genuine extra redundancy: allowed only
  while `current_copies < node_count` → not available on a single-node v1 gate.

---

## 5. The lifecycle (the algorithm)

**Pinned while:** any `active` claim exists **OR** any `dormant` backstop exists.

**When an active claim ends (cancel or expiry):**

1. Recompute live state for `cid1`.
2. **If any `active` claim still remains** → file stays pinned at the remaining
   target. Done. Backstops stay dormant — the file was never in danger.
3. **If NO `active` claim remains BUT a `dormant` backstop exists** → **activate
   the next backstop** (FIFO, by pledge order):
   - `state: dormant → active`
   - `start_ts = now`, `expiry_ts = now + pledged_hours`
   - replication target = its `copies_requested` (capped at live `node_count`)
   - begin consuming its escrow
4. **If NO `active` claim AND NO `dormant` backstop remains** → unpin + delete
   `cid1`.

Steps 2 and 4 are the existing last-claim-unpin check. Step 3 is the only new
line: *promote the next standby instead of deleting.* The baton passes
foo → bar → foobar down the queue; each pays only for the stretch they are the
live host.

**Activation order:** **FIFO**, strictly by pledge time (locked). First to
pledge takes the baton first.

> Because the head backstop activates the **instant** the last active claim ends,
> a dormant backstop never holds a file pinned "for free" for any real duration —
> there is no free-storage hole.

---

## 6. Refunds — the full picture

| Claim at moment it ends | Refund |
|---|---|
| `active` (original / own_copy / an **activated** backstop), **user-cancels** | **pro-rata** — `hours_refunded × billable_MB × rate_locked × copies`, min 1 hr consumed |
| `dormant` backstop, **user-cancels** | escrow back **minus `BACKSTOP_CANCEL_FEE_PCT`** |
| any claim that reaches `expiry` | **none** — paid time fully consumed |
| any claim ended by **admin takedown/ban** | see §7 (no cancel fee; refund split by role) |

**Why it's clean in v1:**
- **One active funder at a time (the §0 invariant).** The active claim is the
  sole funder of the single physical copy, so pro-rata refunds it for time it
  genuinely didn't use — there is no "two owners, one copy, over-collection"
  case to special-case. *(That case returns only at multi-node, where two owners'
  copy-counts could overlap on shared nodes; deferred with the rest of
  multi-node.)*
- **Backstops are SEQUENTIAL.** Baton-pass, no overlap, no gap: foo pays
  `[start → foo ends]`, bar pays `[foo ends → bar ends]`. The operator collects
  for the storage **exactly once** across the chain.

Every funder therefore has one unambiguous refund path.

---

## 7. Moderation interaction (admin force-actions)

Moderation already exists in the gate (`ban / takedown / unban / audit /
refund_policy = none|prorata`). Force-actions settle through the **same atomic,
status-locked path** as a normal cancel — just triggered by admin. Two distinct
operations:

### CID ban — *content-level kill* (copyright / legal / illegal content)
- Void the **active claim AND the entire dormant backstop queue** for that CID.
- Add the CID to a **persistent banned-CID registry**, checked at `/reserve`,
  `/upload`, **and** backstop-pledge → the content cannot reappear under any
  user, ever. ("Backstop null; no user can host it.")
- Unpin + delete the bytes.

### User ban — *identity-level kill* (the person abuses the service)
- Cancel **all of that user's claims + backstops, everywhere.**
- Then run the **normal §5 lifecycle**: a file they hosted **survives** if
  someone else has a backstop on it (baton-passes to that backstop); it's
  unpinned only if no one else funds it. The content itself is **not** banned.

### Refund split on a forced action
- **Dormant backstoppers → refunded their escrow in full**, with **no cancel
  fee.** They're innocent third parties; the gate ended their pledge, not them.
- **The offending uploader / active host → follows the operator's
  `refund_policy`** (`prorata` = unused time back; `none` = forfeit as penalty).
  Operator discretion per their jurisdiction.
- A **banned user's own** claims/backstops follow that same `refund_policy`
  (forfeit if `none`).

### Honest backstop terms (disclosure)
The backstop promise is *"your funding keeps the file alive — **except** if it's
taken down for legal/copyright reasons."* Surface this where backstops are
pledged. Takedown deliberately breaks "alive while funded," so the promise must
not be overstated; the full-refund-to-backstoppers rule above is the honest
compensation.

---

## 8. Extend / top-up (in v1)

A live host can pay more at any time to push their **own** `expiry_ts` out — the
normal way to keep a copy alive past its first paid window.

- Added hours bill at the claim's **`rate_locked`** (the rate captured at first
  purchase), so the host's cost never moves under them. *(Sub-decision: an
  extend uses the original rate even if the operator's rate later rose. Simplest
  for v1; revisit only if gamed.)*
- Extending just raises `paid_hours` and pushes `expiry_ts` — no new claim, no
  new record.
- **Backstop interaction:** extending delays the moment the last active claim
  ends, so it delays backstop activation. The backstop simply waits (dormant,
  escrow held) longer. No conflict.
- **Refund interaction:** nothing special — pro-rata already refunds *all*
  unused hours, extended ones included.

---

## 9. What each option buys the second party (decision table)

| | Own copy | Backstop |
|---|---|---|
| When you pay | now, from the start | prepay into escrow now; consumed only if/when it activates |
| Adds a physical copy? | yes (needs a free node) | no (funds the existing copy) |
| Available on a 1-node v1 gate? | **no** (no free node) | **yes** |
| Protects against | the host cancelling **and** a node dying | the file being deleted (last host ending) |
| Usually cheaper? | no | yes — often refunded in full if never needed |

Choose by the worry: **true independent redundancy** → own copy (multi-node
only). **Just don't let the file vanish if the host bails** → backstop. (On v1,
backstop is the only co-host option.)

### What bar sees when uploading an already-hosted CID
Show bar the live stats — *funded through `<date>`, size, current copies,
backstop queue depth + total pledged duration* — then offer **add an extra copy
(only if a free node exists)** and/or **place a backstop**. On a single-node
gate, only the backstop option appears. (Testing-stage: backstop queue is
**fully public** — identities + amounts — for debug visibility; revisit privacy
before any real use.)

---

## 10. v0.3 vocabulary clash — resolved

- **v0.3 (archived):** *one* claim, a no-refund **toll** (cancel just stops the
  timer, no money back); prepaid-balance + packages + token discount machinery.
- **Current (v1):** *one active claim at a time* with **pro-rata** refund,
  **plus** a FIFO queue of **sequential backstops** that are **escrow-refundable
  while dormant** (minus a small cancel fee) and pro-rata once activated; admin
  force-actions refund innocents and follow `refund_policy` for offenders.

The v0.3 no-refund toll is **retired**. Refunds are per-claim by state, per §6/§7.

---

## 11. Decisions locked (v1)

- **Co-hosting on a single-node gate:** **backstop only.** §9-style parallel
  multi-owner (two active claims on one shared copy) is **dropped for v1**,
  deferred to multi-node.
- **Backstop funding:** **prepaid into gate escrow** at pledge; consumed only on
  activation.
- **Backstop activation order:** **FIFO** by pledge time.
- **Backstop dormant cancel:** full escrow back **minus `BACKSTOP_CANCEL_FEE_PCT`**
  (default `1`%, admin env). Fee applies to **user-initiated dormant cancels
  only**.
- **copies cap:** at the **live** `node_count` (config in v1, cluster
  peer-count later).
- **Extend / top-up:** **in v1.** Added hours at original `rate_locked`,
  refundable pro-rata.
- **Refund-on-cancel:** active → pro-rata (min 1 hr); dormant → escrow minus
  fee; expiry → none.
- **Moderation:** CID ban = content kill + permanent registry + void queue;
  user ban = identity kill + baton-pass survival. Forced actions: no cancel fee;
  backstoppers refunded in full; offender per `refund_policy`.
- **Transparency:** backstop queue fully public during testing (debug > privacy
  for now; revisit before real use).

---

## 12. Proposed config knobs (additive; all greenfield)

```
# Replication
NODE_COUNT                = 1        # v1: config (single Kubo node). Multi-node: live cluster peer-count.
REPLICATION_LEEWAY        = 2        # min = max - leeway (Cluster only)

# Backstop / refund
BACKSTOP_CANCEL_FEE_PCT   = 1        # dormant-cancel fee (anti-churn). 0 = off. Not charged on admin-forced voids.
MIN_REFUND                = 0.05     # below this, don't auto-refund (dust / RC drain)

# Moderation (already exists)
REFUND_POLICY             = prorata  # none | prorata — applies to the OFFENDER on a forced takedown/ban
```

(Pricing knobs — `PRICE_RATE_PER_MB_HOUR`, `PRICE_MIN_HOURS`, `MB_DIVISOR` —
live in [PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md) §10.)

---

## 13. One-line summary

**Each CID has at most one active funder + a FIFO queue of prepaid-escrow
backstops; when the active funder's timer ends, the next backstop takes the
baton (the file lives while anyone funds it); refunds are pro-rata for active
claims and full-minus-a-small-fee for dormant backstops; copies are capped at
the live node count (backstop-only on a single-node gate); and admin takedown
(CID ban = kill for everyone; user ban = kill that user, file survives via
others' backstops) refunds innocent backstoppers in full and the offender per
`refund_policy`.**

*Written 2026-06-14. Build target: Stage 1b. Resolve nothing else before coding —
the open decisions are all locked above.*
