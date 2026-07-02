# ipfs-gate-node

The **headless ipfs-gate server** — gateway, pinning, claims, and the HTTP API. **Holds no money key** (escrow
moves to an **escrow-core** deployment, e.g. `ipfs-gate-escrow`).

- **Version:** 0.1.0
- Succeeds the monolith **ipfs-gate** (final version **v0.1.3**, v1 Stages 0–6 complete, 43 tests green),
  carved out per the decoupling plan (minus escrow).
- **Source of truth:** [`../handover-decoupling.md`](../handover-decoupling.md)

> Status: scaffold. Carved from the ipfs-gate monolith during the decoupling build (hand-off doc, build sequence §11).
