# Handoff — harden the fee-exempt `/upload` path (bind `uploader_pubkey` to the account on-chain)

> ✅ **RESOLVED 2026-07-16.** Implemented as `/upload` step 3b (`server.js`) — on the fee-exempt branch only, `uploader_pubkey` must be a current posting key of the named account (`hive.getAccountPostingPubkeys`), failing closed (422) if Hive is unreachable. Tests in `test/upload-key-binding.test.js` (98/98 suite green). Docs updated (`WalkThrough.wiki` security note, `CLAUDE.md`). Live-verified on ipfs-gate.com: throwaway-keypair upload under a whitelisted name now returns 401. The rest of this doc is the original request, kept for the reasoning trail.

**Filed:** 2026-07-16  ·  **Status:** ✅ FIXED (was: OPEN — requesting fix)
**Reporter context:** stood up a private, whitelist-mode gate at `https://ipfs-gate.com` (single fee-exempt user `testin`). This is the one gap that stops "invite-only" from being a real access lock in a free-upload configuration.
**Severity:** Medium. Not a payment/theft bug and no gap on the paying path — it's an *attribution + free-storage-abuse* hole that only exists when an account is `fee_exempt:true`. Already documented as a known limitation in `WalkThrough.wiki` (§ "Security note: whitelist membership ≠ cryptographic identity proof") and `CLAUDE.md`; this doc is the request to actually close it.

---

## The bug in one sentence

On a **fee-exempt** upload there is no on-chain payment to anchor identity, and `/upload` never checks that the caller-supplied `uploader_pubkey` is a real key of the named Hive account — so anyone who knows a whitelisted account name can upload for free under it using a throwaway keypair, and the abuse is attributed to the innocent account.

## Why the paid path is fine (and this is scoped to fee-exempt only)

On a paying upload, the caller must present a real Hive-Engine `tx_id` and the gate verifies the transfer on-chain. Spending that account's tokens requires that account's real active key — so the payment itself proves who's uploading. Remove the payment (fee-exempt) and nothing else in the current build binds the caller to the account.

## Root cause — exact code path

`/upload` verifies the upload proof signature here:

- [server.js:626-637](server.js#L626-L637) — calls `envelope.verifyUploadProof({ …, uploaderPubkey: uploader_pubkey, sigStr: upload_proof_sig })`.
- [envelope.js:102-111](envelope.js#L102-L111) — `verifyUploadProof` is just `verifyHiveSig(message, sigStr, uploaderPubkey)`.

`verifyHiveSig` only proves *"whoever holds this key signed this message."* It does **not** prove the key belongs to `uploader`. The message signed (`buildUploadProofMessage` = `sha256(ciphertext) + reservation_id + uploader`) contains the account **name** as an unauthenticated string, not a key binding. A freshly generated keypair signs its own name-string upload proof perfectly.

The fee-exempt branch that skips payment is [server.js:621-624](server.js#L621-L624):
```js
const isFeeExempt = !!(feeExemptEntryFor(uploader) && r.quoted_amount === 0);
if (!isFeeExempt && !tx_id) {
  return respondError(res, 'bad_request', 'tx_id required');
}
```
When `isFeeExempt` is true, no `tx_id` is required and no on-chain check runs at all.

## The fix already exists elsewhere — reuse it

The signed-user endpoints (`/uploads/by-user`, `/uploads/delete`, `/claims/*`) have exactly this problem and already solve it:

- [server.js:135-163](server.js#L135-L163) `verifySignedUserRequest` — step 3 binds key→account.
- [hive-verify.js:440-452](hive-verify.js#L440-L452) `getAccountPostingPubkeys(account)` — returns the account's current posting `key_auths` from `condenser_api.get_accounts`, **fails closed** (throws) if every Hive node is unreachable.

The doc comment on `getAccountPostingPubkeys` even calls out `/upload` as the place that *should* be doing this. So this is finishing an already-intended design, not inventing a mechanism.

## Proposed change

In `/upload`, on the fee-exempt branch **only**, after the existing `upload_proof_sig` check succeeds, additionally require that `uploader_pubkey` is a current key of `uploader` on Hive. Fail closed on network error (same as `verifySignedUserRequest`). Sketch to drop in right after [server.js:636](server.js#L636):

```js
// Fee-exempt uploads have no on-chain payment to anchor identity, so the
// signature alone doesn't prove the caller owns `uploader`. Bind the key to
// the account the same way verifySignedUserRequest / the admin tier already do.
if (isFeeExempt) {
  let accountKeys;
  try {
    accountKeys = await hive.getAccountPostingPubkeys(uploader);
  } catch (e) {
    // Fail closed: if we can't reach Hive we can't prove ownership.
    return respondError(res, 'unprocessable_entity',
      `could not verify uploader keys: ${e.message}`);
  }
  if (!accountKeys.includes(uploader_pubkey)) {
    return respondError(res, 'unauthorized',
      'uploader_pubkey is not a current key of this Hive account');
  }
}
```

### Decisions the implementer must confirm
1. **Which authority does the client sign the upload proof with?** `getAccountPostingPubkeys` returns the **posting** authority. Confirm the frontend signs `upload_proof_sig` with the posting key (Keychain `requestSignBuffer(..., 'Posting')`). If it signs with active, add/switch to an `getAccountActivePubkeys` equivalent, or accept either authority. This must match or every legitimate fee-exempt upload will 401. **Verify against `public/index.html` + v4call's `desktop-app.html` before shipping.**
2. **Scope strictly to `isFeeExempt`.** Do not add the check to the paid path — it's redundant there (payment already proves ownership) and would add a Hive round-trip + a new fail-closed dependency to every paid upload.
3. **Key-rotation / multisig edge:** `key_auths` can hold multiple keys; `.includes()` already handles that. An account that rotated its posting key mid-session would need to re-sign with the current key — acceptable.
4. **Belt-and-braces re-quote:** consider also re-checking `feeExemptEntryFor(uploader)` is still true at this point (it is, via `isFeeExempt`), so a de-whitelisted-mid-session account can't sneak through — already covered by the 2b whitelist re-check at [server.js:612-615](server.js#L612-L615), but worth a comment.

## Test plan (mirror the live checks already run on ipfs-gate.com)

1. **Regression — legit uploader still works:** `testin` signs an upload proof with its real posting key → upload succeeds and pins.
2. **The exploit is now blocked:** generate a throwaway keypair, sign an upload proof claiming `uploader:"testin"`, present it to `/upload` → expect `401 unauthorized: uploader_pubkey is not a current key of this Hive account` (today: succeeds and pins for free).
3. **Fail-closed:** point `HIVE_API` at a dead node and retry a legit fee-exempt upload → expect `422`, not a silent pass.
4. **Paid path untouched:** a whitelisted-but-paying (`fee_exempt:false`) account still uploads normally with a real `tx_id`; no extra Hive key call added to its flow.
5. Add unit coverage under `test/` alongside the existing whitelist/fees tests.

## Interim mitigations already in place (no code change)

- Private box, domain treated as unlisted (not publicized as "locked").
- `DISK_LIMIT_GB=5` server-wide cap.
- Per-account `quota_bytes` cap available on the whitelist entry — recommend setting a tight one on `testin` until this ships (the reporter can apply it on request).

## References

- `WalkThrough.wiki` § "Security note: whitelist membership ≠ cryptographic identity proof (fee-exempt path)"
- `WHITELIST-MODE-DESIGN-NOTES.md` (whitelist tier design)
- `CLAUDE.md` status note: *"the fee-exempt `/upload` path doesn't bind `uploader_pubkey` to the account's real on-chain key (unlike `/uploads/by-user`)… not yet hardened."*
