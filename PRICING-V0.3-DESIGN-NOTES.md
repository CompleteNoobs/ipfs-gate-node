# ipfs-gate v0.3 — Pricing model design notes (two-part tariff + prepaid balance + token discount)

> Design note only — NO code yet. Captures the pricing model worked out
> with noob across a "just talk" thread (2026-06-02 → 2026-06-03).
> Companion to `MP3-SUPPORT-OPTIONS.md`. Audience: the gate session that
> implements v0.3, and noob for review/testing.
>
> **Sequencing:** this lands in **v0.3, AFTER MP3 ships and tests
> correctly** (MP3 needs zero gate change — see MP3-SUPPORT-OPTIONS.md).
> Do not start this until MP3 is verified in production.
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

1. **Size distribution** of real uploads — confirms whether the size term
   ever wakes up in practice or files stay tiny.
2. **Package mix** — do users pick short or long TTLs? Informs the
   sub-linear time discount (if everyone picks 1-month, the rate may be
   too generous).
3. **Top-up sizes + balance behavior** — do users conserve or burn? Reads
   willingness-to-pay without asking (the prepaid-balance advantage).
4. **Discount uptake** — how many stake the token, how much, does it move
   the token's market price (the layer-2 signal).
5. **Refund requests** — frequency + size; validates the unspent-only rule.

Treat all early numbers as **directional, first data point, expect to
revise** — small N of friendly testers is not a representative market.

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

*Captured 2026-06-03. No code written. Implement after MP3 verifies in
production.*