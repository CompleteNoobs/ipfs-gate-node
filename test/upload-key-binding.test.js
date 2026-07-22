// ipfs-gate v1 — fee-exempt /upload key→account binding tests.
// Background (FEE-EXEMPT-UPLOAD-AUTH-HARDENING.md): on a fee-exempt upload
// there is no on-chain payment to anchor identity, and upload_proof_sig alone
// only proves "whoever holds THIS key signed" — the uploader name in the
// message is a caller-chosen string. The fix (server.js /upload step 3b)
// requires uploader_pubkey to be a CURRENT posting key of the named account,
// via hive.getAccountPostingPubkeys, failing closed on network error.
//
// These tests cover the primitives; the route branch itself is boot-smoked
// live per the repo's convention (no HTTP harness in this suite): a
// throwaway-keypair upload claiming a fee-exempt account must 401 with
// "uploader_pubkey is not a current posting key of this Hive account".
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const dhive = require('@hiveio/dhive');

const envelope = require('../envelope');
const hive = require('../hive-verify');

// A deterministic throwaway keypair — NO relationship to any real Hive account.
const throwawayPriv = dhive.PrivateKey.fromSeed('ipfs-gate-test-throwaway');
const throwawayPub = throwawayPriv.createPublic().toString();

function signProof({ ciphertextSha256Hex, reservationId, uploader, priv = throwawayPriv }) {
  const msg = envelope.buildUploadProofMessage({ ciphertextSha256Hex, reservationId, uploader });
  return priv.sign(envelope.sha256Bytes(Buffer.from(msg, 'utf8'))).toString();
}

const cipherSha = crypto.createHash('sha256').update('fake ciphertext').digest('hex');
const resvId = 'aabbccdd00112233';

// ─── the exploit primitive the 3b check closes ──────────────────────────────

test('a throwaway keypair passes verifyUploadProof for ANY claimed uploader name', () => {
  // This is the vulnerability: the sig is valid — for the throwaway key.
  // Nothing in the proof itself binds that key to the named account.
  for (const impersonated of ['testin', 'guest33', 'anyone-at-all']) {
    const sig = signProof({ ciphertextSha256Hex: cipherSha, reservationId: resvId, uploader: impersonated });
    assert.equal(
      envelope.verifyUploadProof({
        ciphertextSha256Hex: cipherSha, reservationId: resvId,
        uploader: impersonated, uploaderPubkey: throwawayPub, sigStr: sig
      }),
      true,
      `sig verification alone accepts the forged name "${impersonated}" — hence the on-chain key binding in /upload step 3b`
    );
  }
});

test('sig verification itself is sound: wrong pubkey for the sig fails', () => {
  const otherPub = dhive.PrivateKey.fromSeed('a-different-key').createPublic().toString();
  const sig = signProof({ ciphertextSha256Hex: cipherSha, reservationId: resvId, uploader: 'testin' });
  assert.equal(
    envelope.verifyUploadProof({
      ciphertextSha256Hex: cipherSha, reservationId: resvId,
      uploader: 'testin', uploaderPubkey: otherPub, sigStr: sig
    }),
    false
  );
});

// ─── the binding lookup's offline guarantees ────────────────────────────────

test('getAccountPostingPubkeys rejects an invalid account name before any network call', async () => {
  await assert.rejects(
    hive.getAccountPostingPubkeys('Not A Valid @Name'),
    (e) => e.code === 'bad_request' && /invalid hive account name/i.test(e.message)
  );
});

test('the binding predicate: a throwaway pubkey is not in a real key_auths list', () => {
  // Shape of getAccountPostingPubkeys' return: array of STM… strings.
  // The route rejects when includes() is false — exactly the exploit case,
  // since a freshly generated key can never appear in the account's on-chain
  // posting authority.
  const onChainKeys = ['STM5xVn1cWKrbrxG9YHdBv1eXFhVWyv4mBthhcMauN3BEAffZeuKt'];
  assert.equal(onChainKeys.includes(throwawayPub), false);
});
