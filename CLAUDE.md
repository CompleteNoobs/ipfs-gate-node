# CLAUDE.md — ipfs-gate Project Context

> ⚠️ **Proof of concept — not for real use.** ipfs-gate (with sister projects v4call and nGate) is a **concept design build by independent builders** — not production software, not safe to use, not recommended for general users; for developers reviewing the code who accept the risks. Treat it as a demo.

> **Status (2026-07-04): v0.1.3 in production; v1 (Stages 0–6) COMPLETE; Guardian feature BUILT (gate + standalone-page UI incl. tracking/cancel); Whitelist/gated-server mode BUILT (Stages A–D, 81 tests) — see roadmap_status.md "Whitelist / gated-server mode".** First-client (v4call) integration complete and extended (multi-format, DM, public uploads, uploads tab, Pinata BYO — all client-side in v4call). "Private Encrypted Hosting v1" — claim/order model, claim-based pricing, release authority, proof-of-receipt — shipped 2026-06-16. The **Guardian feature** (multi-participant hosting of the same CID: `original | own_copy | guardian` claim kinds, already-hosted detection via `POST /check`, own-copy claims without re-upload, FIFO guardian queue with `pledge_order`/`pledge_budget`, full dormant-cancel refund) landed 2026-07-02 per the Guardian dev-handover spec — the Stage-1b "backstop" was renamed to guardian (migration 006; `/backstop/*` routes remain as legacy aliases). See `roadmap_status.md` "Guardian feature" for the build record. Client UI for it is NOT built yet.

> **📐 Current-direction design docs (READ THESE — they are the live path; the older per-upload/pricing thinking is superseded):**
> - `PRICING-V1-DESIGN-NOTES.md` — claim-based MB-hour pricing (DESIGN LOCKED).
> - `ipfs-gate-cohosting-backstop.md` — co-hosting / backstop / refund / moderation lifecycle (DESIGN LOCKED).
> - `IPFS-Gate-Scale-Plan.md` — scaling (Kubernetes is the chosen path).
> - `v4call-ipfs-gate-build-handover.md` — the v1 → v2 build handover.
> - `WHITELIST-MODE-DESIGN-NOTES.md` — gated/family-server mode (DESIGN LOCKED 2026-07-04; not yet built — Stage A hasn't started).
> - `Archive.PRICING-V0.3-DESIGN-NOTES.md` — ⚠️ **ARCHIVED / superseded**, history only — do **not** build from it (two-part tariff + prepaid balance + token discount; never built). The "Pricing (v0.1)" `.env` block further down is the *shipped v0.1.3 flat per-upload* fee — accurate for what's deployed today, but superseded by the claim model for the v1 build.

> **Brainstorm scratchpad** (full design history with every decision's reasoning): `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md`. Read this if you need to understand WHY a v0.1 decision was made — locked decisions are mirrored here in CLAUDE.md but the rationale lives in the plan file.

> **⚠️ Sister project of v4call.** The user is the same person, the design philosophy is the same, and many decisions reuse patterns from v4call (`/home/noob/CAI/v4call/`). When in doubt about a pattern, check v4call's `CLAUDE.md` and `server.js` first.

> **⚠️ Docs convention.** WalkThrough.wiki is load-bearing, not optional polish. When a bug is found and fixed during deployment, fold the symptom-first entry into the wiki's "Common problems" section, ordered by first-boot likelihood. The user is a tinkerer who values reproducible recipes over re-deriving things months later. This convention is shared across v4call, nGate, and ipfs-gate.

## What This Is

A standalone, Hive-payment-gated IPFS pinning service. Same architectural philosophy as nGate (identity-gated Nostr relay), but for IPFS hosting. Operators run their own server; users pay with HBD or custom Hive-Engine tokens (CNOOBS for v0.1); the operator pins content for a configurable TTL.

**The core idea:** decentralised file hosting where the gatekeeper is on-chain payment, not a credit card processor. Encryption happens in the browser; ipfs-gate sees opaque bytes only.

## Current Version

- **Software**: v0.1.3 — production-ready, first-client (v4call) integration complete. Three sub-revisions shipped during the 2026-05-25 first-VPS + first-client testing pass:
  - **v0.1.1** — `parseInt` → `parseFloat` for `DEFAULT_TTL_DAYS` (sweeper-test setting `0.001` was silently truncating to 0).
  - **v0.1.2** — Removed the redundant `payload.from` check in `hive-verify.js` that always failed (Hive-Engine's `tokens/transfer` contractPayload has no `from` field — the sender is in the wrapping custom_json's `required_auths`, which `extractTokenTransferOp` already validates). Added `PUBLIC_GATEWAY_BASE` to `.env.example` (was undocumented; defaulted to `https://ipfs.localhost`). Added `ttl_days` to the `/reserve` response so clients can render the actual cost dynamically.
  - **v0.1.3** — Hard sidechain confirmation. The previous balance-check after `/upload` payment was useless for catching under-balanced senders: escrow's existing balance already exceeded the per-payment amount, so the check passed even when 0 actually landed. Replaced with `verifyHiveEngineSidechain(txId)` that polls `api.hive-engine.com/rpc/blockchain getTransactionInfo` for authoritative success/fail, then HARD-rejects the upload (cancels reservation, no pin) if sidechain rejected. Surfaces the actual sidechain error to the client. Closes the "file pinned for free when under-paid" bypass.
- **Federation protocol**: N/A (federation deferred to v0.3+)
- **Production state**: live at `https://ipfs.completenoobs.com/`. First end-to-end paid encrypted upload landed on 2026-05-25 (cnoobz → testin + guest33). All v0.1 surface area exercised against real Hive accounts on real Hive-Engine: payment-required, under-payment rejection, encrypted upload, gateway fetch, expiry, persistence, bystander privacy.

## What v0.1 ships

A user (`guest33`) sends an encrypted jpeg to another user (`noblemage`) inside a v4call room:
1. Sender's browser encrypts the file with AES-GCM, encrypts the AES key per-recipient via hivecrypt
2. Sender pays 1 CNOOBS to ipfs-gate's Hive escrow (via Keychain)
3. Sender uploads ciphertext directly to ipfs-gate (HTTPS POST, multipart)
4. ipfs-gate verifies payment + signature, pins to local Kubo, returns CID
5. Sender emits a `room-attachment` envelope via v4call socket (CID + per-recipient encrypted keys)
6. Recipients fetch ciphertext from ipfs-gate's gateway, decrypt in browser, render inline

v4call never touches the file bytes. ipfs-gate never sees plaintext.

## Tech Stack

- **Backend**: Node.js, Express, better-sqlite3, multer (for multipart uploads), cors, express-rate-limit
- **IPFS daemon**: Kubo (go-ipfs), reached via its HTTP API on `http://kubo:5001`
- **Blockchain**: @hiveio/dhive for Hive verification, hivecrypt for posting-key utilities
- **Browser crypto**: Web Crypto API (`crypto.subtle.encrypt`, AES-GCM); hivecrypt JS lib for key envelopes
- **Hive-Engine**: account balance check via `https://api.hive-engine.com/rpc/contracts` (NOT transferHistory — see Gotchas)
- **Deployment**: Docker (node:20-alpine), Nginx reverse proxy, Let's Encrypt SSL
- **Database**: single SQLite file at `/app/data/ipfs-gate.db` (WAL mode), mounted as `./data/ipfs-gate:/app/data`

## File Map (planned)

```
ipfs-gate/
├── server.js              — HTTP routing (Express). Public + admin endpoints.
├── hive-verify.js         — Hive payment + signature verification. (Copy patterns from v4call/server.js)
├── quota.js               — SQLite quota DB + reservation tokens. better-sqlite3 module.
├── moderation.js          — Ban list, takedown-by-CID, audit log writes.
├── sweeper.js             — Cron: expire reservations + pins, unpin from Kubo + GC.
├── envelope.js            — Wire-format helpers (envelope sig verify, etc.)
├── backends/
│   ├── interface.md       — Backend contract: pin / unpin / exists / stats
│   ├── kubo.js            — v0.1 backend; talks to local Kubo HTTP API
│   ├── pinata.js          — v0.5+ adapter (NOT BUILT)
│   └── filecoin.js        — v0.5+ adapter (NOT BUILT)
├── migrations/
│   └── 001_initial.sql    — Initial schema (7 tables + indexes + pragmas)
├── admin-cli/
│   └── ipfs-gate-admin.sh — Thin curl wrapper for /admin endpoints (optional)
├── Dockerfile             — node:20-alpine, runs as user node (UID 1000)
├── docker-compose.yml     — kubo + ipfs-gate + nginx + certbot
├── nginx/ipfs-gate.conf   — HTTPS + CORS + reverse proxy to ipfs-gate:3001
├── .env.example           — All config; never commit real .env
├── package.json
├── README.md
├── roadmap_status.md
├── CLAUDE.md              ← you are here
└── LICENSE                — MIT
```

## Architecture

```
   Sender's browser                             Recipient's browser
   ──────────────────                            ─────────────────────
       │                                              │
   ┌───┴───────────────────┐                  ┌───────┴──────────────┐
   │ 1. Encrypt file       │                  │ 5. Decrypt envelope  │
   │ 2. Pay CNOOBS         │                  │ 6. Fetch ciphertext  │
   │ 3. POST /upload       │                  │ 7. Verify sig        │
   │ 4. Emit v4call event  │                  │ 8. Decrypt + render  │
   └───┬───────────────────┘                  └──────────────────────┘
       │                                              ▲
       │ (file bytes)                                 │ (ciphertext bytes)
       ▼                                              │
   ┌─────────────────────┐                            │
   │ ipfs-gate server    │                            │
   │  - verify Hive pay  │                            │
   │  - check quota      │                            │
   │  - pin to Kubo      │                            │
   │  - return CID       │── (cid via gateway URL) ───┤
   └──────────┬──────────┘                            │
              │                                       │
              ▼                                       │
        ┌──────────┐                                  │
        │   Kubo   │── /ipfs/<cid> ───────────────────┘
        │  (local) │
        └──────────┘

   v4call server (separate)
   ────────────────────────
   Only routes the small envelope (CID + per-recipient encrypted keys) over its existing Socket.io room transport. Never sees the file bytes.
```

## Key Design Decisions

1. **Browser-side encryption, always.** ipfs-gate sees only opaque bytes. Plaintext never leaves the sender's device. Decryption happens in the recipient's browser.

2. **v4call server never touches the file.** Browser uploads ciphertext directly to ipfs-gate. v4call only routes a small envelope (CID + encrypted keys). Saves bandwidth, removes a handshake, eliminates a window where v4call has the bytes.

3. **Standalone-from-day-one.** ipfs-gate runs on its own VPS, with its own dedicated Hive account (not shared with v4call). Cleaner debug, separate security blast radius, true to the "ipfs-gate is app-agnostic" architecture.

4. **Kubo only for v0.1; backend interface plugin pattern for later.** Pinata/Filecoin adapters are deferred. Adding them later = one new file implementing the 4-function contract (`pin`, `unpin`, `exists`, `stats`).

5. **Two-phase reserve → commit for quota.** Standard pattern (S3 multipart, R2 signed URLs). Prevents the multi-tab race where a user with 1MB free uploads 900KB from two tabs simultaneously. Reservation tokens are 16-hex random strings with 5-min TTL.

6. **Two distinct signatures, two audiences.** `upload_proof_sig` (sender → ipfs-gate, validates upload matches reservation; discarded after) and `envelope_sig` (sender → recipients, validates the v4call envelope wasn't tampered with). Different concerns, different lifetimes.

7. **Multi-pin-record dedup model.** `pins.cid` is NOT UNIQUE in the schema. Multiple uploaders / multiple uploads of the same content each get their own pin record with their own TTL. Kubo dedups the actual bytes; ipfs-gate accounts per-record. A file stays pinned while any record references its CID.

8. **Encrypted uploads never dedup at the IPFS layer.** Each encryption uses a fresh random AES-GCM key + nonce, producing unique ciphertext → unique CID, even for the same plaintext file. Privacy property is enforced by client-side crypto choices, not by ipfs-gate.

9. **Tx_id binding + balance check (Option C) for payment verification.** Hive-Engine's `transferHistory` API is broken (v4call lesson). Verify by: (1) querying Hive directly for the tx_id of the wrapped custom_json op, (2) confirming the parsed op matches expected sender/recipient/amount/memo, (3) belt-and-braces balance check on escrow after Hive-Engine sidechain processes.

10. **Memo format binds payment to reservation.** `ipfs-gate:upload:<reservation_id>`. Server-minted reservation_id prevents browser-side ID collision or guessing.

11. **CORS `origin: '*'` for v0.1.** ipfs-gate is a public API by design; any web app can hit it. Tighten to allowlist in v0.2 if needed. CORS is not auth — real security gate is Hive signature + payment verification at handlers.

12. **Operator-owned moderation.** Bans + takedowns are per-operator; ipfs-gate gives tools, operator owns policy. No automatic cross-operator ban propagation (avoids red/blue team wars). Operators can manually share blocklist JSON if they want.

13. **Refunds are conservative.** v0.1 auto-refunds only on the disconnect-before-upload case. Wrong-currency / wrong-amount / sidechain-rejected payments go to `orphan` status; operator manually reviews + refunds out-of-band, then calls `/admin/log-refund` to mark + audit.

14. **Federation is opt-in network effect, not coupling.** Each ipfs-gate works standalone. Federation (v0.3+) just unlocks shared blocklists, discovery, pin-by-discovery. Same architectural philosophy as v4call's federated peer mesh.

## Features (planned for v0.1)

### Sender-side (browser, lives in v4call client)
- File picker (jpeg only for v0.1)
- Recipient picker (checkbox list of room members, sender auto-included)
- ipfs-gate URL picker (default + alternatives + custom)
- Encrypt-and-upload button + optional unencrypted-with-warning button
- Cost preview ("≈ 1 CNOOBS for 7 days")
- Hive Keychain transfer for payment
- Two-phase: `/reserve` → Keychain transfer → `/upload`
- Emits `room-attachment` socket event with envelope on success

### Recipient-side (browser, lives in v4call client)
- Inline chat bubble with sender, sig ✓, size, expiry countdown
- Auto-decrypt + render thumbnail for recipients (v0.1 = images only)
- Bystander view: locked bubble showing sender + size + recipient list, no decrypt
- Save-to-device button (Blob URL + anchor download)
- Error states: bad sig / decryption fail / 404 / network error / TTL expired

### Server-side (ipfs-gate)
- POST /reserve, POST /upload, GET /status/:cid, GET /ipfs/:cid (gateway pass-through)
- Admin: ban / unban / takedown / untakedown / uploads-per-account / bans list / takedowns list+import / moderation log / stats / orphan-payments / log-refund
- Sweeper cron (60s): expire reservations + pins, unpin Kubo + GC for CIDs with no active records
- Quota enforcement at reserve time (atomic via `BEGIN IMMEDIATE`)
- Hive payment verification (multi-node fallback, retry with backoff)

## Database Schema (locked v0.1)

Seven tables in SQLite via better-sqlite3:

1. **reservations** — quota holds before payment (state: pending/paid/uploaded/expired/cancelled)
2. **payments** — confirmed on-chain transfers (tx_id UNIQUE = replay protection at schema level)
3. **pins** — multi-pin-record table (cid NOT UNIQUE; status: active/expired/banned/takedown/refunded)
4. **banned_accounts** — banned Hive accounts + refund_policy (none|prorata)
5. **blocked_cids** — taken-down CIDs that can't be re-uploaded
6. **moderation_log** — append-only audit trail
7. **schema_version** — for future migrations

Connection pragmas: `WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`.

Full schema with DDL + indexes + hot-path queries: see plan file at `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md` (section "Database schema — v0.1 LOCKED IN").

## API Endpoints (locked v0.1)

### Public (no auth, CORS origin: '*')
- `POST /reserve` — reserve quota, get reservation_id + payment instructions
- `POST /upload` — upload ciphertext, get back CID (claim kind auto-set: `own_copy` if the CID is already live-hosted, else `original`)
- `POST /check` — Guardian feature: compute the CID (Kubo only-hash, nothing stored/paid) → already-hosted status + own-copy/guardian options
- `GET /status/:cid` — pin status + `already_hosted`/`hosted_until`/`active_hosts`/`guardian_queue_depth`
- `GET /ipfs/:cid` — IPFS gateway pass-through
- `GET /claims/own-copy/quote`, `POST /claims/own-copy` — pay for an independent copy of an already-hosted CID (memo `ipfs-gate:owncopy:<cid>`, no re-upload)
- `GET /guardian/quote`, `POST /guardian/pledge`, `GET /guardian/queue` — the dormant FIFO safety-net (memo `ipfs-gate:guardian:<cid>`); `/backstop/*` = legacy aliases (old memo)

### Admin (Bearer ADMIN_KEY)
- `POST /admin/ban`, `POST /admin/unban`
- `POST /admin/takedown`, `POST /admin/untakedown`
- `GET /admin/uploads?account=X`, `GET /admin/bans`, `GET /admin/takedowns`
- `POST /admin/takedowns/import`
- `GET /admin/moderation/log`, `GET /admin/stats`, `GET /admin/orphan-payments`
- `POST /admin/log-refund` (for manual out-of-band refunds)

Common error response shape: `{ error: 'snake_case_code', message: '...', details: {} }`.

Full endpoint contracts (request/response shapes): plan file section "API endpoint contracts — v0.1 LOCKED IN".

## Wire format (locked v0.1)

### Inner blob (uploaded to ipfs-gate, AES-GCM encrypted)
```
[ 12-byte AES-GCM nonce (plaintext) ]
[ AES-GCM ciphertext of:
    [ 4-byte big-endian length N of header JSON ]
    [ N bytes UTF-8 header JSON: { v, filename, mime, original_size, sender } ]
    [ raw file bytes ]
]
[ 16-byte AES-GCM auth tag (mode-appended) ]
```

### Outer envelope (v4call socket event)
```json
{
  "v": 1, "type": "room-attachment", "room": "...", "cid": "...",
  "size_bytes": N, "sender": "...", "sender_pubkey": "STM...",
  "envelope_sig": "hex", "created_at": "ISO", "expires_at": "ISO",
  "gateway_hint": "https://...", "kind_hint": "image",
  "per_recipient": { "<hive_account>": "<hivecrypt-encrypted K>" }
}
```

### Signatures
- `upload_proof_sig` = sender's Hive sig over `sha256(ciphertext_sha256 + reservation_id + sender)`. Validated at upload, discarded after.
- `envelope_sig` = sender's Hive sig over `sha256(cid + size_bytes + sender + created_at + expires_at + room + kind_hint + sorted_keys(per_recipient).join(","))`. Validated by recipients.

## Hive Payment Verification (locked v0.1)

Three-step recipe (Option C):
1. **Verify on Hive**: query Hive for tx_id via `get_transaction`, find wrapped custom_json with id=`ssc-mainnet-hive`, validate sender + recipient + symbol=CNOOBS + amount + memo
2. **Replay protection**: check tx_id not in payments table (UNIQUE constraint at schema level)
3. **Sidechain confirmation**: wait 5s, check ipfs-gate's CNOOBS balance increased as expected (catches Hive-Engine rejections that don't show on Hive itself)

Memo format: `ipfs-gate:upload:<16-hex-reservation_id>`

Hive node fallback list (reuse v4call's hardened): api.hive.blog, api.deathwing.me, hive-api.arcange.eu, api.openhive.network, techcoderx.com.

## .env Variables

```
# Identity + payment
IPFS_GATE_HIVE_ACCOUNT       — dedicated Hive account for ipfs-gate (NOT shared with v4call)
IPFS_GATE_ACTIVE_KEY         — active private key for refunds (REQUIRED, never log)
ADMIN_KEY                    — password for /admin/* endpoints

# Pricing (v0.1)
PAYMENT_CURRENCY=CNOOBS
PAYMENT_AMOUNT=1
DEFAULT_TTL_DAYS=7
MAX_FILE_SIZE_MB=10

# Backend
BACKEND=kubo
KUBO_API_URL=http://kubo:5001
KUBO_DHT_MODE=none           — none|client|server (default none for private hosting)

# Quota
DISK_LIMIT_GB=5
RESERVATION_TTL_MIN=5
RESERVATION_PER_ACCOUNT_MAX=3

# Network
PORT=3001
BIND_HOST=127.0.0.1
CORS_ORIGIN=*                — v0.1 only; tighten in v0.2

# Hive
HIVE_API=                    — blank = use fallback list
PAYMENT_VERIFY_RETRIES=5
PAYMENT_VERIFY_DELAY_MS=3000
SIDECHAIN_CONFIRM_DELAY_MS=5000
```

## Known Gotchas

### Discovered during ipfs-gate v0.1 first-VPS deployment (2026-05-24)

All also documented in `WalkThrough.wiki` Common Problems with operator-facing fix commands. Listed here for AI-session context.

- **`SQLITE_CANTOPEN` on first boot** = host `data/` dirs owned by root, container is UID 1000. Pre-create dirs + `chown -R 1000:1000 data/` BEFORE first `docker compose up`. Wiki Step 2 does this proactively now. Symptoms can also surface as `EACCES: permission denied, mkdir '/app/data'` or container in restart loop.
- **`BIND_HOST=127.0.0.1` breaks Docker deployment** = ipfs-gate binds to container loopback only; nginx (in a different container) returns 502 Bad Gateway. Default in both `.env.example` and `server.js` is now `0.0.0.0`. Pre-existing `.env` files from earlier installs still need the manual edit.
- **`docker compose restart` does NOT reload `.env` changes** = env vars are baked into the container at create-time. Must `docker compose down && up -d` (or `up -d --force-recreate <service>`) for env-only changes. Parallel to v4call's "down before rebuild" gotcha but a different trigger.
- **`parseInt` truncates fractional days to 0** = pre-v0.1.1 code used `parseInt(DEFAULT_TTL_DAYS)`. Setting `0.001` for testing fast sweeper expiry gave `0` and pins expired immediately. Fixed in v0.1.1 (now `parseFloat`). Test reference: `0.001 day ≈ 1.44 min`.

### Inherited from v4call

- **Hive-Engine `transferHistory` API is broken.** Don't use it. Verify token transfers via balance check on the recipient account combined with tx_id lookup on Hive itself. See v4call CLAUDE.md for the original lesson.
- **Hive-Engine API URL is `/rpc/contracts` not `/contracts`.** The latter returns HTML.
- **`condenser_api.get_discussions_by_created` caps `limit` at 20.** Higher values silently fail with `Assert Exception`. Same applies to other discussion queries.
- **`docker compose down` before rebuilding.** Without this, Docker reuses old containers even after `--no-cache`.
- **Certbot needs `--entrypoint certbot` flag.** Otherwise it runs the renewal loop instead of `certonly`.
- **Nginx cert crash loop.** Don't add HTTPS config before cert exists. Start HTTP-only, get cert, then add HTTPS.
- **iOS Hive Keychain doesn't inject `window.hive_keychain`.** WebKit blocks the extension. Paid actions on iPhone fail; same problem v4call already has. HiveSigner web flow is the workaround. Will surface in v4call client integration of ipfs-gate uploads.
- **`BEGIN` vs `BEGIN IMMEDIATE` in SQLite transactions.** Use IMMEDIATE for any transaction that will write — deferred can deadlock on upgrade.
- **`element.style.display = ''` does NOT override CSS `display:none`.** Use a `.shown` class with `#id.shown { display: ... }` selector instead. v4call learned this the painful way (v0.11 to v0.14.5). Relevant to v4call client integration UI work.
- **CHECK constraints reject typo'd enum values at INSERT time** — catches bugs early. Use them on every status column.
- **Browser cache hides client fixes.** After a rebuild, mobile Safari/Brave can serve old `index.html` for hours. Clear site data on test devices.

## Coding Style

- **Match v4call's patterns.** Same language, same libraries, same idioms — reduces cognitive load when switching projects.
- **No frameworks beyond Express.** Plain functions, plain objects, no DI containers, no ORM (raw SQL via better-sqlite3 prepared statements).
- **Use prepared statements for all SQL.** better-sqlite3 makes this trivial. Never string-interpolate user input.
- **Timestamps as INTEGER unix-ms internally, ISO 8601 strings in JSON responses.** Convert at the response layer.
- **Status enums as strings with CHECK constraints, not integer codes.** Self-documenting; CHECK catches typos.
- **Async/await throughout JavaScript.** No callbacks except where the API forces them (e.g. Express middleware).
- **One module per concern.** server.js for routing, hive-verify.js for Hive, quota.js for DB-level reservations, etc.
- **Dark theme, IBM Plex Mono/Sans for any UI.** Match v4call's visual style if any operator dashboard ships.

## Security Notes

- **Encryption is the client's responsibility.** ipfs-gate cannot enforce that uploaders encrypt. If they upload plaintext, that's their (or their app's) choice. ipfs-gate operates on opaque bytes regardless.
- **Hive payment verification is on-chain.** Strong primitive. Replay protection via tx_id UNIQUE + memo binding to reservation_id.
- **`origin: '*'` is not authentication.** CORS just decides which browsers can read responses. Real auth = Hive sig + payment at handler time.
- **Admin key as Bearer token.** Single key for v0.1 (no per-admin attribution). Multi-admin = v0.2+ if multiple humans operate one instance.
- **Audit log is append-only.** No UPDATE or DELETE statements ever run against `moderation_log`. Enforced by convention; can add a DB trigger in v0.2+.
- **Unencrypted uploads are publicly probable by CID.** Anyone can `GET /ipfs/<cid>` to check existence. This is inherent to running an IPFS gateway. Document in operator README.
- **Operator-controlled escrow account.** Active key in `.env`, never logged. Owner key offline. Same security posture as v4call's escrow.

## What This Project Is NOT

- Not a marketplace
- Not a file-sharing social network
- Not a SaaS pinning service
- Not a Filecoin or Storj wrapper (v0.1)
- Not a v4call-coupled feature — ipfs-gate is app-agnostic; v4call is the first client, not the only one

## Resources

- **Brainstorm scratchpad** (full design history with reasoning): `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md`
- **Sister project v4call**: `/home/noob/CAI/v4call/` + https://github.com/CompleteNoobs/v4call
- **Related project nGate**: `/home/noob/CAI/nGate/` (per-server Nostr keypair model, identity-gated relay pattern; ipfs-gate borrows architectural philosophy)
- **GitHub destination**: https://github.com/CompleteNoobs/ipfs-gate (not yet created)
- **Kubo docs**: https://docs.ipfs.tech/install/command-line/
- **Kubo HTTP API**: https://docs.ipfs.tech/reference/kubo/rpc/
- **Hive API docs**: https://developers.hive.io
- **better-sqlite3 docs**: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md