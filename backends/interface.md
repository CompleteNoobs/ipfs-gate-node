# Backend interface

Every storage backend implementation in `backends/<name>.js` must export an object
matching this contract. The `server.js` module loads exactly one backend based
on the `BACKEND` env var.

## Contract

```js
module.exports = {
  /**
   * Store bytes and return the IPFS CID.
   * @param {Buffer} bytes - The ciphertext to pin.
   * @returns {Promise<{ cid: string }>}
   * @throws {Error} with optional .code on failure.
   */
  async pin(bytes) { ... },

  /**
   * Release the storage for a CID. After unpin + GC, the bytes are gone
   * from this backend (other backends in the network may still have them).
   * @param {string} cid
   * @returns {Promise<{ ok: boolean }>}
   */
  async unpin(cid) { ... },

  /**
   * Check if this backend is currently storing the CID.
   * @param {string} cid
   * @returns {Promise<boolean>}
   */
  async exists(cid) { ... },

  /**
   * Return backend-level statistics.
   * @returns {Promise<{ status: string, version?: string, pin_count?: number, used_bytes?: number }>}
   */
  async stats() { ... }
};
```

## Implementations

- `kubo.js` — talks to a local Kubo (go-ipfs) daemon via its HTTP API (v0.1).
- `pinata.js` — DEFERRED to v0.5+. Will POST to Pinata's API using an API key.
- `filecoin.js` — DEFERRED to v0.5+. Will use web3.storage or similar for cold-tier hosting.

## Adding a new backend

1. Create `backends/<name>.js` implementing the four functions above.
2. Set `BACKEND=<name>` in `.env`.
3. Add any backend-specific env vars (e.g. `PINATA_JWT`).
4. Restart ipfs-gate.

No other ipfs-gate code changes needed. The backend interface is the only
coupling point between ipfs-gate's accounting/quota/moderation layer and the
underlying storage.

## Error contract

Backends should throw plain `Error` objects with an optional `.code` matching
the ipfs-gate error vocabulary:
- `bad_gateway` — upstream service unreachable
- `internal_error` — backend's own bug
- `payload_too_large` — backend rejected size
- `not_found` — CID isn't here

The server layer maps `.code` to HTTP status codes.