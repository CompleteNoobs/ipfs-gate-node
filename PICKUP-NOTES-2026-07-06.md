# ipfs-gate — Pick-up notes (paused 2026-07-06, returning later)

> **Purpose:** ipfs-gate work is PAUSED to return to the main quest (v4call
> federation). This file is the single re-entry point for the next ipfs-gate
> session: state at pause, the open bug with debug leads, the two feature
> threads the owner wants minded (skip-check option, large-file chunking),
> where the surviving federation data lives, and every other open item.
> Read this first; follow pointers only as needed.

---

## 1. State at pause (what just shipped, all on `main`)

| Commit | Repo | What |
|---|---|---|
| `eaac039` | IPFS-Gate | **Byte-range/seek on `GET /ipfs/:cid`** — 206/416, `Accept-Ranges`+`Content-Length` everywhere, HEAD short-circuit, `range.js` + 13 tests. **✅ LIVE-TESTED by operator 2026-07-06 — video scrubbing works.** |
| `bd05789` | IPFS-Gate | `/reserve` hard-rejects over-app-cap `size_bytes` BEFORE payment ("do not pay", 413). Wiki Common-Problems entry: nginx `client_max_body_size` must move together with `MAX_FILE_SIZE_MB`. |
| `bf434f1` | IPFS-Gate | Frontend (`public/index.html`): `gateCapKnown` + `ensureGateCap()` — the 10MB boot fallback is never enforced/displayed as the gate's cap; checks re-fetch gate info at press time. |
| `e9b75f8` | v4call-app | Same `gateCapKnown` fix ported to `desktop-app.html` + `mobile-app.html` (ipfs-gate backend only; Pinata untouched). |

**Server (`/opt/IPFS-Gate` on ipfs.v4call.com):** had pulled `bd05789` at last
check; nginx `client_max_body_size` raised from 12M (operator applied it —
30MB uploads work, byte-range live-confirmed). `.env`: `MAX_FILE_SIZE_MB=1000`,
TEST token, operator changed the fee rate (don't trust old rate numbers in
transcripts). 94 tests green at pause.

**Two orphaned TEST payments in escrow** (from the 413-era and the open bug
below — never recorded in the gate DB, will NOT show in /admin/orphan-payments;
refund via Keychain manually or ignore, it's TEST):
- tx `4625c8118f020bc5a8ba38c0c46b81d857ae4a96` (125MB vs nginx-12M, 2026-07-05)
- tx `a1fdf482b2d8c037e04845924955ebd02d16dced` · reservation `e61c093defe3a315` (the §2 bug)

---

## 2. OPEN BUG — large upload dies mid-transfer ("Failed to fetch")

**Symptom (2026-07-06):** public upload of a **125MB** file via the standalone
page → client shows `⚠ upload failed (Failed to fetch)` AFTER payment
broadcast. **30MB works fine.** Same 105MB file → Pinata via v4call works;
250MB → Pinata works. So the browser/client side handles big files fine — the
failure is in the gate path (nginx → node/multer → Kubo).

`Failed to fetch` = the POST /upload connection DIED (network-level), not an
HTTP error status. The nginx 12M cap was already fixed at this point (30MB
passes, and the old cap gave a clean 413, not a dropped connection).

**Ranked suspects, and how to check each (next session, on the server):**

1. **Node container OOM-kill.** `/upload` holds the whole file in RAM
   (multer memoryStorage) and `backends/kubo.js pin()` copies it AGAIN into a
   `Blob` for FormData → ≥2×125MB in the node heap, on a 2GB VPS that also
   runs Kubo + nginx. Check: `docker inspect ipfs-gate --format '{{.State.OOMKilled}} {{.RestartCount}}'`,
   `dmesg -T | grep -i oom`, `docker logs ipfs-gate --since 48h | tail -50`.
   If confirmed → real fix is §3 streaming (or an interim honest cap ~200MB).
2. **nginx proxy timeout.** Deployed conf has `proxy_read_timeout 120s` /
   `proxy_send_timeout 120s`. After the body lands, /upload does Hive verify
   (multi-node, retries) + sidechain confirm (5s+) + Kubo add of 125MB — if
   the app goes >120s with no bytes to nginx, nginx kills the connection.
   Check: nginx container logs for `upstream timed out` at the failure time.
3. **`KUBO_TIMEOUT_MS` (default 60000).** `kuboFetch` aborts the /api/v0/add
   at 60s. Adding 125MB locally should be seconds, but on a loaded 2GB box
   with GC pressure, maybe not. This would give a JSON 502 (not a dropped
   socket) — LESS likely to look like "Failed to fetch", but if logs show
   `Kubo /api/v0/add HTTP` errors or AbortError, this is it. Fix: raise, or
   scale timeout with size.
4. Client-side second-transfer confusion: remember the file crosses the wire
   TWICE for public uploads (§4 — /check uploads the full file first). The
   error came after payment so the fatal one was the real /upload, but any
   fix should think about both legs.

**Repro recipe:** upload a >100MB public file from the standalone page while
running `docker stats` + tailing both containers' logs. The three suspects
leave three different fingerprints (OOMKilled=true / nginx upstream-timeout
line / Kubo abort in app log).

---

## 3. Large files properly: streaming vs chunking (owner wants this minded)

**Search result (2026-07-06, whole ~/CAI + ~/.claude searched): there is NO
written plan for splitting large files.** The owner half-remembered one; what
actually exists is only:
- `roadmap_status.md` → v0.1 "does NOT do" + v0.2 futures: one-line backlog
  item **"Streaming uploads for files >100MB"** (no design behind it).
- `BYTE-RANGE-DESIGN-NOTES.md` §7: chunked ENCRYPTION (encrypt-per-segment)
  flagged out-of-scope as the future path to seekable/streamable encrypted
  media. An idea line, not a plan.

Two distinct problems — don't conflate when designing:

**(a) Server-side streaming (smaller, fixes §2 root cause):** stop buffering
uploads in RAM. multer diskStorage (or busboy stream) → stream the file into
Kubo `/api/v0/add` (its multipart body accepts a stream) → hash-on-the-fly
for `upload_proof_sig` verification. No wire-format change, no client change,
no protocol version. Removes the RAM ceiling AND the OOM suspect. This is the
one to do first.

**(b) Client-side split into N pieces (the "chop into 100MB sections" idea):**
a real feature design — manifest format (list of piece CIDs + order + sizes),
one claim covering N pins (or N claims + a bundle), reassembly on fetch
(gateway-side concat vs client-side), per-piece encryption (which THEN gives
seekable encrypted media — ties into byte-range doc §7), resumable uploads as
a bonus. Deserves its own `*-DESIGN-NOTES.md` like byte-range got, written
AFTER (a) ships and proves what the remaining need actually is. Note browser
RAM is a genuine second reason for (b): the client also holds the whole file
(`file.arrayBuffer()`) — and encrypts it whole on the private path.

---

## 4. UX item — public upload's "already hosted?" check must become optional

Owner's request 2026-07-06. Correction to how it was remembered: the check
doesn't just hash locally — **`POST /check` uploads the ENTIRE file to the
gate** (client `gateCheckAlreadyHosted(file, …)` → server multer → Kubo
only-hash). So a 125MB public upload transfers 125MB TWICE. Slow, and the
user may not care about the dedup offer.

Wanted: a user-facing choice on public upload — e.g. a "check first" toggle
(default ON below some size, OFF/ask above it), or an "Upload without
checking" button next to the normal one. The plumbing already exists:
`confirmPublicUpload(skipHostedCheck)` already takes the skip flag (it's used
by the hosted-panel's "Upload anyway"); this is mostly UI + a size heuristic.

Better long-term fix: compute the CID **client-side** (no upload at all) —
must reproduce Kubo's exact flags (`cid-version=1, raw-leaves=true`, default
chunker) or the CIDs won't match; `POST /check` would then take a bare CID
(`GET /status/:cid` already answers already-hosted for a CID). Verify
identical-CID on several sizes before trusting it.

---

## 5. Federation — where the surviving data lives (⚠ two source docs LOST)

**The owner remembers "a basic fed plan" — it existed and its SUMMARY
survives, but the two documents holding the full design are GONE:**
- `v4call-ipfs-gate-build-handover.md` — referenced by CLAUDE.md,
  roadmap_status.md, PRICING-V1 §12, cohosting doc (as "handover §6/§9/§12/
  §15" — §15 was the federation/settlement section). Never committed to git;
  file no longer exists anywhere on disk (whole-home search 2026-07-06).
- `~/.claude/plans/question-i-have-you-groovy-hickey.md` — the brainstorm
  scratchpad with every v0.1 decision's reasoning. Also gone.
**CLAUDE.md still points at both — those pointers are stale.** Any "see
handover §N" reference now resolves to nothing; the design must be
reconstructed from the fragments below when federation work starts.

**Surviving fragments (ALL of the known fed thinking, latest first):**
1. `roadmap_status.md` → **"v2 — Federation (designed, DO NOT build yet)"**:
   claim model widened one level ("owner holds a claim on a CID" → "gate
   hosts a CID"). Three genuinely-new problems: **settlement** (money between
   operators), **verification** (proving a gate holds bytes — Stage 6
   receipts prototype this in reverse), **repair** (cross-operator
   self-heal). Storefront custodies escrow; principle: **"pay for the gap,
   not the overlap."**
2. `IPFS-Gate-Scale-Plan.md` §8 — the philosophy: **scale out, not up**. Many
   cheap single-node gates; v0.4 pin-by-discovery = inter-gate replication
   without re-upload (gate B fetches bytes, verifies CID, charges to pin);
   "host on N gates" beats N copies in one operator's cluster; v0.3 Nostr
   discovery becomes the marketplace ("which gates will host this CID, at
   what price?"). Caveat: private DHTs → gates need brokered `swarm connect`.
   Trigger T3 = a second operator appears.
3. `PRICING-V1-DESIGN-NOTES.md` — the **order/claim split IS the v2
   federation seam** (§ comparison table + §12: cross-operator settlement
   deferred, was handover §15). Seams already shipped at degenerate v1
   values: order/claim split, `copies`, `kind`/`state`, `rate_locked`.
4. `roadmap_status.md` v0.3/v0.4 backlog — Nostr operator discovery, opt-in
   cross-operator banlist publish/subscribe, pin-by-discovery.
5. `CLAUDE.md` design decision #14 — federation is opt-in network effect, not
   coupling; every gate fully standalone; no automatic ban propagation.

**Standing blocker (Scale-Plan header, still true): v4call federation is the
main quest — ipfs-gate fed resumes only after that, or when T3 fires.**

---

## 6. Other open items (unchanged, don't lose)

- **⚠ Security:** fee-exempt `/upload` doesn't bind `uploader_pubkey` to the
  account's real on-chain posting key → free-tier whitelisted accounts can be
  uploaded-under by anyone. Fix sketch: when `isFeeExempt`, require pubkey ∈
  account's posting keys (same check `/uploads/by-user` already does).
- **RAM sizing:** multer memoryStorage means ~1×filesize per in-flight upload
  server-side (2GB VPS!) — superseded by §3(a) when built; until then keep
  `MAX_FILE_SIZE_MB` honest (≤200 on the current box).
- **mobile-app.html** (v4call-app) has NONE of the guardian/whitelist UI
  (deliberate scope cut; desktop is full). The `gateCapKnown` fix IS in both.
- Byte-range v1.1 candidates (from the design doc, only if players need
  them): `ETag: "<cid>"` + `If-Range`.
- Docs convention reminder: deploy-time surprises → `WalkThrough.wiki`
  "Common problems" (symptom-first); build records → `roadmap_status.md` +
  CLAUDE.md status line.

## 7. Suggested pick-up order for the next ipfs-gate session

1. Diagnose §2 on the server (three fingerprint checks — 15 minutes).
2. Build §3(a) server-side streaming (probably closes §2; re-test 125MB+).
3. Ship §4's skip-check toggle (small, standalone-page + v4call port).
4. Harden the fee-exempt pubkey binding (§6, small).
5. Only then consider §3(b) chunking design notes — informed by what (a)
   did and didn't solve.
