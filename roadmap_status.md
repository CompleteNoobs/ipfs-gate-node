# ipfs-gate — Roadmap & Status

> Updated 2026-05-24. Source of truth: this file + [CLAUDE.md](CLAUDE.md).
> Full design history + reasoning lives in the brainstorm scratchpad at
> `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md`.

## Current status

**v0.1 first build is live.** Code complete, deployed and HTTPS-verified on an Ubuntu 24.04 VPS at `ipfs.completenoobs.com` (2026-05-24).

| # | Pre-build blocker | Status |
|---|---|---|
| B1 | Repo layout | ✅ Locked + repo created |
| B2 | Database schema | ✅ Locked + migration applies on boot |
| B3 | API endpoint contracts | ✅ Locked + 14 endpoints implemented |
| B4 | Reservation token format | ✅ Locked + working |
| B5 | Hive payment verification | ✅ Locked + Option C implemented |

### v0.1 build deltas vs design

Four deployment bugs found + fixed during first VPS deploy (all folded into `WalkThrough.wiki` Common Problems):
1. `SQLITE_CANTOPEN` from host data/ ownership — wiki Step 2 now pre-chowns
2. `BIND_HOST=127.0.0.1` blocking nginx → 502 — default flipped to `0.0.0.0`
3. `docker compose restart` doesn't reload `.env` — wiki now says use `down && up -d`
4. `parseInt(DEFAULT_TTL_DAYS)` truncated `0.001` to `0` — now `parseFloat`

## 🎯 NEXT MILESTONE — v4call client integration

**This is the actual next work**, not another ipfs-gate version. Lives in the v4call repo, not here.

### Scope
Add the sender + recipient UX in `~/CAI/v4call/public/index.html`:

**Sender side (in a v4call room):**
- 📎 button in room chat header → opens upload modal
- File picker (jpeg only for v0.1)
- Recipient checkbox list of current room members (sender auto-included)
- ipfs-gate URL picker with default + alternatives + custom-entry option
- Cost preview ("≈ 1 CNOOBS for 7 days")
- "🔒 Encrypt & Upload" button + optional "⚠ Upload Unencrypted (public)" with confirmation gate
- Browser-side: AES-GCM encryption + per-recipient hivecrypt envelopes → POST `/reserve` → Hive Keychain `requestCustomJson` for CNOOBS transfer → POST `/upload`
- On success: emit `room-attachment` socket event to v4call server

**Recipient side (in a v4call room):**
- `room-attachment` socket event handler in `public/index.html`
- Inline chat bubble: sender + sig ✓ + size + expiry countdown
- Auto-fetch ciphertext from `gateway_hint` + decrypt with own posting key
- Render image thumbnail inline (jpeg only for v0.1)
- Save-to-device button (Blob URL + anchor download)
- Bystander view (locked bubble for room members not in per_recipient list)
- Error states: bad sig / decryption fail / 404 from gateway / TTL expired

**Server side (v4call):**
- ~30 lines: route `room-attachment` events to room members (inherits existing room broadcast infrastructure)

### Reference docs for the integration
- `~/CAI/IPFS-Gate/CLAUDE.md` — wire format spec (inner blob + outer envelope), API endpoint shapes, signature canonical messages
- `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md` — full design rationale for the recipient UX, the two-signature scheme, the dedup model, etc. Recipient UX section has the chat-bubble mockups.
- `~/CAI/IPFS-Gate/envelope.js` — canonical-message helpers ready to be ported to browser JS for client-side use (`buildUploadProofMessage`, `buildEnvelopeSigInput`, etc.)

### Estimated scope
- ~200 lines client (HTML + CSS + sender modal + recipient bubble + handlers)
- ~30 lines server (envelope routing — mostly inherits existing room broadcast pattern)
- One focused session

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

### v0.2 — multi-currency pricing + UX polish
- Multi-currency picker (HBD, HIVE, SWAP.BTC, custom tokens) following v4call's `computePaymentOptions` pattern
- GB-hour rate math + per-upload minimum fee (handle precision floor like v4call's `RATE_FLOOR`)
- Tighten CORS to allowlist of approved/paying origins
- Streaming uploads for files >100MB
- Better operator dashboard
- `kind_hint` enum for non-image attachments

### v0.3 — federation (optional, opt-in)
- Operator-to-operator Nostr-based discovery
- Cross-operator banlist + takedown publish/subscribe (per-operator opt-in)
- Same architectural pattern as v4call's Nostr fed work (nGate Stage 4+)

### v0.4 — pin-by-discovery
- User claims a CID exists already on the IPFS network
- ipfs-gate fetches from peers, verifies bytes match CID, charges user to pin
- Saves bandwidth on duplicate uploads across services

### v0.5+ — adapters + replication
- Pinata adapter (drop-in backend for operators wanting external scale)
- Filecoin / web3.storage cold-tier adapter ("keep forever" option)
- Multi-host pin replication for paying customers ("host on N gates")
- IPFS Cluster integration for multi-node operators

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

## v4call integration checklist (next milestone)

- [ ] Read `~/CAI/v4call/public/index.html` to scope the file-picker button location and existing room-message rendering patterns
- [ ] Browser-side: AES-GCM encryption helper + per-recipient hivecrypt envelopes
- [ ] Sender modal HTML/CSS + file picker + recipient checkbox + ipfs-gate URL picker
- [ ] `/reserve` → Keychain `requestCustomJson` → `/upload` flow in browser
- [ ] `room-attachment` socket event handler (sender emit + recipient receive)
- [ ] Recipient bubble: thumbnail render + save-to-device + bystander variant
- [ ] Server-side: route the `room-attachment` event through existing room broadcast
- [ ] End-to-end test: guest33 → noblemage real jpeg in a v4call room