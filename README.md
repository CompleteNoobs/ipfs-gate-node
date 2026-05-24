# ipfs-gate

A standalone, Hive-payment-gated IPFS pinning service. Think of it as nGate for IPFS hosting — anyone can run one, anyone can use one, payment and identity are handled via the Hive blockchain.

> **⚠️ Pre-v0.1.** Planning and architecture complete; code not yet written. The first working build will support encrypted jpeg attachments inside [v4call](https://github.com/CompleteNoobs/v4call) rooms. See [roadmap_status.md](roadmap_status.md) for current progress.

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

- **v0.1** (pre-build): planning + architecture **complete**, code not yet written. See [roadmap_status.md](roadmap_status.md).
- **v0.2+**: features sketched but explicitly deferred. See roadmap.

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

- **Repository**: https://github.com/CompleteNoobs/ipfs-gate (will be created)
- **Author**: CompleteNoobs ([completenoobs.com](https://completenoobs.com))
- **Sister project**: [v4call](https://github.com/CompleteNoobs/v4call) — decentralised paid video/voice/text platform on Hive (first ipfs-gate client)
- **Related project**: nGate (Nostr identity-gated relay; same architectural philosophy)

## Documentation

- [roadmap_status.md](roadmap_status.md) — current progress, locked decisions, planned features
- [CLAUDE.md](CLAUDE.md) — project context for AI coding assistants (and humans wanting a deep-dive)