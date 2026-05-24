# ipfs-gate — Roadmap & Status

> Updated 2026-05-23. Source of truth: this file + [CLAUDE.md](CLAUDE.md).
> Full design history + reasoning lives in the brainstorm scratchpad at
> `/home/noob/.claude/plans/question-i-have-you-groovy-hickey.md`.

## Current status

**Pre-v0.1 — planning complete, code not yet written.**

All five pre-build blockers cleared:

| # | Blocker | Status | Where decided |
|---|---|---|---|
| B1 | Repo layout | ✅ Locked | `~/CAI/IPFS-Gate` → `github.com/completenoobs/ipfs-gate` |
| B2 | Database schema | ✅ Locked | 7 tables, indexes, hot-path queries; see CLAUDE.md |
| B3 | API endpoint contracts | ✅ Locked | 14 endpoints with full request/response shapes; see CLAUDE.md |
| B4 | Reservation token format | ✅ Locked | 16-hex random + DB lookup, 5-min TTL |
| B5 | Hive payment verification | ✅ Locked | Option C: tx_id lookup + balance-check belt-and-braces |

**Next step**: `git init`, write code.

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

## Pre-build nice-to-haves (not blocking, can be done during build)

| Item | Notes |
|---|---|
| Recipient-side error/edge cases in deeper detail | Sketched in CLAUDE.md, can refine during build |
| Reservation token cleanup fine details (partial Kubo pin cleanup, etc.) | Edge case handling during sweeper development |
| Kubo Docker config tuning | Storage limits, swarm peers, GC policy |
| v4call sender modal UI sketch | HTML/CSS for the upload picker — done v4call-side |
| Testing strategy | Manual smoke test minimum for v0.1; automated test suite v0.2+ |
| Operator first-boot flow | Helper install script vs docs-only |

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

## Pre-flight checklist (before `git init`)

- [x] Repo path decided (`~/CAI/IPFS-Gate`)
- [x] GitHub destination decided (`github.com/completenoobs/ipfs-gate`)
- [x] License decided (MIT)
- [x] Database schema spec written
- [x] API contracts spec written
- [x] Hive payment verification recipe written
- [x] Reservation token format decided
- [x] Wire format (envelope + inner blob) decided
- [x] Recipient UX decided
- [x] Deployment topology decided (separate box)
- [x] Moderation primitives spec'd
- [x] README.md, roadmap_status.md, CLAUDE.md scaffolded
- [ ] `git init` + initial commit
- [ ] `package.json` + `npm init`
- [ ] Project skeleton (server.js, backends/kubo.js, quota.js, hive-verify.js, sweeper.js, moderation.js)
- [ ] First passing test (Hive payment verify against a real test tx)
- [ ] First successful encrypt → upload → pin → fetch → decrypt round-trip on localhost