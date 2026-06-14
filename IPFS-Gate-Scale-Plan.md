# IPFS-Gate Scale Plan

> ⚠️ **Proof of concept — not for real use.** IPFS-Gate (with sister projects v4call and nGate) is a **concept design build by independent builders**, *itself* "in active development and not recommended for production." Not safe to use, not recommended for general users — for developers reviewing the code who accept the risks. This doc plans how it would scale; it is not a promise that any of it is production-ready today.
>
> Status: **TALK ONLY — design doc, nothing committed or scheduled.** Written for cold resumption. Tool facts below were re-verified against current sources (June 2026), since the original chat notes were dated.
>
> Standing blocker: **v4call federation is the main quest.** This doc exists so the thinking doesn't get lost.

---

## 0. Fact-check of the tools (verified June 2026)

The original chat advice was directionally right but needed updating:

| Tool | Verified state | Verdict for ipfs-gate |
|---|---|---|
| **Kubo** | Actively developed, latest ~v0.41 (Apr 2026). Now has built-in `ipfs update`, gateway concurrency limits, much faster large-file adds. | ✅ Safe foundation. Keep current; Docker image `ipfs/kubo:release`. |
| **IPFS Cluster** | v1.1.x. **Maintenance mode** — maintained, bugs fixed, but no major new features; dev effort moved elsewhere in the ecosystem. Production-proven at 50M+ pins / 20+ nodes (powered nft.storage & web3.storage). | ✅ Safe to depend on as-is. ⚠️ Don't bet on it growing new capabilities. |
| **IPFS Operator (Kubernetes)** | Officially "in active development and **not recommended for production**" per IPFS docs. | ⚠️ Worth noting: *so are we.* IPFS-Gate is itself a **proof-of-concept / concept design build — also "in active development and not recommended for production."** On that footing the Operator's pre-prod status is not a dealbreaker. **Plan: use Kubernetes for scale** (see Stage 4), eyes open to its maturity. |
| **Pinata** | Still exposes the standard **IPFS Pinning Service API** at `https://api.pinata.cloud/psa` (JWT auth), plus its own native API (pin-by-CID, file upload). | ✅ Pluggable overflow backend is viable. |
| **Filebase** | Also implements the standard Pinning Service API. | ✅ One generic adapter can cover Pinata *and* Filebase. |
| **Pinning Service API spec** | Vendor-agnostic OpenAPI spec; Kubo supports it natively via `ipfs pin remote`. | ✅ This is the seam to build against — not Pinata's proprietary API. |

## 1. Starting point

- v0.1.3 live at `ipfs.completenoobs.com`: one VPS, one Kubo node, 5GB disk, **private DHT**, SQLite ledger, sweeper, nginx, Docker
- Plug-in backend interface in `backends/` — the **4-function contract** is the scaling seam
- Roadmap v0.5+ already names the endgame: Pinata adapter, Filecoin tier, multi-host replication, Cluster integration

The generic advice ends with "build a thin API layer on top of your cluster." **ipfs-gate already is that layer.** Scaling is therefore a backend swap, not an architecture change.

## 2. Three different problems called "scaling"

| Problem | Symptom | Fix |
|---|---|---|
| **Disk pressure** | Kubo repo fills its 5GB | Bigger volume (Stage 0) or overflow adapter (Stage 4) |
| **Redundancy** | Node dies → paid pins lost before TTL | Cluster replication (Stages 1–2) or multi-gate hosting |
| **Throughput** | Too many uploads/fetches for one box | More nodes + load balancing (Stage 2) |

At current usage (≤10MB jpegs, 7-day TTL) only disk pressure is realistic, and the ledger makes it *predictable*: outstanding paid GB-days is a number you can query.

## 3. Triggers (conditions, not dates)

1. **T1 — Disk:** repo regularly >70% of `StorageMax` → Stage 0 first; Stage 4 (overflow adapter) if growth is spiky or the operator doesn't want bigger servers.
2. **T2 — Redundancy demand:** paying users need pins that survive a node failure → Stages 1–2.
3. **T3 — Second operator appears:** that's federation scaling (Section 8), not Cluster scaling.
4. **T4 — "Keep forever" demand:** Filecoin cold tier (Section 7).

---

## 4. The detailed path

### Stage 0 — Vertical + measurement (do-anytime, near-zero risk)

1. Grow the VPS volume; raise Kubo `Datastore.StorageMax` to match (leave OS headroom, e.g. disk minus 20%).
2. Expose numbers the operator can see:
   - `ipfs repo stat` (RepoSize vs StorageMax) — surface via an operator endpoint or sweeper log line each pass
   - Ledger query: SUM of unexpired paid bytes×days = forward storage obligation
3. Write the threshold rule down: "repo >70% → grow disk or enable overflow backend."

This is most of real-world scaling for the next year. Everything below stays parked until a trigger fires.

### Stage 1 — Local IPFS Cluster sandbox (learning, zero production risk)

Goal: turn "words in knowledge" into tested knowledge, on a dev machine.

1. Grab the official 3-node `docker-compose.yml` from the ipfs-cluster repo (3× Kubo + 3× cluster peer).
2. `docker compose up -d`, then drill with `ipfs-cluster-ctl`:
   - `peers ls` — see the cluster form
   - `add testfile --replication-min 2 --replication-max 3` — watch allocation
   - `status <cid>` — per-peer pin state
   - Kill one container → watch re-allocation restore the replication factor
   - `pin add --expire-in 24h <cid>` — **Cluster supports pin expiry natively**; test whether it can replace or simplify the sweeper for cluster pins
3. **The ipfs-gate-specific experiment — two candidate integrations, cheapest first:**
   - **Route P (proxy):** Cluster peers expose an **IPFS Proxy API (port 9095)** that mimics Kubo's API and intercepts pin/add calls, turning them into cluster-wide pins. If `backends/kubo.js` works unmodified when pointed at 9095 instead of 5001, scaling to a cluster is a *config change*, not new code. Test this first.
   - **Route R (REST):** if the proxy has gaps (TTL semantics, pin-status detail), write `backends/cluster.js` against the Cluster REST API (port 9094) implementing the same 4-function contract.
4. Exit criterion: a written note saying which route works and what broke.

### Stage 2 — Production cluster (only if T2 fired)

Topology:
- 2–3 modest VPSes (Hetzner-class). Each runs Kubo + `ipfs-cluster-service` via Docker Compose with persistent volumes.
- **CRDT consensus** (the modern default — no Raft leader headaches), one shared cluster `secret`, `trust_all` off, explicit trusted peer IDs.
- Cluster swarm (9096) and REST/proxy APIs (9094/9095) bound to a **private network/WireGuard** between boxes. Never public.
- `replication_factor_min: 2`, `max: 3`. The **freespace informer** (default) automatically allocates new pins to the peers with most free disk — this is the "rebalancing" from the chat, built in.
- ipfs-gate server stays where it is; its backend points at the cluster (Route P or R). Payments, quota, moderation, sweeper: untouched.
- "Add a node" runbook documented WalkThrough.wiki-style: new VPS → join with secret + bootstrap peer → verify `peers ls` → done. That runbook *is* the scaling procedure.

Gateway/retrieval: nginx can round-robin fetches across the nodes' gateways later; not needed on day one.

#### Self-healing replication (the "min N copies, re-clone on failure" algorithm)

This is Cluster's core feature — never script it by hand:

- `replication_factor_min` / `_max`: cluster-wide defaults in `service.json`, overridable per pin (`--replication-min` / REST `replication_factor_min`). This is the "admin sets min servers per file" knob.
- **⚠️ Gotcha 1:** `disable_repinning` **defaults to `true`** in new configs (since v0.14). A fresh cluster does NOT self-heal. Set `disable_repinning: false` explicitly.
- **⚠️ Gotcha 2 — flapping:** set min < max with leeway (e.g. min 3 / max 5 on a 10-node cluster). With min=max, a peer rebooting for seconds triggers repins, and when it returns its copy gets unpinned (no longer allocated) — churn for nothing. Leeway means only sustained failures heal.
- Detection is heartbeat-driven (peer metric TTLs), so re-replication takes effect when a down peer's metrics expire — minutes, not instant. Pair with the Tier-2 alert "pin under-replicated >N hours" as the backstop.
- **Route consequence:** the proxy shortcut (Route P) only applies cluster-wide default replication. Per-file / per-tier min copies ("host on N nodes" as a paid tier) requires Route R (`backends/cluster.js` on the REST API) so each pin call carries its own factors.
- Bonus: the **tag informer** labels peers (region/provider) and `allocate_by: tag` spreads copies across failure domains — "3 copies on 3 different hosting providers" beats 3 boxes at one host.

### Stage 3 — Monitoring (two tiers, sized to the fleet)

**Tier 1 (single node — do at Stage 0):**
- Disk/pin stats in the operator view (from `ipfs repo stat` + ledger)
- One external watcher on a separate box: **Uptime Kuma** (uptime + HTTP checks) or **Netdata** (single-binary, per-second system metrics, disk alerts out of the box). Either gives "gateway down" and "disk >80%" alerts for ~zero effort.

**Tier 2 (fleet — do at Stage 2):**
- **Prometheus + Grafana + node_exporter** per box.
- Kubo exposes Prometheus metrics at `:5001/debug/metrics/prometheus`; Cluster has a built-in Prometheus endpoint (enable in `service.json` observability config) including pin counts and queue metrics.
- Dashboards: disk per node, pins per node, **pins below target replication factor** (the one that matters), peer count, sweeper activity.
- Alert rules: any pin under-replicated >N hours; any node disk >80%; cluster peer count below expected.

**Skip:** full Prometheus/Grafana for one node. Ceremony without payoff.

### Stage 4 — Kubernetes (the chosen scale path)

**Decision: Kubernetes is the intended path for scaling IPFS-Gate.** The earlier "probably never" stance is retired.

A fair-warning note that cuts both ways: the official IPFS Operator is documented as "in active development and **not recommended for production**." But IPFS-Gate is itself a **proof-of-concept / concept design build — also in active development and not recommended for production** — so we are not holding the Operator to a bar we don't meet ourselves. For a concept build whose whole point is to explore the design, adopting a still-maturing orchestration layer is consistent with the project's stage.

Eyes-open caveats (still true — now things to manage rather than reasons to avoid):
- K8s is a standing ops tax (control plane, storage classes, upgrade churn). For a tiny 2–5 node setup that tax can outweigh the benefit, so Compose + the add-a-node runbook stays the right tool **until** node count or churn makes manual joins genuinely painful.
- Pin-storage nodes are *stateful and deliberate*, not stateless pods autoscaled on CPU — model them as **StatefulSets + PVCs**, not Deployments. Prefer plain StatefulSets first; reach for the IPFS Operator as it matures.
- N copies only buy real safety if the N peers sit on **independent failure domains** — spread peers across hosts/regions or the replication factor promises more than it delivers.

Net: scaling targets Kubernetes; start small on Compose, graduate to K8s (StatefulSets/PVCs first, the Operator as it matures) when a Section 3 trigger demands it.

---

## 5. Pinata / managed-overflow adapter ("extra space quickly, or no big servers at all")

Why: (a) burst capacity when local disk is tight, before a new volume/node lands; (b) an operator profile that runs ipfs-gate with **near-zero local storage** — payments, identity and moderation stay sovereign, bytes are rented.

### Three integration routes

**Route A — Kubo built-in remote pinning (the quick hack).** Kubo natively speaks the Pinning Service API: `ipfs pin remote service add pinata https://api.pinata.cloud/psa <JWT>` then `pin remote add --service=pinata <cid>`. The existing kubo backend could mirror pins to a remote service with a few RPC calls — no new backend file. Good for a first experiment; weak on status/error detail.

**Route B — generic `backends/psa.js` (the right shape).** One adapter against the vendor-neutral Pinning Service API spec → works with Pinata, Filebase, and any future compliant provider by changing endpoint + token. Maps cleanly onto the 4-function contract (pin = POST /pins, status = GET /pins/{id}, unpin = DELETE). This honours the libre philosophy: no vendor lock-in in code.

**Route C — provider-native byte upload.** Gate POSTs the ciphertext directly to the provider's upload endpoint (e.g. Pinata file upload), provider returns the CID. Most reliable delivery, but provider-specific code.

### ⚠️ The gotcha the chat couldn't tell you: private DHT vs remote pinning

Routes A/B work by the provider **fetching the bytes from the IPFS network** — their delegate nodes look up the CID and pull it from your node. ipfs-gate's locked v0.1 deployment runs a **private DHT**, so Pinata/Filebase *cannot find or fetch anything from it*. Options, in rough preference order:

1. **Route C for overflow** — push bytes, no discoverability needed, private DHT stays. Simplest mental model.
2. Hybrid: keep private DHT, but on overflow-pin, directly `swarm connect` to the provider's returned `delegates` multiaddrs and announce `origins` in the PSA request — targeted connectivity without joining the public DHT. (Needs testing; this is exactly the kind of unknown the Stage 1 sandbox should answer.)
3. Re-join the public DHT — rejected by default; it was made private for a reason (resource use, exposure).

Note: privacy is *not* the issue — everything pinned is ciphertext; a third-party provider holding AES-GCM blobs learns nothing but size and timing. The issue is purely reachability.

### Ledger + sweeper integration

- **TTL:** managed pins never expire on their own. The sweeper must call the provider's unpin/delete when a pin's TTL ends, or the operator pays for dead ciphertext forever. Sweeper needs per-backend unpin — the 4-function contract already implies this.
- **Pricing:** provider charges ~monthly per GB; convert to a GB-day cost, add operator margin, feed the same CNOOBS rate math (RATE_FLOOR lessons from v4call apply). Overflow pins can simply cost users more — honest signal of real cost.
- **Failure honesty:** if a provider pin fails, the existing auto-refund path applies unchanged. Good test that the contract abstraction is real.

### Provider shortlist

- **Pinata** — first target, PSA-compliant, mature
- **Filebase** — PSA-compliant + S3-compatible interface, second target proving Route B's generality
- **Storacha** (web3.storage successor) / 4EVERLAND — evaluate when relevant; APIs differ more

## 6. Tier model an operator ends up with

One gate, per-pin backend choice driven by price/TTL tier:

| Tier | Backend | Use |
|---|---|---|
| Hot | Local Kubo / Cluster | Default; fast, sovereign |
| Overflow | PSA adapter (Pinata/Filebase) | Disk pressure, low-ops operators |
| Cold | Filecoin adapter | "Keep forever" (Section 7) |

All behind the same 4-function contract; payments/moderation identical across tiers.

## 7. Filecoin cold tier (brief — roadmapped v0.5+)

Hot copy on the gate for retrieval; Filecoin deal for persistence. Natural pairing with donate-to-extend ("extend past N years → tips into cold tier"). Known friction: minimum deal sizes likely force **batching many small ciphertexts into one deal**, which tangles per-pin refunds and takedowns — a takedown inside an immutable sealed deal can only be honoured at the gateway layer, not the storage layer. Park until T4; re-survey the onramp landscape then (it churns: web3.storage → Storacha, etc.).

## 8. The alternative that fits the philosophy: scale out, not up

The chat assumes one operator building a bigger pool (the Pinata model). ipfs-gate's stance ("operator-owned, no central service") suggests the opposite:

- Many cheap single-node gates run by independent operators
- **v0.4 pin-by-discovery** = inter-gate replication without re-upload (gate B fetches bytes, verifies CID, charges to pin)
- **"Host on N gates"** = redundancy bought across *independent* operators — strictly stronger than N copies inside one operator's cluster (no single admin, jurisdiction, or billing failure)
- v0.3 Nostr discovery becomes the marketplace: "which gates will host this CID, at what price?"

In that world, Cluster is a power-operator's internal tool and the PSA adapter is a small operator's crutch — but the *network* scales by more roots, not bigger ones. If effort must be allocated, this likely beats cluster-of-nodes for what ipfs-gate is trying to be. (Same reachability caveat: pin-by-discovery between gates also collides with private DHTs — gates may need targeted `swarm connect` between themselves, which the federation layer can broker.)

## 9. Honest unknowns

- Does Cluster's **proxy API (Route P)** satisfy the existing kubo backend unmodified — esp. TTL/expiry and pin-status semantics?
- Does Cluster's native `expire-at` cleanly replace sweeper logic for cluster pins, or do ledger and cluster expiry need reconciling?
- Does the **delegates/origins handshake (hybrid option 2)** actually let a private-DHT node feed a PSA provider? Needs a live test.
- CID consistency on Route C: does provider-side adding (chunking defaults) always reproduce the CID the gate computed locally? If not, take the provider's CID as canonical for overflow pins, or pin-by-CID after a temporary local add.
- Cluster maintenance-mode risk horizon: fine today; what's the fallback if it goes unmaintained in 3 years? (Likely answer: it's MIT, stable, and the federation path reduces dependence anyway.)
- Pricing precision for replication/overflow tiers in CNOOBS without a floor mess.

---

*Parked. Main quest: v4call federation. Resume when a Section 3 trigger fires — not before.*
