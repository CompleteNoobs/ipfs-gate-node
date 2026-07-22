# ipfs-gate v0.3 — Pricing model design notes (two-part tariff + prepaid balance + token discount)

> **Status: DESIGN LOCKED — pricing rollout is the current task
> (2026-06-04).** Captures the pricing model worked out with noob across a
> "just talk" thread (2026-06-02 → 2026-06-04). Companion to
> `MP3-SUPPORT-OPTIONS.md`.
>
> **Multi-format attachments are DONE and working** (uncommitted build
> from another thread): MP3, MP4, PDF, tar, text — encrypted over WSS
> (not Nostr yet) — **plus public unencrypted upload-and-share-by-link.**
> The remaining piece is **pricing**: replace the flat "1 TEST per
> upload" with the two-part tariff and gather data on a small test pool.
>
> **Sequencing (updated):** start with **§12.5 — the lean rollout
> (dynamic per-upload pricing FIRST, prepaid ledger LATER)**, not the full
> §12 build. For a small test pool, the formula on the existing per-upload
> flow gets data flowing with a fraction of the build. The prepaid balance
> is a friction-killer for scale, deferred until the rate is validated.
>
> **Public uploads changed one assumption — see §2b (egress).** Every
> number here assumed encrypted, low-fan-out files; public link-sharing
> can be high-fan-out, which introduces a bandwidth cost the storage-only
> formula doesn't price. Measure before pricing it.
>
> **Purpose:** noob learns by seeing it applied + tested. This model is
> deliberately simple so it can be deployed, used, and measured — the
> numbers below are *starting guesses to be tuned from real data*, not
> final values.

---

## 1. The decision: two-part tariff, delivered as a prepaid balance

After working through flat-fee, cost-plus, congestion, endowment, and
auction models, the fit for a **fixed-cost hobby operator** (server +
time are the real cost; one more file ≈ free) is a **two-part tariff**
(Oi 1971, the "Disneyland dilemma" model — optimal when fixed costs are
high and marginal cost is ~zero).

It is delivered through a **prepaid stored-value balance** so that **one
on-chain top-up funds many uploads** — no Keychain pop and no ~3s
sidechain settle *per file* (the current v0.1.x flow's biggest friction).

```
Total per upload =  [ flat access fee ]  +  [ rate × size_GB × ttl_days ]
                      Part 1: anti-spam        Part 2: storage (size × time)
```

Two tunable knobs only. Everything else falls out of these two numbers.

---

## 2. The formula, with starting numbers

Starting guesses (HBD-equivalent; tune from data):

- **Part 1 — access fee:** `0.02 HBD` per upload (flat, any file). This
  is the anti-spam floor.
- **Part 2 — storage rate:** `0.02 HBD per GB per day`.
  - Sanity check: `0.02 × 30 = 0.6 HBD/GB-month ≈ $0.60/GB-month` —
    roughly 4× Pinata's ~$0.15/GB-month IPFS-pinning rate. Sane margin
    for a small operator. (Contrast: the earlier `0.0024 HBD/MB-day`
    guess was ~$73/GB-month — ~12,000× raw cost — a UX anchor, NOT a
    real storage rate. Do not use it for big files.)

**The computation is one multiplication.** The gate already has both
inputs: `size_bytes` (measured at `/reserve` and `/upload`) and
`ttl_days` (from the chosen package). `size_GB = size_bytes / 2^30`.

### Worked example — a 900MB Linux distro (size term is "awake")

900MB ≈ 0.9 GB.

| Package | Part 1 | Part 2 (0.02 × 0.9 × days) | **Total** |
|---|---|---|---|
| 1 day  | 0.02 | 0.018 | **0.038 HBD** |
| 1 week | 0.02 | 0.126 | **0.146 HBD** |
| 1 month| 0.02 | 0.540 | **0.56 HBD** |

### Worked example — a 2MB chat photo (size term is "dormant")

2MB ≈ 0.002 GB, 1 week:
`0.02 + (0.02 × 0.002 × 7) = 0.02 + 0.00028 ≈ 0.020 HBD` — **all access
fee; size invisible.**

**Same formula, two behaviors.** Small files ≈ the flat floor (size ~0).
Big files → the storage term takes over. The two-part tariff
auto-adjusts from a 2MB photo to a 900MB distro with one rule. This is
*why* size can be ignored for chat attachments but matters for large
uploads — the formula handles both.

---

## 2b. Public uploads change the cost model — the egress axis

**New as of 2026-06-04:** the gate now also serves **public, unencrypted
upload-and-share-by-link** files, alongside the encrypted WSS attachments.
This breaks an assumption baked into every number above.

The formula prices **storage** (`bytes × days`) and ignores bandwidth —
which was correct for **encrypted, low-fan-out** files (a DM attachment
goes to one or two recipients, fetched a couple of times; egress is
negligible). **Public link-sharing can be high-fan-out:** anyone with the
link can fetch repeatedly. One popular public 50MB file can cost more in
**egress** than a hundred private attachments — a cost the storage-only
formula doesn't see.

**Do not pre-price this — measure it first.** At test-pool scale egress
may stay trivial. The discipline:
- **Track per public CID:** fetch count + egress bytes over time (see §9).
- **Decide only when data shows it matters.** Options then: a higher rate
  for `is_public` uploads, a per-file bandwidth cap, or a shorter default
  TTL for public files. Pick from evidence, not fear.
- **Moderation note:** public files are more *reachable* than encrypted
  blobs (illegal content shareable by link). The existing
  ban/takedown/blocklist already covers this — no new mechanism needed,
  just awareness that the public link widens the surface.

Carry an `is_public` flag through pricing + logging so the two cost
models (private storage-bound vs public egress-bound) can be analysed
separately.

---

## 3. Packages = the UX layer (not separate math)

Users never see the formula. They see a small menu of **fixed-duration
packages**: `1 day / 1 week / 1 month`. The package supplies `ttl_days`;
the gate computes the price live from the formula using the file's size.

- No continuous-math UX, no fractional-precision dust in the prices the
  user reasons about (they pick a duration; the gate does the multiply).
- Easy to extend later (3-month, 1-year) by adding a row.
- **One axis for v0.3: time.** Do NOT add a small/large *size tier* axis
  yet — size already enters via Part 2. One variable at a time.

---

## 4. Prepaid balance mechanics

- **Top-up:** user sends `PAYMENT_CURRENCY` to `IPFS_GATE_HIVE_ACCOUNT`
  with a memo identifying it as a balance top-up (e.g.
  `ipfs-gate:topup:<account>` or just the username). Verified on-chain
  the same way uploads are today (tx_id UNIQUE = replay protection,
  sidechain confirm). Credits an internal HBD-equivalent balance.
- **Upload:** user picks a package → gate computes price → **debits the
  balance** (synchronous SQLite transaction = atomic, no double-spend;
  same pattern as v4call's `refundPaidInvite` gate). No per-file on-chain
  tx, no Keychain pop, no settle-wait.
- **Insufficient balance:** clean `402`-style rejection ("top up X more")
  *before* any pin work.
- **Minimum top-up:** enforce a floor (e.g. `≥ 1 HBD-equiv`) so you're
  not processing dust transfers / dust float.

**Custodial tradeoff (go in eyes-open):** a prepaid balance means you
hold users' funds as an off-chain IOU. That requires (a) a durable,
backed-up balance ledger — it's real money you owe; (b) a refund policy
(below); (c) awareness of the "float" liability (gift-card model — a perk
as working capital, but you must honor it). Keep float modest, be
transparent.

---

## 5. Refund policy

- **Unspent balance → fully refundable, exact, on request.** Just
  transfer the remaining ledger number back on-chain. NOT pro-rata —
  there's nothing to pro-rate, it's untouched credit. This is the
  trust-builder; offer it.
- **Already-spent-on-a-package → non-refundable.** The "used stamp" rule:
  buying a 1-week package is a deliberate commitment. **Do NOT pro-rata
  consumed storage**, because:
  1. The price is a flat-ish toll + storage commitment, not a per-day
     meter you can cleanly unwind.
  2. Dedup: multiple pin records can share one CID (your schema allows
     this). Unpinning one user's record frees no bytes if another pin
     holds the CID — you'd refund cost you didn't save.
  3. You'd be refunding service still being rendered.
  Plus pro-rata re-introduces precision-dust + extra refund-tx RC cost.
- True pro-rata only makes sense in the **time-metered room-pool model**
  (v4call v0.22+ roadmap), where billing *is* per-unit-time. Not here.
- **Refund hygiene:** minimum refund threshold (avoid dust + RC drain),
  status-locked + atomic (no double-refund), watch token precision floor.

---

## 6. Token-holder discount (staking-based)

Reward users who **stake** a configured token with a standing discount on
their bill.

### Rules
- **Stake, not liquid hold** (production). Liquid holding is gameable
  (buy → upload → sell). Staking's unstake-cooldown defeats flash-holding.
  Snapshot the **owned staked** amount at upload time. **For early
  testing**, a liquid-hold option is allowed via
  `DISCOUNT_REQUIRE_STAKED=false` (simpler; accepts the gaming risk while
  gathering data). Flip to `true` for production. Keep it a config toggle
  so any use case we can see now is reachable.
- **Owned, not delegated-in.** Mirror v4call's `LOBBY_POST_MIN_HP` rule:
  exclude delegated stake so privilege can't be rented. (Testing uses
  staked HIVE / Hive Power as the stand-in until a custom staking token
  is minted; the production token is TBD — `TEST` is a placeholder.)
- **Linear, capped:**
  `discount% = min(MAX_DISCOUNT_PCT, staked_amount × PCT_PER_TOKEN)`.
  Defaults: `PCT_PER_TOKEN = 1`, `MAX_DISCOUNT_PCT = 33`.
  - 1 token → 1%, 33 → 33%, 100 → still 33% (capped). Matches noob's spec.
- **`PCT_PER_TOKEN` is the load-bearing knob, not the cap.** At
  1-token-per-1%, reaching 33% costs 33 tokens *once*, for a *permanent*
  discount. Whether that's cheap or expensive depends entirely on the
  token's market value. Keep it an admin env var and tune it against the
  token's price (the layer-2 market-discovery experiment).

### Where the discount applies (important)
Discount bites **Part 2 (storage)**, with a **hard floor at Part 1 (the
access fee)** the discount can never go below:

```
raw        = access_fee + rate × GB × days
discount%  = min(MAX_DISCOUNT_PCT, staked × PCT_PER_TOKEN)
discounted = raw × (1 − discount%/100)
total      = max(access_fee, discounted)     ← anti-spam floor preserved
```

Consequence: max-discount holders still pay the spam toll; the perk
rewards **real storage** (big/long files), not chat spam. Chat-photo
users at the floor see no discount — by design.

### Worked example (900MB, 1 week, raw = 0.146 HBD)
- 10 staked → 10% → `0.146 × 0.90 = 0.131 HBD`
- 33 staked → 33% → `0.146 × 0.67 = 0.098 HBD`
- 100 staked → 33% (cap) → `0.098 HBD`

### The synergy worth naming
Giving the token a concrete *use* (a standing discount) creates organic
demand to acquire + stake it → supports its market price → which is
exactly what the "spread TEST on the exchange and watch" experiment was
trying to discover. **The discount mechanism and the token-value
experiment reinforce each other.**

### Cost note
Stake lookup = one Hive / Hive-Engine API call per upload; cache it
(v4call caches account stats ~5 min — reuse that pattern). Negligible.

---

## 6b. Credit sharing — gift + sponsor allowance

Because credit lives as an internal balance, sharing it is a ledger
operation — **no on-chain transaction, instant, near-free**. Two distinct
shapes; offer both (they cover different use cases).

### Gift — foo TRANSFERS credit to bar (ownership moves)
The "bar can't afford credit right now, foo sends some" case.
```
atomic SQLite tx:
  debit  foo.balance  by X
  credit bar.balance  by X
  append balance_ledger: (foo, −X, 'gift_sent', ref=bar)
                         (bar, +X, 'gift_received', ref=foo)
```
- foo signs a Hive request to authorize ("gift X credit to bar") — same
  sig pattern as uploads. No Keychain transfer, no settle-wait.
- Once gifted, it's bar's to spend. Real-world analog: Venmo balance
  transfer / Steam wallet gift.
- `MIN_GIFT_HBD` threshold to avoid dust ledger spam.

### Sponsor allowance — foo AUTHORIZES bar to spend foo's credit
The "let bar use mine / assign some over, but I keep control" case. foo
stays the payer.
```
new allowances table:
  sponsor, beneficiary, limit_hbd, spent_hbd, status, created_at
→ bar's uploads debit FOO's balance, counted against the allowance
→ foo can revoke the unused remainder anytime (spent stays spent)
```
- Real-world analog: an authorized user on a credit card / AWS
  consolidated billing (one payer covers many users). Good for an
  admin/org sponsoring members, or ongoing patronage.
- **Soft vs hard allowance:**
  - *Soft (cap only):* "up to X *if foo has it*" — checked against foo's
    live balance at spend time. Simple, but foo could spend it all first
    and hollow the allowance.
  - *Hard (reserved):* granting X immediately moves X into a reserved
    bucket so foo can't double-spend it — guarantees bar can use it.
    More bookkeeping (internal escrow).
  - **v0.3 testing: soft.** Hard is the later upgrade.
- Precedence at bar's upload: draw on bar's own balance first, then a
  named sponsor allowance (or let bar pick). Define one rule, keep it
  simple.

### Policy call — gifted/sponsored credit is SPEND-ONLY (non-refundable)
Only a user's **own topped-up** balance refunds to their **own** Hive
account. Gifted/sponsored credit can be spent but not cashed out. This
stops the gate becoming a value-transfer/cash-out rail (foo gifts bar →
bar refunds to bar's wallet = off-chain money movement through the
service). Tag each ledger credit with its origin (`topup` vs
`gift`/`sponsor`) so the refund path can tell them apart. Minor at hobby
scale, cheap to get right from day one.

---

## 7. Config knobs (proposed env vars)

```
# Two-part tariff
PRICE_ACCESS_FEE_HBD      = 0.02     # Part 1, flat per upload (also the discount floor)
PRICE_STORAGE_HBD_GB_DAY  = 0.02     # Part 2, per GB per day

# Packages (durations offered; price computed from the formula)
PACKAGES_DAYS             = 1,7,30

# Prepaid balance
MIN_TOPUP_HBD             = 1
MIN_REFUND_HBD            = 0.05      # below this, don't auto-refund (dust/RC)

# Token-holder discount
DISCOUNT_TOKEN_SYMBOL     = TEST      # HIVE/HP for testing until a token exists
DISCOUNT_REQUIRE_STAKED   = false     # false = liquid hold OK (testing); true = staked-owned only, exclude delegated-in (production)
DISCOUNT_PCT_PER_TOKEN    = 1
DISCOUNT_MAX_PCT          = 33

# Credit sharing
MIN_GIFT_HBD              = 0.05      # below this, no gift (dust ledger)
ALLOWANCE_MODE            = soft      # soft = cap only (testing); hard = reserved bucket (later)
```

All prices denominated in HBD-equivalent; the user pays in
`PAYMENT_CURRENCY` converted at market rate at top-up time (keeps real
cost predictable; operator absorbs token volatility).

---

## 8. Data model sketch (additive — no rewrite)

- **New `accounts` (or `balances`) table:** `hive_account TEXT PRIMARY
  KEY, balance_hbd REAL, updated_at INTEGER`. Credited by top-ups,
  debited by uploads.
- **New `balance_ledger` table (append-only):** one row per credit/debit
  — `id, hive_account, delta_hbd, kind ('topup'|'upload'|'refund'),
  ref (tx_id or pin_id), created_at`, plus an `origin` tag
  ('topup'|'gift'|'sponsor'). This is the audit trail for the custodial
  balance — non-negotiable since it's real money owed. The `origin` tag
  is what lets the refund path allow own-topup but block gifted/sponsored
  cash-out (§6b policy call). Gift/sponsor moves add ledger kinds
  'gift_sent'|'gift_received'|'sponsor_spend'.
- **New `allowances` table (sponsor model):** `sponsor, beneficiary,
  limit_hbd, spent_hbd, status, created_at`. Soft mode checks foo's live
  balance at spend time; hard mode reserves into a bucket.
- **Existing `payments` table:** keep for top-up on-chain records (tx_id
  UNIQUE still = replay protection). The per-upload flow stops needing a
  tx_id (the debit is internal).
- **Existing `pins` table:** unchanged; `ttl_days` now comes from the
  package, price already debited from balance.

---

## 9. What to test / data to gather (the point of shipping this)

**Log per upload, from day one** (cheap now, painful to backfill):
`size_bytes`, `kind` (mp3/mp4/pdf/tar/text/…), `package`/`ttl_days`,
`price_charged`, `uploader`, `timestamp`, and **`is_public`** (encrypted
vs public-link — so the two cost models are analysable separately, §2b).
For public CIDs also track **fetch count + egress bytes over time** (the
egress axis). At the lean stage (§12.5) this is a simple usage-log table;
once the balance ledger exists (§8) most of it lives there.

**Extracting price signal from free testers — the fixed-allowance
trick.** A tester spending tokens that cost them nothing reveals UX, not
willingness-to-pay. So **give each tester a fixed TEST allowance and watch
conserve-vs-burn:** conserving = "feels expensive," burning = "feels
cheap, can charge more." This is the closest thing to real WTP a small
friendly pool can give — better than asking.

What to watch:
1. **Size distribution** of real uploads — does the size term ever wake up
   in practice (now that MP4/tar can be large), or do files stay tiny?
2. **Package mix** — short or long TTLs? If everyone picks 1-month, the
   rate may be too generous.
3. **Conserve-vs-burn** per tester (the allowance trick above) — the WTP
   read. (Post-prepaid: top-up sizes + balance behavior.)
4. **Public egress reality check** — do public files actually rack up
   bandwidth, or stay trivial? Decides whether §2b ever needs pricing.
5. **Discount uptake** — how many hold/stake the token, how much, does it
   move the token's market price (the layer-2 signal).
6. **Refund requests** — frequency + size; validates the unspent-only rule.

Treat all early numbers as **directional, first data point, expect to
revise** — small N of friendly testers is not a representative market.
The goal of the test pool is to prove the mechanism + catch wildly-off
pricing, NOT to derive a perfect rate. Precision tuning needs real scale.

---

## 10. Deliberately OUT OF SCOPE for v0.3 (deferred)

- **Per-byte/per-category *size tiers*** beyond the single Part-2 rate.
- **Pro-rata refund of consumed storage** (only the time-metered room-pool
  model justifies it — v4call v0.22+).
- **Payment streaming** (Superfluid-style continuous flow) — no native
  Hive primitive; over-engineered for now.
- **Congestion / EIP-1559 disk-utilization auto-pricing** — add only if
  disk pressure becomes real. Nice future upgrade, not v0.3.
- **Hard (reserved) sponsor allowance** — soft (cap-only) for v0.3;
  reserved-bucket escrow is the later upgrade.
- **Cash-out of gifted/sponsored credit** — spend-only by design (§6b).
- **Multi-token discount stacking** — one discount token for v0.3.

---

## 11. One-line summary

**One top-up funds a prepaid balance → each upload spends a fixed-duration
package priced by `access_fee + rate × GB × days` → stakers of the
discount token get up to 33% off the storage part (floor preserved) →
users can gift credit or sponsor each other's uploads (internal ledger,
spend-only) → unspent own-topup balance is refundable; spent packages and
gifted credit are not.** Two tunable price knobs, one multiplication, all
auto-adjusting from a 2MB photo to a 900MB distro.

---

## 12.5 Rollout on the small test pool — the lean path (START HERE)

**For a small test pool, do NOT build the full §12 ledger first.** The
unknown is the *rate*; the prepaid balance is a known, deferrable
convenience. Build the *formula* on top of the **existing per-upload
payment flow** and start gathering data with a fraction of the work.

**Milestone 3a — dynamic per-upload pricing (small build, do this first):**
1. **Pricing function + packages** — `price = access_fee + rate × GB ×
   days`; package → `ttl_days`. (= §12 step 3.)
2. **Make `/reserve`'s amount dynamic** — return the computed price for
   the file's size + chosen package, instead of the flat `PAYMENT_AMOUNT`.
   The existing `reserve → pay → upload` flow is unchanged in shape; only
   the *amount* becomes variable. **No prepaid ledger, no schema change.**
3. **Price in TEST at 1:1** with the HBD-equivalent numbers — skip the
   live HBD→TEST market conversion entirely (TEST isn't trading yet;
   nothing to convert). The conversion layer comes only when TEST has a
   real market price.
4. **Carry `is_public`** through pricing + the usage log (§2b, §9).
5. **Instrument logging** (§9 field list) + **hand each tester a fixed
   TEST allowance** (the conserve-vs-burn WTP read).
6. **Expose the menu on `GET /`** (packages, `access_fee`, `storage_rate`,
   `max_size_mb`) so the v4call picker reads it live. (= §12 step 5.)

Milestone 3a is deployable + measurable on its own. Run it, watch the
data (§9), tune `access_fee` + `rate`, sanity-check public egress.

**Milestone 3b — prepaid balance (the friction-killer), LATER:** build
the full §12 (schema → top-up → balance debit → §6 discount → §6b credit
sharing → §5 refund). Do this once the rate is validated AND per-file
Keychain friction actually bites (more users / higher volume) — at small
scale it's tolerable, so it waits.

**Why this order:** validate the *rate* (the real unknown) before
investing in the *ledger* (deferrable convenience). Less to build → data
sooner → faster learning. §12 below is the full 3b build, kept intact.

---

## 12. Build order / kickoff (gate v0.3 — full prepaid build = Milestone 3b)

> **Read §12.5 first.** For the small test pool, Milestone 3a (lean
> dynamic pricing) comes before this. The steps below are the full
> prepaid build; do them once the rate is validated.

Ordered so each step is testable before the next. Each is a small,
self-contained change — do not batch them.

1. **Schema migration `002`.** Add three tables: `accounts`
   (`hive_account` PK, `balance_hbd`, `updated_at`); `balance_ledger`
   (append-only, with the `origin` tag — §8); `allowances` (sponsor
   model — §6b). Additive only; existing tables untouched. *Test:*
   migration runs clean on a copy of prod DB.
2. **Top-up flow.** Detect an on-chain transfer with a top-up memo →
   credit `accounts.balance_hbd` + ledger row (`kind='topup'`,
   `origin='topup'`). Reuse the existing payment-verify + sidechain-
   confirm path; tx_id UNIQUE still guards replay. *Test:* a real
   top-up lands and shows in the balance.
3. **Pricing function + packages.** `price = access_fee + rate × GB ×
   days` (§2); package → `ttl_days` lookup (§3). Add a `/quote` (or
   extend `/reserve`) that returns the computed price for a given size +
   package. *Test:* the 900MB worked examples in §2 reproduce exactly.
4. **Balance debit at upload.** `/upload` checks balance ≥ price, debits
   atomically (ledger `kind='upload'`), then proceeds to pin. Per-upload
   on-chain tx is no longer required. Insufficient balance → clean
   reject before pin work. *Test:* one top-up funds several uploads, no
   Keychain per file.
5. **Expose on `GET /`.** Add `packages`, `access_fee`, `storage_rate`,
   `max_size_mb` to the `/` payload so v4call's picker reads them live
   (avoids the file-picker going stale). *Test:* `curl /` shows the menu.
6. **Token discount.** Stake/hold lookup (cached ~5 min), apply to the
   storage part with the access-fee floor (§6). `DISCOUNT_REQUIRE_STAKED`
   toggle (default `false` for testing). *Test:* hold N tokens → N% off,
   capped at 33%, floor preserved.
7. **Credit sharing.** Gift endpoint (atomic ledger move, Hive-signed)
   then soft sponsor allowance (§6b). Tag credit `origin` so refunds can
   block gifted cash-out. *Test:* foo gifts bar, bar uploads on it; bar
   cannot refund gifted credit.
8. **Refund endpoint.** Unspent **own-topup** balance only → on-chain
   transfer back; min-threshold + status-lock (§5). *Test:* refund
   returns exact unspent topup; spent packages + gifted credit refused.
9. **Admin views.** Balance + ledger inspection per account; float total.
10. **v4call side** (separate session): package picker UI, balance
    display, top-up flow, then gift/sponsor UI. Reads the menu from
    `GET /` (step 5).

Steps 1–5 are the minimum viable prepaid two-part tariff (deployable +
measurable on their own). 6–10 layer on once the core is proven.

*Captured 2026-06-03; rollout strategy added 2026-06-04. Multi-format +
public upload are DONE (uncommitted, another thread). No pricing code
written yet. **Start with §12.5 Milestone 3a** (lean dynamic pricing on
the existing per-upload flow), not §12 step 1.*