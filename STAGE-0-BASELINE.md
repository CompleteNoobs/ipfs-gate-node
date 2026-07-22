# Stage 0 — Verify baseline (Private Encrypted Hosting v1)

> ⚠️ **Proof of concept — not for real use.** Output of Stage 0 of the v1 build
> plan ([roadmap_status.md:101](roadmap_status.md#L101)). Purpose: confirm the
> ground the claim-model build (Stage 1a+) and the later crypto work (Stage 4+)
> stand on **before** writing any of it. Items are either **code-verified now**
> or **flagged for live confirmation** by the operator.

_Verified 2026-06-14, ahead of the Stage 1a build in the same session._

## Legend
- ✅ **code-verified** — confirmed by reading the source in this repo / the v4call repo.
- 🔵 **confirm live** — needs a running gate / a real browser; the operator checks.

---

## 1. Pinning round-trip wired (`/reserve` → `/upload` → `/ipfs/:cid`)

| Check | Status | Evidence |
|---|---|---|
| `/reserve` allocates a reservation + returns payment instructions | ✅ | [server.js:208](server.js#L208) → `quota.createReservation` |
| `/upload` verifies sig + Hive payment + sidechain, pins to Kubo, records pin | ✅ | [server.js:248](server.js#L248); sidechain hard-reject at [:343](server.js#L343) |
| `/ipfs/:cid` streams bytes from Kubo with mode-aware content-type | ✅ | [server.js:471](server.js#L471) |
| Kubo backend: add(pin)/unpin/gc/cat/stats | ✅ | [backends/kubo.js](backends/kubo.js) |
| **End-to-end paid upload renders in a real client** | 🔵 | last confirmed live 2026-05-25 (cnoobz → testin/guest33) per roadmap; **re-confirm on the prod gate after the Stage 1a cutover** |

## 2. v4call upload UI exists (send + manage)

| Check | Status | Evidence |
|---|---|---|
| Encrypted room/DM attachment send flow | ✅ | `sendAttachment()` — `v4call/public/app.html` (~L5816) |
| Public/plaintext upload flow | ✅ | `uploadPublicFile()` — `v4call/public/app.html` (~L5569) |
| Uploads-management tab (signed list/delete) | ✅ | `openUploadsTab()` / `deleteUpload()` — `v4call/public/app.html` (~L5244) |
| Gate URL + storage-backend picker | ✅ | `getStorageBackend()`/`setStorageBackend()` (~L4683) |

## 3. Hive crypto method names for Stage-4 (multi-recipient encrypt + sign)

The roadmap flagged `requestEncodeWithKeys` / decode / `requestSignBuffer` as the
methods to confirm. **Finding: v4call does NOT use Keychain's `requestEncodeWithKeys`
for the key-wrap — it wraps per-recipient keys in-browser with `hivecrypt.encode`**
(which is why Keychain users must "unlock encryption" by entering their posting key —
Keychain never exposes the private key). This is the better news for Stage 4: the exact
multi-recipient key-wrap Stage 4 needs is **already proven in the shipped attachment
feature**, not a new integration.

| Capability Stage 4 needs | Method actually used | Status | Evidence (`v4call/public/app.html`) |
|---|---|---|---|
| AES-GCM file encryption (random key) | `aesGcmEncrypt` / `aesGcmDecrypt` | ✅ | ~L4437 / ~L4444 |
| Per-recipient key wrap to Hive keys | `hivecrypt.encode` / `hivecrypt.decode` | ✅ | ~L4390 / ~L4396 |
| Sign the envelope / upload proof | `requestSignBuffer` (Keychain) + `signRaw` helper | ✅ | ~L4632 / ~L4626 |
| 🔵 Operator confirms these still resolve against the **installed** Keychain build | — | 🔵 | quick browser console check before Stage 4 |

> Net: Stage 4 reuses `aesGcmEncrypt` + `hivecrypt.encode` (multi-key wrap) + `signRaw`
> verbatim. No dependency on `requestEncodeWithKeys`. Commitment-salt-in-envelope (for
> Stage 6 proof-of-receipt) is the only genuinely new crypto and is deferred to Stage 6.

## 4. Refund broadcast capability (needed for Stage 1a pro-rata refunds)

| Check | Status | Evidence |
|---|---|---|
| `hive.sendRefund` exists | ✅ but **stub** — logs + throws `not_implemented` | [hive-verify.js:358](hive-verify.js#L358) |
| Escrow active key available to wire it | ✅ | `IPFS_GATE_ACTIVE_KEY` in `.env.example` |
| Broadcast lib present | ✅ | `@hiveio/dhive` in [package.json](package.json#L19) |
| **Decision** | — | **Wire `sendRefund` in Stage 1a** (dhive `PrivateKey` → `custom_json` tokens/transfer); key-optional fallback records the refund `pending` so the gate still boots without the key. |

---

## Gate found — affects what's safe to build next

**`/reserve` cutover breaks the deployed v4call attachment flow until Stage 4.** The
live client expects the flat-fee shape (`payment.amount` = a constant). Stage 1a makes
`/reserve` return a **computed** `size × time × copies` quote. The deployed client will
still pay whatever `payment.amount` the gate returns, but it sends no `hours_requested` /
`copies` and shows a stale cost line, so the flat-fee UX is effectively retired. **This
is accepted** (operator's call; POC project). Re-wire the client at Stage 4; until then,
test the gate with curl / the test suite, not the prod v4call UI.

## Verdict

Nothing blocks **Stage 1a** (claim schema + MB-hour pricing + claim lifecycle): it is
greenfield gate backend, testable in isolation. The only 🔵 items are live re-confirms
(prod pinning after cutover, Keychain method resolution) that gate **Stage 4**, not 1a.
