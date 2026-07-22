# ipfs-gate — Byte-Range (Seek) Support: Dev Handover (v1)

> **Feature:** honor HTTP `Range` requests on the gateway (`GET /ipfs/:cid`) so
> audio/video players can scrub/seek without downloading the whole file first.
>
> **Scope:** the gate's own gateway pass-through only. Public (plaintext)
> uploads are the beneficiary; encrypted uploads can't seek regardless (see
> §Out of scope). Pinata BYO needs nothing — Pinata's gateway already honors
> Range.
>
> **Status:** design locked, NOT built. This doc is the build spec.
> Written 2026-07-05 against the whitelist-mode-complete tree (81 tests green,
> HEAD `971903c`).
>
> Read plain-language first (§1–§2), build from the spec (§3–§7).

---

## 1. What we're building, and why

A user opens a public video/audio link like
`https://ipfs.v4call.com/ipfs/<cid>`. Today, dragging the playback slider
forward forces the browser to download the file from byte 0 — on a long video
that's the whole file before the jump lands. Browsers fix this with **HTTP
range requests**: the player asks for `Range: bytes=1200000-` and a compliant
server replies `206 Partial Content` with just that slice.

The gate does not do this today. **Verified 2026-07-05** against the live
handler (`server.js` `GET /ipfs/:cid`, ~line 904):

- The `Range` request header is never read.
- The response carries **no `Accept-Ranges`, no `Content-Length`, never `206`
  / `Content-Range`** — so players assume seeking is impossible and don't even
  try.
- Every request streams the ENTIRE file from Kubo via `POST /api/v0/cat`.

(The "a properly configured Kubo gateway supports Range" claim is true of
Kubo's *own* gateway on :8080 — but the gate doesn't proxy that; it re-serves
bytes through the API's `cat`, which drops all HTTP semantics. That's why this
has to be built here.)

**The good news:** everything needed is already on hand.
- Kubo's `/api/v0/cat` accepts **`offset` and `length`** query params — an HTTP
  Range maps straight onto them. No second Kubo endpoint, no gateway proxying.
- `Content-Range` needs the file's total size — the pins table already stores
  `size_bytes`, recorded from the actual uploaded buffer, which is byte-exact
  for what `cat` serves (public = plaintext bytes; encrypted = ciphertext
  bytes; a guardian-promoted pin copies the same size).
- Nginx proxies `Range` and `206` through untouched by default — **no nginx
  config change**.

## 2. Behaviour contract (what a client sees after the build)

| Request | Response |
|---|---|
| `GET /ipfs/:cid` (no Range) | `200` + full body — **plus new headers** `Accept-Ranges: bytes` and `Content-Length: <size>` (players use these to enable seeking + show duration/progress) |
| `Range: bytes=100-199` | `206` + `Content-Range: bytes 100-199/<size>` + `Content-Length: 100` + those 100 bytes |
| `Range: bytes=100-` (open-ended) | `206`, from 100 to EOF |
| `Range: bytes=-500` (suffix) | `206`, the LAST 500 bytes (offset `size-500`, clamped ≥ 0) |
| `Range: bytes=0-` | **`206`** with the full body — NOT `200`. Chrome/Safari media elements send exactly this as their first probe; answering `200` makes some players give up on seeking. |
| `Range: bytes=a-b,c-d` (multi-range) | ignore the header, serve plain `200` full (RFC 9110 allows a server to ignore Range; multipart/byteranges is not worth building) |
| Malformed Range (`bytes=x`, `bytes=5-2`, wrong unit) | ignore, plain `200` full |
| `Range` start ≥ size | `416 Range Not Satisfiable` + `Content-Range: bytes */<size>` |
| end > size−1 | clamp to size−1 (normal per RFC), `206` |
| Blocked CID / not pinned | unchanged (451 / 404) — blocklist check stays FIRST, before any Range logic |

Everything else about the endpoint is UNCHANGED: the mode/MIME logic
(`nosniff`, public+safe MIME inline, html/svg forced download, encrypted →
octet-stream) and `Cache-Control: public, max-age=$GATEWAY_CACHE_MAX_AGE`
apply identically to `200` and `206` responses.

## 3. Build spec — three small changes + one new module

### 3a. `range.js` (NEW — pure module, the testable core)
One module per concern, no I/O (same pattern as `pricing.js`):

```js
/**
 * parseRange(header, size) →
 *   null                          — no/ignorable Range (missing, malformed,
 *                                   multi-range, non-bytes unit) → serve 200 full
 *   { unsatisfiable: true }       — start ≥ size (or suffix of 0) → 416
 *   { start, end }                — inclusive byte bounds, end clamped to size-1 → 206
 */
```

Parsing rules: only `bytes=` unit; exactly one range spec (a comma → null);
forms `a-b`, `a-`, `-suffix`; non-numeric or `a > b` → null; `-0` →
unsatisfiable. Keep it dependency-free and boring.

### 3b. `quota.js` — one column
`getServeInfoForCid` (quota.js ~line 367): add `size_bytes` to the SELECT
(`SELECT mode, mime, size_bytes FROM pins …`). That row is already the serve
authority; the size rides along free.

### 3c. `backends/kubo.js` — optional offset/length on cat
Extend the existing function (do NOT add a second one):

```js
async function cat(cid, { offset, length } = {}) {
  let qs = `arg=${encodeURIComponent(cid)}`;
  if (Number.isFinite(offset) && offset > 0) qs += `&offset=${offset}`;
  if (Number.isFinite(length))               qs += `&length=${length}`;
  const res = await fetch(`${KUBO_API_URL}/api/v0/cat?${qs}`, { … });
```

No-args behaviour is byte-identical to today (existing callers unaffected).

### 3d. `server.js` — the handler (`GET /ipfs/:cid`, ~line 904)
After the blocklist + serve-info checks, before calling `kubo.cat`:

```js
res.set('Accept-Ranges', 'bytes');                    // on EVERY response
const size = serve.size_bytes;
const range = parseRange(req.headers.range, size);
if (range && range.unsatisfiable) {
  res.set('Content-Range', `bytes */${size}`);
  return respondError(res, 'range_not_satisfiable', 'requested range beyond end of file'); // 416
}
if (range) {
  res.status(206);
  res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  res.set('Content-Length', String(range.end - range.start + 1));
} else {
  res.set('Content-Length', String(size));
}
const upstream = await kubo.cat(cid, range ? { offset: range.start, length: range.end - range.start + 1 } : {});
```

(`respondError` needs a `range_not_satisfiable` → 416 mapping in its status
table, wherever the other codes live.)

**Recommended extra (cheap):** short-circuit `HEAD` before the `kubo.cat`
call — send the headers (incl. `Content-Length`/`Accept-Ranges`) and
`res.end()` without touching Kubo. Express routes HEAD through the GET
handler and Node discards the body anyway, but without the short-circuit
every player HEAD-probe streams the whole file out of Kubo for nothing.

## 4. Money-grade invariant (the one way this can really break)

**`Content-Length` MUST equal the bytes actually streamed.** If Kubo returns
fewer bytes than promised, clients hang waiting; more, and responses corrupt.
Defenses:
- Compute `length` from the CLAMPED `end` (never from the client's raw ask).
- `size_bytes` is trustworthy (recorded from the upload buffer), but the
  stream-fail path must stay as it is today (`.catch` → `res.end()`) so a
  mid-stream Kubo death terminates the socket rather than stalling it.

## 5. Tests (target: 81 → ~90 green)

`test/range.test.js` (node:test, pure — no Kubo/HTTP, same style as the
pricing tests) over `parseRange`:
1. no header → null; 2. `bytes=0-99` → {0,99}; 3. `bytes=100-` → {100, size−1};
4. `bytes=-500` → {size−500, size−1}; 5. suffix bigger than file → {0, size−1};
6. `bytes=0-` → {0, size−1} (the Chrome probe); 7. end clamped;
8. start ≥ size → unsatisfiable; 9. `bytes=-0` → unsatisfiable;
10. multi-range → null; 11. `a>b` / non-numeric / `items=0-9` → null.

Plus: boot smoke (existing habit) — `GET /ipfs/<missing>` still 404, and a
pinned CID served with/without Range via curl against a local Kubo if one is
running (optional; the live pass below is the real proof).

## 6. Live test on ipfs.v4call.com (fold gotchas into WalkThrough.wiki)

1. Upload a public **mp4** (and/or mp3) via the standalone page.
2. `curl -D- -o /dev/null -r 0-99 https://ipfs.v4call.com/ipfs/<cid>`
   → expect `206`, `Content-Range: bytes 0-99/<size>`, `Content-Length: 100`.
3. `curl -D- -o /dev/null -H 'Range: bytes=-500' …` → 206, last 500 bytes.
4. `curl -D- -o /dev/null -H 'Range: bytes=999999999-' …` → 416 + `bytes */<size>`.
5. Plain `curl -D- -o /dev/null …` → 200 + `Accept-Ranges: bytes` + Content-Length.
6. **The real test:** open the link in a browser tab and drag the video
   scrubber to the middle — playback should jump near-instantly; DevTools
   Network shows `206` requests.
7. Regression: an encrypted v4reveal link still decrypts (full-file fetch,
   200 path, now with Content-Length — harmless), uploads tab still lists,
   delete still works.

## 7. Out of scope (say no in-thread)

- **Seeking inside ENCRYPTED files.** An encrypted upload is one opaque
  AES-GCM blob — the client must fetch ALL of it to decrypt. Range support
  changes nothing there. Seekable encrypted media = a chunked encryption
  format (encrypt-per-segment) = a separate, much bigger design.
- **multipart/byteranges** (multi-range responses) — ignored → 200, done.
- **`If-Range` / conditional requests** — skip for v1. (Note for later: the
  CID is a perfect strong `ETag` — content-addressed by definition. Adding
  `ETag: "<cid>"` + If-Range is a natural v1.1 if players ever need it.)
- **Nginx changes** — none needed; Range proxies through.
- **Pinata path** — already Range-capable, untouched.

## 8. Gotchas / context for the fresh thread

- Repo state: whitelist mode A–D is COMPLETE and live-tested (see
  `WHITELIST-MODE-DESIGN-NOTES.md` + roadmap); 81 tests green at `971903c`.
  Don't disturb the fee-exempt/whitelist logic — Range is orthogonal to it
  (the gateway GET is unauthenticated by design either way).
- There's a separate OPEN security item (fee-exempt `/upload` doesn't bind
  `uploader_pubkey` to the account's on-chain key — see CLAUDE.md status
  note). NOT part of this task; don't entangle the two.
- `X-Content-Type-Options: nosniff` stays on all responses, incl. 206.
- Kubo `cat` `offset`/`length` are int64 and well-supported; still send the
  exact clamped length (see §4) rather than leaning on Kubo's EOF truncation.
- Docs convention: any deploy-time surprise goes into `WalkThrough.wiki`
  "Common problems", symptom-first. Build record goes into
  `roadmap_status.md` + a line in CLAUDE.md status.

## 9. Definition of done

- [ ] `range.js` + `test/range.test.js` (pure parser, ~11 cases)
- [ ] `getServeInfoForCid` returns `size_bytes`
- [ ] `kubo.cat(cid, {offset,length})` (no-args unchanged)
- [ ] `GET /ipfs/:cid`: `Accept-Ranges` + `Content-Length` on 200s; `206` +
      `Content-Range` on ranges; `416` + `bytes */size`; multi/malformed → 200;
      HEAD short-circuit
- [ ] `respondError` knows 416
- [ ] Full suite green (81 + new), boot smoke
- [ ] Live pass (§6) on ipfs.v4call.com, browser scrub confirmed
- [ ] roadmap_status.md + CLAUDE.md updated; wiki if gotchas surfaced
