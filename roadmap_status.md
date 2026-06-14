# ipfs-gate — Roadmap & Status

> ⚠️ **Proof of concept — not for real use.** ipfs-gate (with sister projects [v4call](https://github.com/CompleteNoobs/v4call) and [nGate](https://github.com/CompleteNoobs/nGate)) is a **concept design build by independent builders** — not production software. Not safe to use, not recommended for general users; for developers reviewing the code who accept the risks. Treat it as a demo.

> Updated 2026-06-14. Source of truth: this file + [CLAUDE.md](CLAUDE.md).
> Full design history + reasoning lives in the brainstorm scratchpad at
> `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md`.
>
> **Companion design docs (the current path — read these, not the old model):**
> - [PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md) — **current** pricing model (claim-based, MB-hour). DESIGN LOCKED. Supersedes the archived two-part-tariff design.
> - [ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md) — **current** co-hosting / backstop / refund / moderation model (the lifecycle that pricing sits on). DESIGN LOCKED.
> - [IPFS-Gate-Scale-Plan.md](IPFS-Gate-Scale-Plan.md) — how the gate scales (Kubernetes is the chosen path for the concept build).
> - `v4call-ipfs-gate-build-handover.md` — the Private Encrypted Hosting v1 → v2 build handover (source for the current direction below).
> - [Archive.PRICING-V0.3-DESIGN-NOTES.md](Archive.PRICING-V0.3-DESIGN-NOTES.md) — ⚠️ **ARCHIVED / superseded** (two-part tariff + prepaid balance + token discount; never built). Kept for history only — **do not build from it**; ideas partly carried forward as optional later layers (see PRICING-V1 §11).

## Current status

**v0.1.3 in production + first-client (v4call) integration complete and extended well past the original scope.** Live at `https://ipfs.completenoobs.com/`. First end-to-end paid encrypted upload landed 2026-05-25. Since then the v4call client grew multi-format attachments, DM attachments, public/plaintext upload-and-share, an uploads-management tab, and a Pinata bring-your-own storage backend (all on the v4call side — see "v4call integration — COMPLETE" below). **Next direction: Private Encrypted Hosting v1** (claim/order/pricing/release/proof-of-receipt — see "Current direction" below). Sub-revisions:

| Version | Date | What |
|---|---|---|
| v0.1 | 2026-05-24 | First VPS deploy, all 14 endpoints, sweeper running |
| v0.1.1 | 2026-05-24 | Fractional TTL via `parseFloat` |
| v0.1.2 | 2026-05-25 | Removed bogus `payload.from` check; documented `PUBLIC_GATEWAY_BASE`; `/reserve` returns `ttl_days` |
| v0.1.3 | 2026-05-25 | Hard sidechain confirmation via `getTransactionInfo` (closes under-payment bypass) |

| # | Pre-build blocker | Status |
|---|---|---|
| B1 | Repo layout | ✅ Locked + repo created |
| B2 | Database schema | ✅ Locked + migration applies on boot |
| B3 | API endpoint contracts | ✅ Locked + 14 endpoints implemented |
| B4 | Reservation token format | ✅ Locked + working |
| B5 | Hive payment verification | ✅ v0.1.3 hardened with sidechain check |

### v0.1 → v0.1.3 build deltas vs design

Seven real-deploy bugs found + fixed (all folded into `WalkThrough.wiki` Common Problems):
1. `SQLITE_CANTOPEN` from host data/ ownership — wiki Step 2 now pre-chowns
2. `BIND_HOST=127.0.0.1` blocking nginx → 502 — default flipped to `0.0.0.0`
3. `docker compose restart` doesn't reload `.env` — wiki now says use `down && up -d`
4. `parseInt(DEFAULT_TTL_DAYS)` truncated `0.001` to `0` — now `parseFloat`
5. `payload.from undefined` always-fails check (v0.1.2)
6. `https://ipfs.localhost` gateway URL with `PUBLIC_GATEWAY_BASE` unset (v0.1.2)
7. Under-payment "succeeded" because balance check was useless — sidechain confirmation now hard-rejects (v0.1.3)

Plus two operator gotchas: leftover sweeper-test TTL of `0.001` masquerading as a pin-not-working bug, and `git reset --hard` clobbering operator-edited `nginx/ipfs-gate.conf` (workaround: backup before reset). Both documented.

## ✅ v4call integration — COMPLETE (and extended)

The first-client integration shipped, then kept growing on the v4call side. All of the following are **done** (code lives in the v4call repo, `public/app.html`, not here):

- **Encrypted room attachments** (v4call v0.16.16) — the original 📎 sender modal + recipient bubble + bystander view + away-notifications + history replay. jpeg-only at first.
- **Multi-format attachments** (v4call v0.16.17–v0.16.24) — 15 MIME types across image / audio / video / pdf / text / archive; per-kind inline renderers; dynamic gate-advertised size cap; **DM attachments** (`dm-attachment*`); cross-server room attachments.
- **Public / plaintext upload-and-share** (v4call v0.16.25) — the gate's `mode: 'public'` path (plaintext bytes + claimed MIME, served with `nosniff` + html/svg forced to download), shareable `GET /ipfs/<cid>` link. Gate feature flags: `public_uploads: true, uploads_tab: true` (see `GET /`).
- **Uploads-management tab** (v4call v0.16.25) — signed `GET /uploads/by-user` + `POST /uploads/delete` (posting-key `signRaw`, `get_accounts` posting-auth membership check), gate-authoritative list + quota.
- **Pinata bring-your-own backend** (v4call v0.16.26) — client-side alternative storage credential; bypasses the gate's pay→pin path entirely (orthogonal to gate pricing).

> The gate side that backs all this is **v0.1.3** plus the public-mode + uploads endpoints already in `server.js`. No further *gate version* was cut for the integration; the growth was client-side.

### Reference docs for the integration
- `CLAUDE.md` — wire format spec (inner blob + outer envelope), API endpoint shapes, signature canonical messages
- `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md` — full design rationale for the recipient UX, the two-signature scheme, the dedup model
- `envelope.js` — canonical-message helpers (`buildUploadProofMessage`, `buildEnvelopeSigInput`, …)

---

## 🎯 CURRENT DIRECTION — Private Encrypted Hosting v1 (claim model)

**The next real build**, per `v4call-ipfs-gate-build-handover.md`. Turns ipfs-gate
from "pay-per-upload pinning" into **private file sharing with pay-per-use,
user-controlled hosting**: foo encrypts a file to specific people's Hive keys,
pays the gate to host it for a chosen time, recipients can prove receipt and
(by policy) trigger early stop-hosting + refund. Privacy comes from
**encryption, not hosting** (anyone can fetch the ciphertext; only wrapped Hive
keys decrypt).

**Guiding principle:** *v1 is the simplest case of v2.* One gate / one owner /
one copy = federation with the numbers set to 1. Build the general shapes
(order, claim, copies, rate-locked) now with trivial local values; v2
(cross-operator federation) bolts on later instead of forcing a rewrite.

### What's new vs what exists
| Piece | State |
|---|---|
| Pinning, gateway, payment-verify, sweeper, moderation | ✅ exists (v0.1.3) |
| Public + encrypted upload modes, uploads endpoints | ✅ exists |
| **Claim + order schema** (with `kind`/`state` + v2 seams) | ❌ greenfield |
| **Claim-based pricing engine** (MB-hour, decimal) | ❌ greenfield — see [PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md) |
| **Backstop safety-net** (prepaid escrow, FIFO baton, refund) | ❌ greenfield — see [ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md) |
| **Extend / top-up** an active claim | ❌ greenfield (now **in v1**) |
| **Replication dial** (copies, capped at **live** `node_count`) | ❌ greenfield |
| **Moderation × claims/escrow** (CID ban vs user ban, refund split) | ⚠️ moderation exists; the *interaction* is greenfield |
| **Release authority** (owner_only / any_of / all_of) | ❌ greenfield |
| **Encrypted multi-recipient upload / Reveal flow** (v4call) | ❌ greenfield |
| **Proof-of-receipt** (per-recipient early-release rights) | ❌ greenfield |

### Staged build plan (test one stage before the next)
Stages 1–3 are pure gate backend (no UI, testable in isolation — safest start);
Stages 4–6 are v4call-side, each adding one small gate endpoint.

- ✅ **Stage 0 — Verify baseline (done 2026-06-14).** Output: [STAGE-0-BASELINE.md](STAGE-0-BASELINE.md). Key finding: v4call's multi-recipient key-wrap already uses `hivecrypt.encode/decode` (not Keychain `requestEncodeWithKeys`) + `aesGcmEncrypt` + `signRaw` — all proven in the shipped attachment feature, so Stage 4 reuses them verbatim. The only 🔵 live re-confirms (prod pinning after cutover, Keychain method resolution) gate **Stage 4**, not 1a.
- ✅ **Stage 1a — Claim + pricing engine (gate) (done 2026-06-14).** Shipped: `migrations/003_claims.sql` (orders/claims/refunds + reservation quote cols, schema_version=3), `pricing.js` (`calculateCost`/`calculateRefund`, decimal MB-hour × copies capped at `node_count`, RATE_FLOOR discipline), claim/order CRUD + claim-aware reconcile in `quota.js`, `/reserve` **cut over to computed quotes** + `/upload` claim-create with paid ≥ quote + new signed `/claims/cancel` (pro-rata refund) + `/uploads/delete` rewired to cancel-with-refund, wired `hive.sendRefund` (dhive broadcast, **key-optional** → refunds recorded `pending` when `IPFS_GATE_ACTIVE_KEY` unset), claim-aware sweeper, and `test/claim-lifecycle.test.js` (9 tests, all green: pricing worked examples, expire-vs-cancel pro-rata, last-funder unpin, guards, ledger). `kind`/`state` columns ship at degenerate v1 values (`original`/`active`) as the Stage-1b seam. **Known breakage (accepted):** the deployed v4call attachment flow no longer matches the new quote shape until Stage 4 wires it (POC cutover — see [STAGE-0-BASELINE.md](STAGE-0-BASELINE.md)).
- ✅ **Stage 1b — Backstop, escrow & extend (gate) (done 2026-06-14).** Built + tested in two parts.
  - ✅ **Part 1 — backstop lifecycle + extend.** `kind=backstop`/`state=dormant` pledge (no disk reservation — leans on the existing copy; `GET /backstop/quote` → pay → `POST /backstop/pledge`, replay-guarded by `payments.tx_id`); **FIFO baton-pass** promotion (`quota.reconcileCidAfterEnd`, wired into both `sweep` and `cancelClaim` — `created_ts ASC, rowid ASC`); dormant-cancel **full-refund minus `BACKSTOP_CANCEL_FEE_PCT`** (`pricing.calculateDormantRefund`); **extend/top-up** at `rate_locked` (`quota.extendClaim`, `GET /claims/extend/quote` + `POST /claims/extend`); `GET /backstop/queue` debug view (public during testing per cohosting §9). `test/backstop-lifecycle.test.js` — 9 tests.
  - ✅ **Part 2 — moderation × escrow** (cohosting §7). **CID ban** (`takedownCid`) = content kill: voids the active claim AND the whole dormant queue, adds to the permanent banned-CID registry (checked at `/upload` + **`/backstop/pledge`** → re-pledge returns 451), always unpins; refunds **innocent backstoppers full escrow** + active offender per `refund_policy`. **User ban** (`banAccount`) = identity kill: voids only that user's claims, then reconciles each CID so the file **survives via another user's backstop** (or unpins if none); the banned user's own claims refund per `refund_policy` (not innocent). Refund classification is `pricing.forcedRefundAmount`; settlement via shared `broadcastRefund` + `settleForcedRefund` in `server.js`; `/admin/ban` + `/admin/takedown` now return real refund tallies. `test/moderation-escrow.test.js` — 6 tests. **24 tests green total.**
- ✅ **Stage 2 — Replication dial, capped (gate) (done 2026-06-14).** `pricing.getNodeCount()` seam (config in v1; multi-node swaps in a live cluster-peer query at that one call site) caps the copies selector `1..node_count`; `pricing.replicationConfig(copies)` maps to `{replication_factor_max, replication_factor_min = max−leeway (≥1), disable_repinning:false}`; cost already scales by `copies` (1a). `GET /` advertises `copies_max` + `replication_leeway`; `/reserve` + `/backstop/quote` echo `copies_requested` / `copies_capped` / `replication` (no silent caps). `REPLICATION_LEEWAY` env. `test/replication.test.js` — 4 tests (cap at node_count 1 vs 5, 5× quote, 5/3 cluster config). On a 1-node gate copies is always 1 → backstop stays the only co-host option.
- ✅ **Stage 3 — Release authority (gate) (done 2026-06-14).** New `release-policy.js` (pure `normalizeReleasePolicy` + `evaluateRelease`: `owner_only` / `any_of` / `all_of`, owner-override on top); `release_policy` accepted at `/upload` and stored on the order; migration `004_release_consents.sql` tracks per-recipient signed consents (idempotent); new signed `POST /claims/release` — when the threshold is met (`any_of` any listed recipient, `all_of` the full set, owner anytime) it ends the order's active claim via `quota.endActiveClaimForRelease` → pro-rata refund to owner → reconcile (**release ≠ deletion**: a queued backstop still takes the baton). `test/release.test.js` — 8 tests (policy eval for all three types + override; all_of ends only after the last consent then a backstop promotes; no-backstop unpins; idempotent consent; timer still expires with zero consents). **36 tests green total.**
- **Stage 4 — Encrypted upload, send side (v4call).** Random-key file encryption, multi-key wrap to recipient Hive keys, commitment salt inside the envelope, push to Stages 1–3 with recipient list + policies. *Test: upload to 3 recipients; ciphertext on IPFS, 3 wrapped keys, commitment stored, link returned.*
- **Stage 5 — Reveal tab (v4call).** Paste link → fetch → unwrap with recipient key → decrypt → view/save. *Test: each recipient decrypts; a 4th non-listed account cannot.* (Tab name **locked: "Reveal".**)
- **Stage 6 — Proof-of-receipt + recipient unpin rights (both).** Post-decrypt hash+sign, gate verifies against the stored commitment, writes a per-recipient receipt, lights that recipient's release right; all_of waits for the full set. *Test: a verified receipt unlocks exactly one recipient's release; all_of fires only after all receipts; a forged/unsigned proof is rejected.*

### ✅ Stage-1 decisions — RESOLVED (2026-06-14)
All locked; nothing blocking Stage 1a/1b. (Full reasoning in the two design docs.)
- **Refund-on-cancel** — pro-rata for the single active claim; dormant backstop → escrow minus `BACKSTOP_CANCEL_FEE_PCT`; expiry → none. The old pro-rata-vs-dedup tension is **dissolved** (v1 has one active claim per CID, so no over-collection; parallel co-ownership deferred to multi-node). [cohosting §6](ipfs-gate-cohosting-backstop.md).
- **MB unit** — **decimal** (`bytes / 1,000,000`). Confirmed.
- **Extend / top-up** — **in v1** (own `expiry_ts`, `rate_locked`, refundable pro-rata).
- **Tab name** — **"Reveal"**.
- **Co-hosting on a single-node gate** — **backstop only**; §9-style parallel co-ownership dropped for v1.
- **node_count** — a **live** value (config in v1, cluster peer-count later); copies capped to it at pledge.
- **Moderation × escrow** — CID ban vs user ban defined; forced voids charge no cancel fee, refund backstoppers in full, offender per `refund_policy`. [cohosting §7](ipfs-gate-cohosting-backstop.md).

### v2 — Federation (designed, DO NOT build yet)
The claim model with scope widened one level: "owner holds a claim on a CID" →
"gate hosts a CID." The three genuinely-new problems: **settlement** (money
between operators), **verification** (proving a gate holds bytes — Stage 6
prototypes this in reverse), **repair** (cross-operator self-heal). Storefront
custodies escrow; "pay for the gap, not the overlap." Handover §15.

## v0.1 — scope

### Use case
- User A sends an encrypted jpeg to User B (and optional other room members) inside a v4call room.
- File ≤10MB.
- Pinned for 7 days flat TTL.
- Payment: 1 CNOOBS per upload.

### Locked v0.1 decisions
1. **Use case**: jpeg in a v4call room (room-only, sidesteps spam vectors)
2. **Architecture**: browser → ipfs-gate direct upload; v4call routes envelope only
3. **Encryption**: browser-side AES-GCM + per-recipient hivecrypt envelopes
4. **Metadata placement**: filename + mime inside the encrypted blob (no plaintext metadata leakage)
5. **Backend**: Kubo only (Pinata/Filecoin deferred to v0.5+ adapter)
6. **Payment**: 1 CNOOBS per upload ≤10MB, 7-day TTL, auto-refund on pin failure
7. **Quota mechanism**: two-phase reserve → commit (prevents race conditions)
8. **Stack + license**: Node + Express + Kubo + SQLite + Nginx + MIT
9. **Server shape**: long-running HTTP server with plug-in backend interface (4-function contract)
10. **CORS**: `origin: '*'` for v0.1, tighten in v0.2
11. **Recipient UX**: 3-audience model (recipient / sender-self / bystander), auto-decrypt, save-to-device
12. **Wire format**: inner blob (binary, AES-GCM, length-prefixed header) + outer envelope (JSON)
13. **Two signatures**: `upload_proof_sig` for ipfs-gate, `envelope_sig` for recipients
14. **Deployment**: separate box from v4call, dedicated Hive account, 5GB default disk, private DHT, `ipfs.v4call.com`
15. **Dedup model**: multi-pin-record (per-uploader pin records, Kubo dedups bytes)
16. **Moderation**: ban + takedown + unban + audit log + refund policy (none|prorata)
17. **Federation**: deferred to v0.2+ but architecturally enabled

### What v0.1 explicitly does NOT do
- Lobby attachments, DM attachments, cross-server attachments
- Federation envelopes for cross-server pinning
- Multi-currency picker
- Time-based / GB-hour pricing
- Pinata or Filecoin adapter
- Streaming uploads for large files (>100MB)
- Forwarding UI
- Federation discovery (Nostr)
- Donate-to-extend an existing pin
- Watch-and-rescue for expiring pins
- Pin-by-discovery (bandwidth-saving re-pin across federated gates)
- Multi-admin attribution
- Auto-refund of wrong-currency or wrong-amount payments (operator review)

## v0.1.x follow-ups (after v4call integration starts surfacing real usage)

These are nice-to-haves that didn't block v0.1 but are worth doing once there's real traffic:

| Item | Trigger |
|---|---|
| `sendRefund` actual broadcast wiring | First real disconnect-mid-upload event in production |
| Recipient-side error/edge cases in deeper detail | First bug report from a v4call user |
| Reservation token cleanup fine details (partial Kubo pin cleanup, etc.) | Audit during first sweeper-run analysis |
| Kubo Docker config tuning | When disk usage gets close to limit |
| Testing strategy | Probably after v0.2 multi-currency lands |
| Operator first-boot flow | When the second operator wants to deploy |

## v0.2+ futures (sketched, not committed)

> **Note (2026-06-14):** these bullets predate the **claim-model direction**
> above and the dedicated [pricing](PRICING-V1-DESIGN-NOTES.md) /
> [scale](IPFS-Gate-Scale-Plan.md) docs. Treat them as a backlog of ideas, not
> a committed sequence — where they overlap the claim model or those docs, the
> docs win. The old "GB-hour" pricing line in particular is **superseded** by
> the claim-based MB-hour model.

### v0.2 — multi-currency pricing + UX polish
- Multi-currency picker (HBD, HIVE, SWAP.BTC, custom tokens) following v4call's `computePaymentOptions` pattern
- ~~GB-hour rate math~~ → **superseded**: pricing is now the claim-based MB-hour model ([PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md)). Per-upload minimum + precision-floor discipline (v4call's `RATE_FLOOR`) still apply.
- Tighten CORS to allowlist of approved/paying origins
- Streaming uploads for files >100MB
- Better operator dashboard
- `kind_hint` enum for non-image attachments (largely covered by the multi-format work already shipped)

### v0.3 — federation (optional, opt-in)
- Operator-to-operator Nostr-based discovery
- Cross-operator banlist + takedown publish/subscribe (per-operator opt-in)
- Same architectural pattern as v4call's Nostr fed work (nGate Stage 4+)

### v0.4 — pin-by-discovery
- User claims a CID exists already on the IPFS network
- ipfs-gate fetches from peers, verifies bytes match CID, charges user to pin
- Saves bandwidth on duplicate uploads across services

### v0.5+ — adapters + replication
> Scaling specifics now live in [IPFS-Gate-Scale-Plan.md](IPFS-Gate-Scale-Plan.md) (Kubernetes is the chosen path for the concept build); the copies/replication *pricing* dial lives in [PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md) §4.
- Pinata adapter (drop-in backend for operators wanting external scale) — note a **client-side** Pinata BYO backend already shipped in v4call; this is the *gate-side* overflow adapter (PSA spec), a different thing
- Filecoin / web3.storage cold-tier adapter ("keep forever" option)
- Multi-host pin replication for paying customers ("host on N gates") — the within-cluster form is the copies dial; the cross-operator form is v2 federation
- IPFS Cluster integration for multi-node operators (raises `node_count` above 1)

### v0.5+ — donate-to-extend + watch-and-rescue
- Bob donates X CNOOBS toward Alice's pin to extend its TTL (vs creating a new pin record)
- Bob watches CID; when last pin record nears expiry, Bob notified to pay/extend

## Cross-cutting open threads (raised during planning)

These came up during brainstorm sessions and don't fit cleanly into a single version:

| Thread | Notes |
|---|---|
| Repeat-offender sock-puppet mitigation | v0.2+ optional: minimum HP / account age gate on uploads |
| Anonymous "claim this CID is mine" flow | Not v0.1; raises identity questions |
| Shared blocklists across cooperating operators | v0.3+ if needed; opt-in only to avoid red/blue team wars |
| Multi-admin per-user attribution | v0.2+ if multi-human operators emerge |
| Auto-publish moderation actions on Hive/Nostr | v0.3+ optional transparency layer |
| Payment top-up of existing pin (renew without re-upload) | v0.2+ "extend" endpoint |

## Sister-project bridges (cross-pollination)

| Project | What ipfs-gate borrows | What ipfs-gate might give back |
|---|---|---|
| v4call | Hive payment verifier, hivePost helper, hardened Hive-node fallback list, SQLite pattern (better-sqlite3), Express/Docker/Nginx deployment pattern | Encrypted file transport for room messages |
| nGate | Identity-gated policy plugin pattern, per-server keypair model, Stage 4 architectural learnings | Discovery-loop pattern reuse for paid private relay onboarding |

## v0.1 build checklist (all complete)

- [x] Repo path decided (`~/CAI/IPFS-Gate`)
- [x] GitHub destination created (`github.com/CompleteNoobs/IPFS-Gate`)
- [x] License decided (MIT)
- [x] Database schema spec written + migration applies on boot
- [x] API contracts spec written + all 14 endpoints implemented
- [x] Hive payment verification implemented (Option C)
- [x] Reservation token format implemented (16-hex random + DB lookup)
- [x] Wire format (envelope + inner blob + 2 sigs) implemented in `envelope.js`
- [x] Moderation primitives implemented (ban/takedown/unban/audit/refund-policy)
- [x] Deployment topology decided + delivered (separate VPS, dedicated Hive account, Kubo + nginx + Docker)
- [x] README.md, roadmap_status.md, CLAUDE.md
- [x] WalkThrough.wiki (operator-facing, Ubuntu 24.04 reference)
- [x] `git init` + initial commit (local; user pushes)
- [x] `package.json` + dependencies
- [x] Full project skeleton (server.js, backends/kubo.js, quota.js, hive-verify.js, envelope.js, moderation.js, sweeper.js)
- [x] Local smoke test (modules load, server boots, all endpoints respond, ban/unban cascade works)
- [x] First VPS deployment HTTPS-verified at `https://ipfs.completenoobs.com/`
- [x] Four real-deploy bugs found + fixed + folded into wiki

## v4call integration checklist — COMPLETE

- [x] Browser-side: AES-GCM encryption helper + per-recipient hivecrypt envelopes
- [x] Sender modal HTML/CSS + file picker + recipient checkbox + ipfs-gate URL picker
- [x] `/reserve` → Keychain `requestCustomJson` → `/upload` flow in browser
- [x] `room-attachment` socket event handler (sender emit + recipient receive)
- [x] Recipient bubble: thumbnail render + save-to-device + bystander variant
- [x] Server-side: route the `room-attachment` event through existing room broadcast
- [x] End-to-end test: real encrypted jpeg in a v4call room (2026-05-25, cnoobz → testin + guest33)
- [x] Extended: multi-format, DM attachments, public uploads, uploads tab, Pinata BYO (v4call v0.16.17–v0.16.26)

> **Next build is the claim-model "Private Encrypted Hosting v1"** — see "Current direction" above for the staged plan (Stage 0 → 6) and the decisions to resolve first.