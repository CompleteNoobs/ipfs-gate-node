# MP3 (and multi-format) support — ipfs-gate v0.2 options

> Research + recommendation only. No code changed. Investigated against
> ipfs-gate as committed at `3f2a4a8` (v0.1.x). Audience: noob (project
> owner). Companion to `feature_plans/mp3-room-attachment-briefing.md`
> on the v4call side .

---

## TL;DR — the headline finding

**The gate does not enforce JPEG. It does not enforce any MIME type at
all.** There is no MIME parameter anywhere in `/reserve` or `/upload`,
no Content-Type check, no magic-byte sniff. The gate only ever sees and
checks:

1. `size_bytes` (against a single `MAX_FILE_SIZE_MB`, default 10 MB),
2. the on-chain payment (flat `PAYMENT_AMOUNT` per upload, not per byte),
3. the uploader's Hive signature over the ciphertext hash,
4. per-account reservation count + disk quota + ban/blocklist.

The "JPEG only" rule is **100% a v4call client-side decision** — the
`accept="image/jpeg"` attribute on the file picker. The gate would
happily pin an MP3, an MP4, a zip, or random noise today, unchanged.

**Consequence:** MP3 support needs **zero gate-side code** to *function*.
v4call could flip `accept="image/jpeg,audio/mpeg"` and add the `<audio>`
renderer tomorrow and it would work against the gate exactly as it is —
*provided the MP3 fits under the current 10 MB cap.*

So this report is really about two separate questions:
- **What must change for MP3 to work?** → Nothing (except maybe raising
  the size cap). It's a v4call-only change.
- **What *should* change so the gate is an honest, operator-configurable
  policy point for the full v0.2 taxonomy?** → A modest, optional set of
  additions (allowlist claim, per-category size, audit fields). None are
  strictly required; all are "do it once, never re-architect."

---

## Current state — what the gate does today, point by point

### 1. Where is the JPEG-only check?
**Nowhere.** There is no such check.
- `POST /reserve` body is validated at [server.js:148-149](server.js#L148-L149):
  it accepts **only** `{ uploader, size_bytes }`. No `mime`, no `kind`,
  no filename.
- `POST /upload` multipart fields are `reservation_id`, `tx_id`,
  `uploader_pubkey`, `upload_proof_sig`, `ciphertext` ([server.js:178-187](server.js#L178-L187)).
  **No filename and no declared MIME are transmitted at all** — multer
  reads the file into a memory buffer and the original filename is
  discarded.
- The only content gate is size (next point). The gate is a pure
  pay-to-pin CDN. v4call's `kind_hint` lives in the *outer signed
  envelope* that v4call passes peer-to-peer over its own socket — the
  gate never sees it.

**Rejection error v4call would see** if you tried to bypass the (non-existent)
MIME rule: there is none to bypass. The only relevant rejections are
size (`payload_too_large`, 413) and payment (`unprocessable_entity`, 422).

### 2. How does the gate know it's getting "the right thing"?
**Model in place: "None — pure pinning role."** The gate stores
ciphertext bytes and trusts the client. It *cannot* sniff plaintext
(it's AES-GCM ciphertext) and it doesn't try. Security implication of
adding audio: **unchanged**, because nothing about MIME is enforced
today. The risk surface is identical whether the bytes decrypt to a
JPEG, an MP3, or anything else — the gate can't tell and never could.

The real protections that *do* exist and don't depend on content:
per-account reservation cap (`RESERVATION_PER_ACCOUNT_MAX=3`),
Hive-signed upload proof (only real Hive accounts can upload),
paid-per-upload (spam costs money), disk quota, ban/takedown.

### 3. Size limits
- **Single constant**: `MAX_FILE_SIZE_MB` (default 10), env-overridable
  ([quota.js:17-18](quota.js#L17-L18), [server.js:33-34](server.js#L33-L34)).
- Enforced **twice**: at `/reserve` in `createReservation`
  ([quota.js:121-126](quota.js#L121-L126), throws `payload_too_large`)
  and at `/upload` (multer `limits.fileSize` + an explicit check at
  [server.js:191-193](server.js#L191-L193) and a reservation-size check
  at [server.js:205-207](server.js#L205-L207)).
- It **is** a configurable env var, not hardcoded. Good.
- **Pricing does NOT scale with size.** It's a flat `PAYMENT_AMOUNT`
  (default `1`) per upload regardless of bytes ([server.js:29](server.js#L29),
  [server.js:157-164](server.js#L157-L164)). A 1 KB file and a 10 MB
  file both cost 1 CNOOBS. There is no per-byte rate anywhere.

### 4. Pin retention + payment math
- **Flat TTL**: `DEFAULT_TTL_DAYS` (default 7), env-overridable, applied
  uniformly at pin creation ([quota.js:227-235](quota.js#L227-L235)).
  Sweeper expires + unpins past TTL ([quota.js:283-313](quota.js#L283-L313),
  `sweeper.js`).
- **Payment math sanity check** (the briefing asks about a 5 MB MP3 vs a
  1 MB JPEG): under the current flat model they cost **exactly the same
  — 1 CNOOBS each.** There is no per-byte rate to get "wrong." The MP3 is
  effectively 5× cheaper per byte than the JPEG. That's fine for v0.2
  but worth the operator knowing: bigger allowed files = more storage
  per CNOOBS earned. If you raise the cap to allow video (100 MB+), a
  single CNOOBS buys 100 MB of 7-day storage. That may be under-priced.

### 5. Response headers on GET
- `/ipfs/:cid` **always** returns `Content-Type: application/octet-stream`
  ([server.js:392](server.js#L392)) plus a `Cache-Control` from
  `GATEWAY_CACHE_MAX_AGE`. This is correct and needs **no change** for
  audio — the bytes are ciphertext; the real MIME is inside the encrypted
  blob and v4call's client sets the right type on the decrypted
  `objectURL`. Confirmed.

### 6. Operator config for content policy
- **There is no content/MIME allowlist config at all** — there's nothing
  to make configurable because nothing is checked. Size *is* already
  env-driven. So "make it configurable" here means "add a new optional
  allowlist mechanism," not "un-hardcode an existing one."

### 7. `mime` + `kind` claim at `/reserve`
- **Not present.** `/reserve` takes only `uploader` + `size_bytes`. No
  audit trail of what was claimed. `/admin/uploads` ([server.js:490-516](server.js#L490-L516))
  can show CID, size, payment — but nothing about declared type.

### 8. `BLOCKED_EXTENSIONS`
- **Not present, and the gate never receives the filename** (point 1),
  so there's nothing to check an extension against today. Adding this
  requires v4call to *start sending* a claimed filename/MIME at
  `/reserve` (which it currently does not).

---

## The minimum change to support MP3

**Gate side: none required.** If the only goal is "MP3 works," the gate
already accepts it. The single thing to verify is the **size cap**:
default `MAX_FILE_SIZE_MB=10` is plenty for short voice notes and most
song-length MP3s at 128 kbps (~10 min). If you want longer/higher-bitrate
audio, bump `MAX_FILE_SIZE_MB` in `.env` — a one-line config change, no
code, no rebuild logic beyond the standard `docker compose down/up`.

Everything else (the `/audio` renderer, the file-picker `accept`, the
`mimeToKind` table) is v4call-side, exactly as the briefing's Phase 1
describes.

---

## The well-designed v0.2 change (recommended, optional)

This is the "do it once for all of phases 1–7" version. It does **not**
make MP3 work (it already does); it makes the gate an **honest,
auditable, operator-configurable policy point**. Four small additive
pieces, all backward-compatible:

### (a) Optional claimed `mime` + `kind` at `/reserve` — audit + policy hook
Add two optional body fields to `/reserve`: `mime` (claimed plaintext
MIME) and `kind` (v4call's kind_hint). Store them on the `reservations`
row (migration `002`: two nullable TEXT columns). The gate **cannot
verify** them (ciphertext), and that's stated honestly — but:
- They give operators an audit trail (`/admin/uploads` can surface
  "claimed audio/mpeg").
- They become the enforcement point for (b) and (c).
- v4call passes them based on its own client-side validation (~5 lines).

Backward-compatible: if absent, behave exactly as today.

### (b) Optional `ALLOWED_MIMES` env allowlist — checked against the *claim*
`ALLOWED_MIMES` env (comma-separated). If set, `/reserve` rejects when
the claimed `mime` isn't in the list (`bad_request` / `unprocessable_entity`).
If **blank/unset → allow everything** (preserves today's behaviour and
keeps the gate a permissive CDN by default). Default-ship the v0.2 set
from the briefing **minus `image/svg+xml`** (correctly — SVG inline
render is v4call's problem, and download-only SVG arrives as `kind:'file'`
needing no gate awareness).

Honest caveat to put in the docs: this gates the *claim*, not the bytes.
A lying client can still upload anything by claiming an allowed MIME. Its
value is (1) audit, (2) stopping honest clients/UX from sending types the
operator doesn't want, (3) a defensible "we asked, here's the log" trail.

### (c) Size limits — **Option A (single cap) recommended over Option B**
The briefing offers A (one `MAX_FILE_SIZE_BYTES`) vs B (per-category
caps). **Recommend A for v0.2** because:
- The gate's whole size machinery is built around one number, checked in
  3 places + multer. Per-category (B) means threading a category through
  `/reserve` → reservation row → `/upload` re-check, plus deciding what
  to do when the claimed category and size disagree. Real complexity for
  modest gain while v4call is the only client.
- The flat-fee pricing model (point 4) already means "all types cost the
  same," so per-category *caps* without per-category *pricing* is a
  half-measure.
- A is honest and simple: pick one cap big enough for the largest type
  you want to allow.

If you later want video, the clean upgrade is **per-category pricing +
caps together** (a bigger v0.3 item), not per-category caps alone.

Either way: **expose the limits + allowlist on the `GET /` endpoint** so
v4call can render "max X MB, types: …" in the picker without hardcoding.
Currently `/` already returns `max_size_mb` and payment info
([server.js:132-139](server.js#L132-L139)) — just add `allowed_mimes`
(and per-category map if you ever do B). This is the single most useful
gate-side change for v4call UX, regardless of everything else.

### (d) Optional `BLOCKED_EXTENSIONS` env — fold in, don't over-build
Recommend **deferring a dedicated extension blocklist**. Rationale: the
gate doesn't receive filenames today, and the cleaner lever is (b)'s MIME
allowlist — simply **don't put `application/octet-stream` or
`application/x-msdownload` etc. in `ALLOWED_MIMES`**. If a future
operator genuinely needs extension-level blocking *within* an allowed
MIME (e.g. allow `application/zip` but block `.zip` containing `.exe` —
which the gate can't see anyway), that's a v0.3 conversation. For v0.2,
MIME-allowlist strictness covers the realistic cases.

---

## Recommended path

**Two-track, decoupled:**

1. **Ship MP3 now, gate untouched.** Because the gate is content-agnostic,
   v4call's Phase 1 (file-picker `accept`, `mimeToKind`, `<audio>` bubble)
   works against the *current* gate with no version bump on the gate side.
   The only gate action is a `.env` review: keep `MAX_FILE_SIZE_MB=10` or
   raise it if you want longer audio. This unblocks Phase 1 immediately.

2. **Do the "well-designed v0.2" as a separate, unhurried gate release** —
   pieces (a) audit fields, (b) `ALLOWED_MIMES` (default permissive),
   (c) keep single size cap but **expose allowlist + caps on `GET /`**.
   This is the "once" change that makes the gate a real policy point and
   feeds v4call's picker UI. It's additive and backward-compatible, so it
   can land before *or* after v4call Phase 1 without breaking anything.

**Deferred:** per-category size caps (Option B), per-byte/per-category
pricing, dedicated `BLOCKED_EXTENSIONS`. Revisit when (i) a second client
exists, or (ii) you allow video and the flat-fee economics start to
matter.

**Why this ordering:** the briefing assumed the gate was the gating
dependency ("v4call will NOT start Phase 1 until ipfs-gate supports
audio/mpeg"). That assumption is **false** — the gate already supports it.
So Phase 1 is unblocked today, and the gate work becomes a quality/policy
improvement you do on its own schedule, not a blocker.

---

## Open questions for the user (noob)

1. **Size cap for audio.** Keep `MAX_FILE_SIZE_MB=10` (fine for voice
   notes + short MP3s) or raise it? At flat 1-CNOOBS pricing, a bigger
   cap = more storage sold per CNOOBS. What's the largest single
   attachment you want to allow in v0.2?

2. **Default `ALLOWED_MIMES`: permissive or curated?** Two philosophies:
   (a) ship blank = allow anything (current behaviour, max flexibility,
   honest "we're a CDN"), or (b) ship the briefing's curated list so the
   default gate is opinionated about what it pins. I lean **(a) blank
   default + document the recommended curated list in `.env.example`** so
   operators opt in. Your call — it's a policy stance.

3. **Is the audit trail (claimed `mime`/`kind` on the reservation) worth
   the migration now, or YAGNI until a second client exists?** It's cheap
   (~30 lines + a migration) and it's the hook everything else hangs on.
   I lean **yes, do it** — but it only has teeth once v4call sends the
   fields.

4. **Should `GET /` expose the allowlist + size caps for v4call's picker?**
   I strongly recommend **yes** regardless of the other choices — it stops
   v4call's file picker from going stale every time you change gate
   config. Low effort, high payoff.

5. **`BLOCKED_EXTENSIONS`: confirm deferral?** I recommend folding
   executable-blocking into MIME-allowlist strictness for v0.2 rather than
   a separate lever (and the gate doesn't even receive filenames today).
   OK to defer, or do you want extension blocking as a first-class v0.2
   feature?

6. **Pricing for bigger files (forward-looking, not v0.2-blocking).** Once
   you allow large audio/video, flat-fee-per-upload under-prices big
   files. Do you want per-MB or per-category pricing on the v0.3 radar, or
   is flat-fee deliberate (simplicity > cost-accuracy) for the foreseeable
   future?

---

*Investigated 2026-06-02. No gate code changed. Once you pick a path,
a follow-up session implements the (optional) gate change; the v4call
session does Phase 1 (MP3 client render) — which, per the headline
finding, it can already start without waiting on the gate.*
