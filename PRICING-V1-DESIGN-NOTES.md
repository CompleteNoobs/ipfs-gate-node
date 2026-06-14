# ipfs-gate — Pricing model design notes (v1: claim-based, MB-hour)

> ⚠️ **Proof of concept — not for real use.** ipfs-gate (with sister projects
> v4call and nGate) is a concept design build by independent builders. The
> numbers below are **placeholders to be tuned from real data**, not a live
> tariff. Don't treat any rate here as a price you can rely on.
>
> **Status: DESIGN LOCKED — all Stage-1 open decisions resolved (2026-06-14).**
> This is the pricing model for the **Private Encrypted Hosting v1** build
> described in `v4call-ipfs-gate-build-handover.md` (the build handover is the
> source of truth for the wider feature; this file is its standalone
> pricing/claim spec). The backstop/escrow/refund/moderation mechanics it
> references are pinned down in
> [ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md).
>
> **This supersedes** the archived `Archive.PRICING-V0.3-DESIGN-NOTES.md`
> (the two-part-tariff + prepaid-balance + token-discount design). That model
> was never built (pricing code was never written — the gate still charges a
> flat per-upload fee in code today). "v1" here means *Private Encrypted
> Hosting v1*, a different and simpler design generation — **not** a regression
> from "v0.3". See §11 for exactly what changed and which V0.3 ideas are kept
> as optional later layers.
>
> **Audience:** noob (learning) + dev (implementing). Plain-language first,
> precise formula second, in each section.

---

## 0. The one principle that shapes everything

**v1 is the simplest case of v2.** One gate, one owner, one copy is just
federation with the numbers set to 1. Build the **general shapes** now (claim,
order, copies, rate-locked) and fill them with trivial local values. v2
(cross-operator federation) then bolts on instead of forcing a rewrite. Every
field below that looks like overkill for a single gate is a v2 seam shipping
with its degenerate v1 value.

---

## 1. The billable unit is a *claim*, not a file

**Plain language:** when foo pays to host a file, what they're really buying is
a *promise to keep one file pinned for a chosen length of time*. We call that
promise a **claim**. The money, the timer, and the refund all attach to the
claim — not to the file and not to the user's account.

**Two concepts, modelled separately even though they're 1:1 in v1:**

- **Order** — a user's *intent*: "keep this CID alive for me." In v1, 1 order =
  1 claim. In v2, 1 order fans out into N claims across N gates.
- **Claim** — one `(cid, host)` hosting record with its own timer (`expiry_ts`),
  its own locked rate (`rate_locked`), and its own refund. In v1 the host is
  always "self" (this gate).

> **Why separate them now?** So v2 (an order spanning several gates) is an
> additive change, not a schema rewrite. Do **not** collapse order and claim
> into one row.

---

## 2. The pricing formula (v1)

**Plain language:** price = how big × how long × how many copies, times a rate.
Small files round up to 1 MB; short durations round up to 1 hour. That's it —
one multiplication.

```
rate         = 1                              # coins per MB per hour (TEST placeholder; tunable)
billable_MB  = ceil(size_MB)                  # size_MB = bytes / 1,000,000  (decimal MB — see §9)
billable_hrs = max(ceil(hours_requested), 1)  # 1-hour minimum
copies       = claim.copies_requested         # v1 effectively 1 (see §4)

total_cost   = billable_MB * billable_hrs * rate * copies
```

Two ideas only — **size × time** (a storage rate) and a **copies multiplier**
(a redundancy dial). Everything else falls out of these.

### Worked examples (rate = 1, copies = 1)

| File    | Duration | Copies | Cost |
|---------|----------|--------|------|
| 5 MB    | 1 hr     | 1      | 5    |
| 5 MB    | 3 hr     | 1      | 15   |
| 10.3 MB | 1 hr     | 1      | 11   |  (10.3 → ceil → 11 MB)
| 100 MB  | 24 hr    | 1      | 2,400|

> **The numbers are large because `rate = 1` is a TEST placeholder.** TEST is a
> valueless test token (minted for dev). The *shape* is what matters here, not
> the magnitude — tune `rate` once there's data and a real currency (§9, §10).

---

## 3. Refund on cancel — RESOLVED (v1)

**Plain language:** what you get back depends on the claim's *kind and state* at
the moment it ends. A live claim refunds the unused hours; a never-activated
backstop refunds its escrow (minus a tiny fee); a claim that runs to expiry
refunds nothing. The full lifecycle + the moderation cases live in
[ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md); this is the
pricing summary.

| Claim at moment it ends | Refund |
|---|---|
| **active** (original / own_copy / activated backstop), **user-cancels** | **pro-rata** unused hours (formula below), min 1 hr consumed |
| **dormant backstop**, **user-cancels** | escrow back **minus `BACKSTOP_CANCEL_FEE_PCT`** (default 1%, admin env; anti-churn) |
| any claim that reaches **expiry** | **none** — paid time fully consumed |
| any claim ended by **admin takedown/ban** | no cancel fee; backstoppers refunded in full; offender per `refund_policy` (cohosting doc §7) |

```
# active-claim pro-rata
hours_used     = max(ceil((now - start_ts) / 1hr), 1)   # min 1 hr consumed
hours_refunded = max(paid_hours - hours_used, 0)
refund         = hours_refunded * billable_MB * rate_locked * copies
```

- **Rate is locked at purchase** (`rate_locked`). A later operator rate change
  never retro-bills or retro-refunds an existing claim — including **extend /
  top-up** hours, which bill at the original `rate_locked` and refund pro-rata
  like any other hour. (Extend/top-up is **in v1**.)
- The paid timer is always the **backstop**: a payer can cancel their own claim
  anytime; if they never do, it expires.

> **Why the old pro-rata-vs-dedup tension is gone (not just chosen).** The v1
> invariant is **one active claim per CID at a time + a FIFO queue of dormant
> backstops** (a second party on a single-node gate can only *backstop*, not
> co-own — see §5 and the cohosting doc §0). So the active claim is always the
> sole funder of the bytes it pays for → pro-rata is always clean, no
> over-collection case to special-case. The archived V0.3 objection only applied
> to *parallel co-ownership of one shared copy*, which v1 doesn't have; that
> (and its accounting) is **deferred to multi-node**. The V0.3 no-refund toll is
> **retired**.

---

## 4. Replication & the copies multiplier (capped at `node_count`)

**Plain language:** you can ask for more than one copy for durability. Today the
gate runs one storage node, so the only choice is 1 — but the price math and the
selector already understand 2/3/4/5, so the day a second node is added nothing
needs rewriting.

- Offer a copies selector `1 .. node_count`. With `node_count = 1` the UI offers
  only **1**; the code path is already general.
- `total_cost` multiplies by `copies` (§2). Refund (§3) multiplies by `copies`
  too — they must use the same `copies` value stored on the claim.
- Mapping to IPFS Cluster (when `node_count > 1`, deferred infra): `copies` →
  `replication_factor_max`; `replication_factor_min = max − leeway` (e.g. 5/3)
  so a brief peer blip doesn't trigger a repin storm; **`disable_repinning =
  false`** or self-heal never runs. Do **not** hand-roll replication —
  `replication_factor` *is* the min-N-copies self-heal algorithm.
- **Honest caveat to surface to users:** N copies only buy real safety if the N
  nodes sit on **independent failure domains**. The dashboard promise is only as
  strong as how peers are spread across hosts/regions.

> See `IPFS-Gate-Scale-Plan.md` for how `node_count` rises above 1 (Kubernetes
> is the chosen scale path for the concept build).

---

## 5. A second party on an already-hosted CID (v1: backstop, not co-own)

**Plain language:** if someone uploads a CID foo is already hosting, v1 does
**not** let them place a second *parallel* paying claim on foo's single copy.
Instead they either add a **real extra copy** (needs a free node → not available
on a single-node v1 gate) or place a **backstop** (a prepaid, dormant safety-net
that takes over only if foo stops). So on a one-node gate the only co-host
option is the backstop. Full model:
[ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md).

- **v1 invariant:** at most **one active claim per CID** at a time + a **FIFO
  queue of dormant backstops**. The file stays pinned while any active claim
  **or** any dormant backstop exists; when the active claim ends, the next
  backstop takes the baton; unpin only when neither remains.
- **On upload of an already-hosted CID:** show the live stats ("funded through
  `<date>`, size, copies, N backstops queued") and offer extra-copy (if a free
  node exists) and/or backstop.
- **Billing consequence:** because there's only ever one active funder of the
  bytes, **pro-rata refunds are always clean** — no over-collection case (that's
  what dissolved the old §3 tension). The handover §9 "two owners share one
  physical copy in parallel" model is **deferred to multi-node**, where copy
  counts could overlap across owners and the accounting gets real.

---

## 6. Data model fields that pricing depends on

(Full schema lives in the build handover §6 — these are the pricing-relevant
columns.)

```
ORDER
  order_id, cid, owner
  placement_policy   # v1 only: { mode:"count", target:1 }  (v2 adds "pinned" + gate list)
  release_policy     # { type:"owner_only"|"any_of"|"all_of", addresses:[...] }  (see handover §12)
  created_ts, status

CLAIM   (1 per order in v1)
  claim_id, order_id, cid
  host_gate          # v1: "self"
  size_MB            # ceil-MB used for billing (store the measured bytes too if useful)
  rate_locked        # rate captured at purchase — never retro-billed (§3)
  paid_hours         # hours bought (drives refund math)
  copies_requested   # ≤ node_count (§4)
  start_ts, expiry_ts
  status             # active | cancelled | expired
```

- `rate_locked` + `paid_hours` + `size_MB` + `copies_requested` are the four
  numbers the refund formula reads. Persist them on the claim at purchase.
- `expiry_ts = start_ts + paid_hours·1hr`. The expiry sweep (Stage 1) is the
  authoritative timer; refund-on-cancel is the early exit.

---

## 7. Currency, precision floor, and the TEST placeholder

- **v1 prices in TEST at face value** (1:1 with the formula's coin units). TEST
  isn't trading, so there's nothing to convert — skip the HBD→token market
  conversion entirely for now. (This matches the V0.3 "lean rollout" note: get
  data flowing before building the conversion layer.)
- **Precision floor — reuse the v4call lesson.** v4call uses `RATE_FLOOR =
  0.001` and rounds disbursement with `.toFixed(3)`; rates below the floor are
  treated as free, and the picker must agree with the validator or funds get
  stuck. When real-currency pricing lands, carry the same discipline here:
  whatever the gate quotes, the gate must be able to actually charge/refund at
  that precision (no sub-floor amounts that round to 0).
- **Real-currency pricing (HBD-equivalent + market conversion) is deferred** —
  it's the single biggest idea carried over from V0.3 (§11). Revisit when the
  discount/economics experiment needs a real unit.

---

## 8. Packages as a UX layer (optional, on top of hours)

The billing unit is **hours** (`hours_requested`). A friendly UI can still offer
a small menu of fixed durations (e.g. **1 day / 1 week / 1 month**) that just
supply `hours_requested` to the formula — the gate computes the live price from
the file's size. This is a presentation choice, not separate math; add it if the
raw "enter hours" field feels clumsy in testing. (Packages were the V0.3 UX; the
formula here is finer-grained, so packages become a convenience, not the unit.)

---

## 9. What to measure (the point of shipping a placeholder rate)

Log per claim from day one (cheap now, painful to backfill):
`size_bytes`, `kind` (jpeg/mp3/mp4/pdf/…), `hours_requested`, `copies`,
`rate_locked`, `price_charged`, `owner`, `is_public` (encrypted vs public-link),
`created_ts`. For **public** CIDs also track **fetch count + egress bytes** over
time.

- **Public uploads add an egress axis the storage formula doesn't price.** A
  popular public 50 MB link can cost more in bandwidth than a hundred private
  attachments. Don't pre-price it — *measure*, then decide (higher rate for
  `is_public`, a per-file bandwidth cap, or a shorter default TTL for public
  files). The gate already ships `mode: public|encrypted`, so carry the flag
  through pricing + logs.
- **Willingness-to-pay from free testers:** a tester spending valueless TEST
  reveals UX, not WTP. Hand each tester a *fixed* TEST allowance and watch
  conserve-vs-burn — conserving = "feels expensive," burning = "feels cheap."
- Treat all early numbers as **directional, first data point, expect to revise.**
  A small friendly pool proves the *mechanism* and catches wildly-off pricing;
  it does not derive a market rate.

---

## 10. Proposed config knobs

```
# Core pricing
PRICE_RATE_PER_MB_HOUR   = 1        # coins per MB per hour (TEST placeholder)
PRICE_MIN_HOURS          = 1        # 1-hour minimum (billable_hrs floor)
MB_DIVISOR               = 1000000  # decimal MB (bytes / 1e6) — confirmed

# Replication
NODE_COUNT               = 1        # caps the copies selector (1..NODE_COUNT). v1: config (1 Kubo node).
                                    # Multi-node: a LIVE read of healthy cluster peers at quote time.
REPLICATION_LEEWAY       = 2        # min = max - leeway (e.g. copies 5 → min 3) — Cluster only

# Refund / backstop
MIN_REFUND               = 0.05     # below this, don't auto-refund (dust / RC drain)
BACKSTOP_CANCEL_FEE_PCT  = 1        # dormant-backstop cancel fee (anti-churn). 0 = off. Not on admin-forced voids.
REFUND_POLICY            = prorata  # none | prorata — the OFFENDER's refund on an admin takedown/ban (moderation, exists)
```

All additive; nothing here exists in code yet (greenfield — Stage 1a/1b). The
backstop/escrow/refund mechanics live in
[ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md).

---

## 11. What changed from the archived V0.3 model

| Dimension | Archived V0.3 (two-part tariff) | v1 (claim-based, this doc) |
|---|---|---|
| Granularity | GB **per day** | MB **per hour** (finer; rounds up) |
| Shape | flat **access fee** + storage rate | pure **size × time × copies** (no separate access fee) |
| Anti-spam floor | the flat access fee | the 1 MB × 1 hr minimum (a small implicit floor) |
| Payment UX | **prepaid balance** (one top-up, many uploads) | per-order on-chain pay → escrow → pin |
| Refund | **no pro-rata** (committed toll) | **pro-rata** for active claims; **full-minus-fee** for dormant backstops (§3) |
| Co-hosting | not modelled | **backstop** safety-net (prepaid escrow, FIFO baton-pass), §5 + cohosting doc |
| Duration | fixed **packages** (1d/7d/30d) | continuous **hours** (packages optional UX, §8); **extend/top-up in v1** |
| Redundancy | not modelled | **copies** dial, capped at **live** `node_count` |
| Multi-gate | not modelled | **order/claim** split = v2 federation seam |

**V0.3 ideas kept as optional *later* layers (not in v1):**
- **Prepaid stored-value balance** — the real friction-killer at scale (no
  Keychain pop / 3s settle per file). Deferred until per-file friction actually
  bites; carries a custodial-float responsibility (durable ledger, refund
  policy) so it's worth deferring until volume justifies it.
- **Token-staking discount** (up to 33% off, owned-staked only, floor
  preserved) — reintroduce alongside real-currency pricing (§7) and a real
  discount token.
- **Credit gifting / sponsor allowance** — depends on the prepaid balance
  existing first.
- **HBD-equivalent pricing + market conversion** — the unit upgrade for when
  TEST has value.

> If/when these come back, they layer **on top of** the claim model — the claim
> is the billing primitive either way (a prepaid balance just changes *how the
> claim is paid for*, not what a claim is).

---

## 12. Out of scope for v1 (deferred)

- **v2 cross-operator settlement** — money moving between gates; the whole
  reason federation exists. (Handover §15.)
- **Parallel co-ownership of one shared physical copy** (handover §9) + its
  multi-node copy-count accounting — deferred to multi-node (v1 uses the
  backstop queue instead, §5).
- **Per-category / size-tier rates** beyond the single per-MB-hour rate.
- **Congestion / disk-utilization auto-pricing** — add only if disk pressure
  becomes real.
- **Egress-based pricing for public files** — measure first (§9), price only if
  data shows it matters.
- Everything in §11's "optional later layers" (prepaid balance, discount,
  gifting, real-currency conversion).

---

## 13. One-line summary

**Each upload places a *claim* — one `(cid, host)` record priced by
`ceil(MB) × max(ceil(hours),1) × rate × copies` (decimal MB) — with the rate
locked at purchase, extend/top-up in v1, pro-rata refund for the single active
claim and full-minus-fee refund for dormant backstops, a FIFO backstop queue
that keeps the file alive while anyone funds it, and a copies dial capped at the
live `node_count` (backstop-only on a single-node gate) that already speaks the
language of v2 multi-gate federation.**

*Written 2026-06-14. Source: `v4call-ipfs-gate-build-handover.md` §6–§9, with the
refund/backstop/moderation model resolved in
[ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md). Supersedes
`Archive.PRICING-V0.3-DESIGN-NOTES.md`. No pricing code written yet (greenfield —
build at Stage 1a/1b). All Stage-1 open decisions are now resolved; MB unit
confirmed decimal (`bytes / 1,000,000`).*
