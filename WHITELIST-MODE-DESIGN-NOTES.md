# ipfs-gate — Whitelist / gated-server mode design notes (v1)

> ⚠️ **Proof of concept — not for real use.** ipfs-gate (with sister projects
> v4call and nGate) is a concept design build by independent builders. Not
> production software, not safe to use, not recommended for general users.
>
> **Status: DESIGN LOCKED (2026-07-04) → BUILT Stages A–D the same day →
> LIVE-TESTED end-to-end on `ipfs.v4call.com` (2026-07-05, operator-confirmed).**
> Written per plan `need-help-my-brain-humming-stroustrup.md`. Every open
> decision below was resolved with a concrete default chosen for reversibility
> and least surprise (mirroring how PRICING-V1 and the cohosting/backstop docs
> were locked before their builds started). Two post-lock findings:
> the §4 extend amendment (marked inline), and a ⚠ **known security gap from
> the live pass** — the fee-exempt `/upload` path doesn't verify
> `uploader_pubkey` against the account's real on-chain posting key, so a
> free-tier whitelisted account's name can be uploaded-under with a throwaway
> keypair (paying path unaffected — payment is auth). Not yet hardened; see
> roadmap_status.md "Live golden-path pass" for detail. Build record:
> roadmap_status.md "Whitelist / gated-server mode"; operator recipe:
> `WalkThrough.wiki` "Optional: Private / family hosting (whitelist mode)".
>
> **Reads with:** `PRICING-V1-DESIGN-NOTES.md` (the fee formula this reuses at
> `rate: 0`), `ipfs-gate-cohosting-backstop.md` (the claim/refund model this
> layers on top of), `roadmap_status.md` (where this lands in the build plan).

---

## 0. The one-line pitch

Turn one ipfs-gate deployment into an optional **gated server**: only
whitelisted Hive accounts may use it, a **Hive-account admin** (not just the
box owner's shared `ADMIN_KEY`) can manage the guest list and moderate, guests
can get a **per-account storage quota**, and whitelisted accounts can
optionally be **fee-exempt**. One model, not three — every example in the
original ask is just a different setting of the same table.

```
whitelist-only, free-for-all    →  WHITELIST_MODE=true, every entry fee_exempt=true, no quota_bytes
admin-free + guest quotas       →  admin in SERVER_ADMIN_HIVE_ACCOUNTS (free by construction),
                                     guest entries fee_exempt=true, quota_bytes=10GB
paid-but-still-whitelisted      →  WHITELIST_MODE=true, entries fee_exempt=false (guests still pay
                                     the normal claim-model fee; whitelist just adds a second gate)
```

---

## 1. What's genuinely new here

Nothing in ipfs-gate today has a concept of roles, per-account quota, or a
whitelist. The box owner's `ADMIN_KEY` (a shared Bearer secret, not tied to any
Hive account) is the only privileged tier that exists. This doc adds exactly
one new table and one new admin tier — everything else (moderation actions,
per-account scoping, refund math) reuses machinery that already works.

**The one genuinely new moderation primitive** (everything else below is
reuse): neither `banAccount` (kills the whole account) nor `takedownCid`
(kills a CID for everyone) is "delete this one pin belonging to someone else."
The original ask's Example 2 ("admin can... delete others' pins") confirms
this is wanted, so it's built (§6), not left as an open question.

---

## 2. Data model: `whitelisted_accounts`

**Plain language:** one row per whitelisted Hive account, mirroring how
`banned_accounts` already tracks who/when/why with a soft-delete column. Two
extra knobs beyond the ban-table shape: an optional per-account byte quota,
and a fee-exempt flag.

```sql
CREATE TABLE IF NOT EXISTS whitelisted_accounts (
  hive_account    TEXT PRIMARY KEY,
  added_at        INTEGER NOT NULL,
  added_by        TEXT NOT NULL,       -- 'operator' or 'hive:<account>'
  quota_bytes     INTEGER,             -- NULL = unlimited (shared-disk fallback)
  fee_exempt      INTEGER NOT NULL DEFAULT 0 CHECK (fee_exempt IN (0,1)),
  note            TEXT,
  removed_at      INTEGER,
  removed_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_whitelisted_accounts_active
  ON whitelisted_accounts(hive_account, removed_at);
```

Ships as `migrations/007_whitelist.sql` — a plain `CREATE TABLE`, no
CHECK-constraint rebuild needed (unlike `006_guardian.sql`, which had to
rebuild `claims`; this touches no existing table).

**Resolved decisions on this table:**
1. `quota_bytes` is a **hard cap**, checked in addition to (never overriding)
   the existing global `DISK_LIMIT_BYTES` — a guest's 10GB never overrides
   what the box actually has free. Tightest limit always wins.
2. Quota is enforced only at **entry** (reserve / own-copy), same as the
   existing global disk check — **not** re-verified when a dormant guardian is
   later promoted by `reconcileCidAfterEnd`. This isn't a new gap; the global
   disk cap already isn't re-checked there today. Consistent, not worse.
3. De-whitelisting (`removed_at` set) blocks **new** reservations/pledges/
   own-copies only. It does **not** retroactively touch existing pins or
   claims — that's what `banAccount` is for, and it already exists. Mirrors
   the project's conservative, non-destructive moderation philosophy.
4. `getAccountUsage(account)` sums `pins WHERE uploader = account` only — an
   account is never charged against another account's own-copy or guardian
   pin on the same CID.

---

## 3. Enforcement: where the whitelist gate actually lives

**Plain language:** there isn't one door into the gate, there are four. Every
place money changes hands and a reservation/claim gets created needs the same
check, not just the main one.

| Entry point | File:function | Bypasses `createReservation`? |
|---|---|---|
| `POST /reserve` | `quota.createReservation()` | — (this *is* the central check) |
| `POST /guardian/pledge` | `guardianPledgeHandler` | **yes** — creates its claim directly |
| `POST /claims/own-copy` | own-copy route | **yes** — creates its claim directly |
| `POST /claims/extend` | extend route | n/a — extends an already-active claim |

The first three each already have their own inline `isAccountBanned` check
(the codebase didn't centralize that check either) — the whitelist check
mirrors that same inlining, not a single choke point that two of the three
routes would silently skip:

```js
// quota.createReservation(), next to the existing isAccountBanned check:
if (WHITELIST_MODE && !isAccountWhitelisted(uploader)) {
  throw Object.assign(new Error('this server is invite-only — your account is not whitelisted'),
    { code: 'forbidden' });
}

// guardianPledgeHandler and POST /claims/own-copy, same shape:
if (WHITELIST_MODE && !quota.isAccountWhitelisted(account)) {
  return respondError(res, 'forbidden', 'account is not whitelisted on this server');
}
```

`POST /claims/extend` gets **no** whitelist or ban check, deliberately — same
reasoning the codebase already applies there for bans: nothing to gate on a
claim that's already active, and a banned/de-whitelisted account's active
claims are already force-cancelled by the time it would matter.

`WHITELIST_MODE=false` (the default) must produce **zero behavior change**
anywhere — this is the load-bearing regression test for Stage A.

---

## 4. Fee exemption

**Plain language:** a fee-exempt whitelisted account gets the same claim
model, same pricing formula, just at `rate: 0`. No new pricing engine — every
change is a call-site branch on top of `pricing.calculateCost()`, which
already accepts an overridable `rate` param.

```
fee_exempt account:  total_cost = billable_MB × billable_hrs × 0 × copies = 0
```

- **`POST /reserve`**: look up the whitelist entry, pass `rate: 0` when
  `fee_exempt`, surface `fee_exempt: true` in the quote response honestly —
  same transparency the existing `copies_capped` flag already gives (no silent
  $0 the client can't explain).
- **`POST /upload`**: a fee-exempt reservation already carries
  `quoted_amount: 0` (persisted at reserve time) — that's the signal to skip
  on-chain payment verification and record a synthetic zero-amount payment row
  instead (still needs a globally-unique `tx_id`; `payments.tx_id` is `UNIQUE`).
- **`GET /guardian/quote`, `GET /claims/own-copy/quote`**: these take no
  caller-identity param today, so they can't honestly preview a $0. Add an
  optional `?hive_account=` query param (no signature needed — this is already
  a public GET, and whitelist membership isn't sensitive to the account asking
  about itself) so a fee-exempt account sees $0 before pledging, not just at
  pay time.
- **`POST /guardian/pledge`, `POST /claims/own-copy`**: these bypass
  `/reserve`, so exemption must be recomputed fresh from the whitelist table at
  pledge/pay time, not read off a stored reservation flag.
- **Watch for:** 3 call sites currently hardcode
  `rateLocked: pricing.RATE_PER_MB_HOUR` when creating a claim (upload,
  own-copy, guardian pledge). All 3 need
  `rateLocked: feeExempt ? 0 : pricing.RATE_PER_MB_HOUR`, or a fee-exempt
  claim's later pro-rata refund math silently charges the real rate on
  cancellation. Easy to miss, would only surface as a support ticket months
  later — call it out explicitly at implementation time.
- **`POST /claims/extend`** *(amended at Stage-B build time — the original
  lock claimed "no changes needed" and was wrong in one detail)*: `rate_locked`
  being 0 makes the extend quote 0, but the route demanded an on-chain `tx_id`
  unconditionally — an exempt owner would be stranded needing a $0 transfer.
  Fixed: payment is skipped ONLY when the computed cost is 0 (only possible
  via a rate-0, i.e. exempt-created, claim) AND the claim's owner is STILL
  fee-exempt right now. Payment-is-auth doesn't apply at $0, so the live
  whitelist entry is the gate instead.
- **No special-case needed for refunds.** `amount_paid` is already `0` for an
  exempt claim, so the existing `pricing.forcedRefundAmount` naturally returns
  `0` on a later ban/takedown regardless of `policy`. Stated here as a
  confirmed non-issue, not a gap.

---

## 5. The Hive-account admin tier

**Plain language:** today "admin" means one shared password (`ADMIN_KEY`) the
box owner holds. The original ask wants a *Hive account* to be the admin
("hive_user foo is admin") — a family member or trusted co-operator, not
necessarily the box owner. This adds that as a **second, narrower** tier
alongside the first, never replacing it.

```
Bearer ADMIN_KEY           →  box owner, unconditional, every /admin/* route (unchanged)
Hive-signed SERVER_ADMIN   →  narrower — only ban/unban/takedown/untakedown,
                               whitelist CRUD, and delete-others'-pin
```

**Config:**
```
SERVER_ADMIN_HIVE_ACCOUNTS=   # comma-separated Hive accounts (lowercase, no @). Empty = tier disabled.
```

**Auth:** reuses `verifySignedUserRequest` (already proven — the same
mechanism `/uploads/by-user` and `/claims/cancel` already use), with the
signed message bound to the specific action **and target** so a signature
authorizing "ban bob" can't be replayed to ban alice:

```
ipfs-gate:admin-action:v1:<action>:<target>:<account>:<ts>
```

**Resolved decisions:**
1. Scope: the Hive tier reaches `ban`/`unban`/`takedown`/`untakedown` + the new
   whitelist CRUD + delete-others'-pin. It does **not** reach
   `stats`/`moderation/log`/`orphan-payments`/`uploads` — those stay
   `ADMIN_KEY`-only. Narrower blast radius for a tier that might be "a trusted
   family member," not the box operator.
2. The `SERVER_ADMIN_HIVE_ACCOUNTS` roster is **never** exposed unauthenticated
   — not in `GET /`, not anywhere a non-admin can read. An account learns "am I
   admin" only via its own signed request (rides on the same signed
   `/uploads/by-user` response that already proves identity — see §7).
   Whitelist *membership*, by contrast, is fine to echo back to the account
   itself the same way — it's not sensitive to the account it's about.
3. A Hive-tier admin **can** whitelist or fee-exempt themselves — trusted-
   delegate model, same trust level as being named in the roster at all.
4. Every `moderation.js` mutation (`banAccount`, `unbanAccount`, `takedownCid`,
   `untakedownCid`) gains an optional `admin_id` param (default: today's
   hardcoded `'operator'`) so the audit log and the `banned_by`/`blocked_by`
   columns correctly attribute a Hive-tier action to `hive:<account>` instead
   of the generic `'operator'` string. Fully backward compatible — every
   existing call site that omits it keeps today's exact behavior.

---

## 6. Delete-others'-pin (the one new primitive)

**Plain language:** an admin needs to remove *one specific file* someone else
uploaded without banning their whole account or taking down the CID for
everyone else who might also be hosting it.

- Extend `quota.cancelClaim(claimId, owner, {asAdmin} = {})` — when
  `asAdmin: true`, skip the existing `claim.owner !== owner` ownership check.
  Default `asAdmin: false` preserves every existing caller exactly.
- New route `POST /admin/pins/delete` — body `{ target_account, cid, reason }`
  + the admin-auth fields from §5. Resolves the target account's active
  claim(s) on that CID, cancels each with `asAdmin: true`, settles refunds via
  the **existing** `settleForcedRefund` helper the ban/takedown routes already
  use, unpins from Kubo only when no funder remains.
- No duplicated cancel or refund logic — one boolean bypass on an existing,
  already-tested atomic transaction.

---

## 7. What a caller learns about themselves

**Plain language:** `GET /` has no identity attached to it (anyone can call
it), so it can only announce the *mode* ("this server has whitelist mode on"),
never "is @foo whitelisted." The place a caller finds out what *they*
personally get is the endpoint that already proves who they are.

- `GET /` gains `features.whitelist_mode: true|false`. Nothing account-specific.
- `/uploads/by-user` (already signed, already proves identity) gains:
  ```
  quota.whitelisted    — true | false | null (null when WHITELIST_MODE is off)
  quota.fee_exempt     — true | false
  quota.quota_scope    — 'per_account' | 'shared_disk'
  is_admin             — true | false (SERVER_ADMIN_HIVE_ACCOUNTS membership)
  ```
  No new signed round-trip needed — this rides on a request the client already
  makes right after login.

---

## 8. Frontend behavior

- **Invite-only banner** when `GET /` reports `whitelist_mode: true`.
- **Not-whitelisted block**: disable the Private-Send / Public-Upload action
  buttons with a clear message when `/uploads/by-user` reports
  `whitelisted: false`, instead of letting the user hit a live 403 mid-flow.
- **Fee-exempt badge**: "Free (fee-exempt)" in place of the computed estimate
  on both upload tabs when `quota.fee_exempt` is true.
- **Hidden "🛠 Admin" tab**, revealed only when `is_admin: true` — whitelist
  add/remove + a ban/takedown mini-form against the dual-auth routes.

---

## 9. Config additions

```
# ─── Whitelist / gated-server mode (opt-in, off by default) ─────────────────
WHITELIST_MODE=false                  # off by default — matches this project's opt-in philosophy
SERVER_ADMIN_HIVE_ACCOUNTS=           # comma-separated Hive accounts, narrow admin tier via signed requests
```

---

## 10. Staged build order

Mirrors how the Guardian feature itself was staged (`roadmap_status.md`,
Stage 0 → 6) — each stage is independently testable before the next starts.

- **Stage A — schema + config + upload-gate enforcement.** Pure backend, no
  money logic yet. `migrations/007_whitelist.sql`, `quota.js` read-helpers +
  the three enforcement call sites (§3), `.env.example` entries,
  `test/whitelist.test.js`. Critical case: `WHITELIST_MODE=false` ⇒ byte-for-
  byte identical behavior to today.
- **Stage B — fee exemption.** `/reserve` + `/upload` branching, the shared
  synthetic-payment helper, the two quote-endpoint `?hive_account=` additions,
  the two pledge/own-copy POST branches, the 3-call-site `rateLocked` fix (§4).
  `test/whitelist-fees.test.js`.
- **Stage C — Hive-account admin tier + whitelist CRUD + delete-others'-pin.**
  `verifyAdminAuth`, `moderation.js` `admin_id` threading, the 4 modified
  admin routes, the 3 new whitelist routes, `cancelClaim({asAdmin})` +
  `/admin/pins/delete` (§5, §6). `test/admin-hive-tier.test.js`.
- **Stage D — frontend.** Invite-only banner, not-whitelisted block,
  fee-exempt badge, the new Admin tab (§8).

---

## 11. Out of scope for v1 (deferred)

- **Per-admin fine-grained permissions** (e.g. an admin who can whitelist but
  not ban) — v1's Hive tier is all-or-nothing within its scoped route set (§5).
  Split further only if a real multi-admin deployment needs it.
- **Whitelist expiry / temporary invites** — entries persist until explicitly
  removed. Add a `expires_at` column later if time-boxed guest access is
  wanted.
- **Public whitelist roster** — never exposed, even to other whitelisted
  members, in v1 (§5, decision 2).
- **Federation-aware whitelisting** (a whitelist shared across cooperating
  gates) — orthogonal to and deferred alongside v2 federation generally.

---

## 12. One-line summary

**One new table (`whitelisted_accounts`, mirroring `banned_accounts`), one new
opt-in enforcement check inlined at all three claim-creating entry points, fee
exemption as a `rate: 0` call-site branch on the pricing engine that already
supports it, and a second, narrower Hive-signed admin tier layered next to the
existing `ADMIN_KEY` tier — reusing `verifySignedUserRequest`,
`settleForcedRefund`, and the ban/takedown machinery wherever possible, with
exactly one genuinely new primitive (delete-one-pin-as-admin).**

*Written 2026-07-04. Source: plan `need-help-my-brain-humming-stroustrup.md`
(design-agent research pass over `server.js`, `quota.js`, `moderation.js`,
`pricing.js`, all 6 existing migrations). Built Stages A–D the same day
(migration 007, 28 new tests → suite 81 green); live-tested end-to-end on
`ipfs.v4call.com` 2026-07-05 — see the status header for the two post-lock
findings.*
