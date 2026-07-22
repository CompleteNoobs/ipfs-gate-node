# ipfs-gate-node

> ℹ️ **The headless ipfs-gate server** — gateway, pinning, claims, HTTP API. Carved from the
> [ipfs-gate](https://github.com/CompleteNoobs/IPFS-Gate) monolith @`56c0965` (full history
> grafted 2026-07-22; the live monolith deployments are untouched and keep running). In the
> target architecture this node holds **no money key**: refund settlement moves to an isolated
> [escrow-core](https://github.com/CompleteNoobs/escrow-core) deployment (`ipfs-gate-escrow`)
> behind an `ESCROW_MODE` flag, default `in-process` (byte-identical monolith behaviour).
> Build plan: `../decoupling-notes/ipfs-gate-split-plan.md`. The monolith docs below still
> describe the default in-process mode accurately.
>
> **Box mode (`ESCROW_MODE=box`)** — the keyless flip, built Phase 3: read-only payment
> verification stays inline, but every refund becomes a signed claim-settle report to the
> [ipfs-gate-escrow](https://github.com/CompleteNoobs/ipfs-gate-escrow) box over
> escrow-protocol/0.1 (Nostr kind-31337; durable `pending_reports` queue, drainer,
> receipts verified under the pinned `ESCROW_BOX_PUBKEY`). Setup: set `ESCROW_BOX_PUBKEY`
> (the box logs it at boot), REMOVE `IPFS_GATE_ACTIVE_KEY` from this host, add this node's
> logged reporting pubkey to the box's `ESCROW_EXPECTED_REPORTERS`. See `.env.example`
> ("Escrow mode") — note the GUARDIAN_CANCEL_FEE_PCT / MIN_REFUND pairing rule (the box's
> values are authoritative). Single-server combined docker profile: coming in Phase 4.

---

A standalone, Hive-payment-gated IPFS pinning service. Think of it as nGate for IPFS hosting — anyone can run one, anyone can use one, payment and identity are handled via the Hive blockchain.

> ⚠️ **Proof of concept — not for real use.** IPFS-Gate, along with its sister projects [v4call](https://github.com/CompleteNoobs/v4call) and [nGate](https://github.com/CompleteNoobs/nGate), are **proof-of-concept builds by independent builders** — not production software. They are **not safe to use** and **not recommended for general users**. They are provided for developers who want to review the code and are willing to take the risks of an early, quickly-built concept. Treat everything as a demo, not a service.

## What it does

A user encrypts a file in their browser, pays a small fee (CNOOBS for v0.1, multi-currency later), and uploads the ciphertext to an ipfs-gate. The gate pins it to its local Kubo IPFS node for a configurable TTL. Anyone with the CID and the right decryption key can retrieve and decrypt.

Three things make ipfs-gate distinctive:

1. **Hive identity + payment** — uploads are gated on Hive signatures and on-chain payments. No accounts to sign up for, no credit cards, no email verification.
2. **Standalone service** — ipfs-gate doesn't know or care about v4call (or any other app). v4call is just the first client; other apps can use the same ipfs-gate.
3. **Operator-owned + libre** — each operator runs their own server. No central service, no SaaS dependency. MIT licensed.

## The architecture in one diagram

```
[Sender browser]                                [ipfs-gate server]
  - Encrypts file in browser                      - Verifies Hive payment
  - Pays via Hive Keychain    ──HTTPS upload──►   - Pins to local Kubo
  - Gets back a CID                               - Returns CID

[Recipient browser]                             [ipfs-gate gateway]
  - Receives CID + key envelope                   - Serves ciphertext bytes
  - Fetches ciphertext         ──HTTPS GET───►    - (just an IPFS gateway)
  - Decrypts in browser
```

For v0.1, the integrating client is [v4call](https://github.com/CompleteNoobs/v4call). The v4call server routes a tiny envelope (CID + per-recipient encrypted decryption keys) over its existing Socket.io transport. The actual file bytes never touch v4call's infrastructure.

## Status

- **In production** at `https://ipfs.v4call.com/` (concept build; see the proof-of-concept warning above), with its own standalone web interface at `/`. First end-to-end paid encrypted upload landed 2026-05-25.
- **"Private Encrypted Hosting v1" — shipped** (2026-06-16): claim/order model, claim-based MB-hour pricing, release authority, proof-of-receipt, extend/top-up. See [roadmap_status.md](roadmap_status.md).
- **Guardian feature — shipped** (gate 2026-07-02, client UI 07-03→05): multi-participant hosting of one CID — guard an already-hosted file (dormant FIFO safety-net, full refund on dormant cancel) or host your own independent copy without re-uploading; pledge tracking, cancel, and extend in both frontends.
- **Whitelist / family-server mode — shipped + live-tested** (2026-07-04/05): opt-in invite-only gate with per-account quotas, fee-exempt entries, and a second Hive-account admin tier. Operator recipe in [WalkThrough.wiki](WalkThrough.wiki).
- **First-client (v4call) integration — complete and extended**: multi-format attachments, DM attachments, public/plaintext upload-and-share, an uploads-management tab, and a Pinata bring-your-own storage backend (all client-side in v4call).

## Use cases (current and prospective)

- **Encrypted file attachments in v4call rooms** (v0.1)
- **Async voice/video messages between v4call users** (v0.2+, inherits ipfs-gate transport)
- **Cross-server file transfer between federated v4call peers** (v0.2+)
- **Any third-party app needing Hive-paid IPFS pinning** — ipfs-gate is app-agnostic
- **Paid public file sharing** — operator can offer unencrypted public hosting as a tier
- **Future: Filecoin-tier cold storage** via adapter pattern (v0.5+)

## Stack (all libre, all permissive)

- [Node.js](https://nodejs.org/) + [Express](https://expressjs.com/) — HTTP server
- [Kubo (go-ipfs)](https://github.com/ipfs/kubo) — IPFS daemon
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — quota + payment ledger DB
- [Nginx](https://nginx.org/) — reverse proxy, HTTPS termination
- [Docker](https://www.docker.com/) — deployment
- [Hive](https://hive.io/) — identity + payment
- [Hive Keychain](https://hive-keychain.com) — browser-side payment authorization

## License

MIT — see [LICENSE](LICENSE).

## Project context

- **Repository**: https://github.com/CompleteNoobs/IPFS-Gate
- **Author**: CompleteNoobs ([completenoobs.com](https://completenoobs.com))
- **Sister project**: [v4call](https://github.com/CompleteNoobs/v4call) — decentralised paid video/voice/text platform on Hive (first ipfs-gate client)
- **Related project**: nGate (Nostr identity-gated relay; same architectural philosophy)

## Documentation

- [roadmap_status.md](roadmap_status.md) — current progress, locked decisions, staged build plan
- [CLAUDE.md](CLAUDE.md) — project context for AI coding assistants (and humans wanting a deep-dive)
- [PRICING-V1-DESIGN-NOTES.md](PRICING-V1-DESIGN-NOTES.md) — **current** pricing model (claim-based, MB-hour)
- [ipfs-gate-cohosting-backstop.md](ipfs-gate-cohosting-backstop.md) — **current** co-hosting / backstop / refund / moderation model
- [IPFS-Gate-Scale-Plan.md](IPFS-Gate-Scale-Plan.md) — scaling path (Kubernetes)
- [Archive.PRICING-V0.3-DESIGN-NOTES.md](Archive.PRICING-V0.3-DESIGN-NOTES.md) — ⚠️ **archived / superseded** (history only; do not build from it)