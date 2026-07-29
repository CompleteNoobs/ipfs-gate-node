// ipfs-gate v0.1 — Kubo backend.
// Talks to a local Kubo (go-ipfs) daemon via its HTTP API.
//
// Kubo HTTP API reference: https://docs.ipfs.tech/reference/kubo/rpc/
// Endpoints used:
//   POST /api/v0/add?pin=true        — add + pin bytes; returns CID
//   POST /api/v0/pin/rm?arg=<cid>    — unpin
//   POST /api/v0/pin/ls?arg=<cid>    — check pinned
//   POST /api/v0/repo/gc             — garbage collect
//   POST /api/v0/repo/stat           — disk usage
//   POST /api/v0/version             — version + status check

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const KUBO_API_URL = (process.env.KUBO_API_URL || 'http://kubo:5001').replace(/\/$/, '');
const KUBO_TIMEOUT_MS = parseInt(process.env.KUBO_TIMEOUT_MS || '60000', 10);
// Adds of large files stream from disk and can take far longer than the quick
// pin/ls/gc calls — give /add its own generous timeout (default 15 min).
const KUBO_ADD_TIMEOUT_MS = parseInt(process.env.KUBO_ADD_TIMEOUT_MS || '900000', 10);

async function kuboFetch(path, opts = {}) {
  const url = `${KUBO_API_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(KUBO_TIMEOUT_MS),
    ...opts
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Kubo ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.code = 'bad_gateway';
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * Pin bytes to local Kubo. Returns { cid }.
 * Uses raw-leaves + CIDv1 base32 for URL-safe, modern CIDs.
 */
async function pin(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw Object.assign(new Error('pin() requires a Buffer'), { code: 'internal_error' });
  }

  const fd = new FormData();
  // FormData in Node uses Blob; convert Buffer
  fd.append('file', new Blob([bytes]), 'ciphertext.bin');

  // ?pin=true            — pin immediately
  // ?cid-version=1       — CIDv1 (multibase, URL-safe)
  // ?raw-leaves=true     — slightly smaller CIDs for small files; widely supported
  // ?wrap-with-directory=false — single file, no wrapping
  const qs = 'pin=true&cid-version=1&raw-leaves=true&wrap-with-directory=false';
  const res = await kuboFetch(`/api/v0/add?${qs}`, { body: fd });

  // Kubo's /add returns newline-delimited JSON. For a single file we get one line.
  const text = await res.text();
  const firstLine = text.trim().split('\n').filter(Boolean).pop();
  if (!firstLine) {
    throw Object.assign(new Error('Kubo /add returned empty body'), { code: 'bad_gateway' });
  }
  let parsed;
  try {
    parsed = JSON.parse(firstLine);
  } catch (e) {
    throw Object.assign(
      new Error(`Kubo /add returned non-JSON: ${text.slice(0, 200)}`),
      { code: 'bad_gateway' }
    );
  }
  if (!parsed.Hash) {
    throw Object.assign(
      new Error(`Kubo /add returned no Hash: ${JSON.stringify(parsed)}`),
      { code: 'bad_gateway' }
    );
  }
  return { cid: parsed.Hash };
}

/**
 * Compute the CID of bytes WITHOUT storing or pinning anything (Kubo's
 * only-hash mode). Used by POST /check for already-hosted detection before the
 * user pays. The cid-version/raw-leaves flags MUST stay identical to pin()'s,
 * or the same bytes would hash to a different CID and detection breaks.
 */
async function cidOf(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw Object.assign(new Error('cidOf() requires a Buffer'), { code: 'internal_error' });
  }
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), 'ciphertext.bin');
  const qs = 'only-hash=true&pin=false&cid-version=1&raw-leaves=true&wrap-with-directory=false';
  const res = await kuboFetch(`/api/v0/add?${qs}`, { body: fd });
  const text = await res.text();
  const firstLine = text.trim().split('\n').filter(Boolean).pop();
  let parsed;
  try { parsed = JSON.parse(firstLine || ''); } catch (e) {
    throw Object.assign(new Error(`Kubo /add (only-hash) returned non-JSON: ${text.slice(0, 200)}`), { code: 'bad_gateway' });
  }
  if (!parsed.Hash) {
    throw Object.assign(new Error(`Kubo /add (only-hash) returned no Hash: ${JSON.stringify(parsed)}`), { code: 'bad_gateway' });
  }
  return { cid: parsed.Hash };
}

/**
 * Parse Kubo /add's newline-delimited JSON response → the CID Hash.
 */
function parseAddHash(text, label) {
  const firstLine = String(text || '').trim().split('\n').filter(Boolean).pop();
  if (!firstLine) throw Object.assign(new Error(`Kubo ${label} returned empty body`), { code: 'bad_gateway' });
  let parsed;
  try { parsed = JSON.parse(firstLine); }
  catch (e) { throw Object.assign(new Error(`Kubo ${label} returned non-JSON: ${String(text).slice(0, 200)}`), { code: 'bad_gateway' }); }
  if (!parsed.Hash) throw Object.assign(new Error(`Kubo ${label} returned no Hash: ${JSON.stringify(parsed)}`), { code: 'bad_gateway' });
  return parsed.Hash;
}

/**
 * Stream a file into Kubo's /add as multipart/form-data WITHOUT buffering it.
 * Native fetch + FormData/Blob buffers the whole body in undici (FormData is not
 * streamed), so we build the multipart envelope by hand and pass an async-
 * generator body with duplex:'half' — undici then streams it chunk-by-chunk.
 * Content-Length is known up front (preamble + file size + epilogue), so no
 * chunked encoding. This is the real >100MB fix: node RAM stays flat regardless
 * of file size.
 */
async function streamAdd(filePath, qs, label) {
  const stat = await fs.promises.stat(filePath);
  const boundary = '----ipfsgate' + crypto.randomBytes(12).toString('hex');
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ciphertext.bin"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const url = new URL(`${KUBO_API_URL}/api/v0/add?${qs}`);

  return await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': pre.length + stat.size + post.length
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(Object.assign(new Error(`Kubo ${label} HTTP ${res.statusCode}: ${text.slice(0, 200)}`), { code: 'bad_gateway', status: res.statusCode }));
        }
        try { resolve({ cid: parseAddHash(text, label) }); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(KUBO_ADD_TIMEOUT_MS, () => req.destroy(Object.assign(new Error(`Kubo ${label} timed out after ${KUBO_ADD_TIMEOUT_MS}ms`), { code: 'bad_gateway' })));
    req.on('error', reject);

    // Stream: preamble, then the file (pipe = backpressure → flat RAM), then epilogue.
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (e) => req.destroy(e));
    req.write(pre);
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => req.end(post));
  });
}

/**
 * Pin a file FROM DISK to local Kubo (streamed — see streamAdd). Add flags are
 * identical to pin()'s, so the same bytes hash to the same CID.
 */
function pinFile(filePath) {
  return streamAdd(filePath, 'pin=true&cid-version=1&raw-leaves=true&wrap-with-directory=false', '/add');
}

/**
 * Streamed only-hash (POST /check): a file's CID from disk without storing or
 * pinning. Flags identical to pinFile()/pin() so detection matches.
 */
function cidOfFile(filePath) {
  return streamAdd(filePath, 'only-hash=true&pin=false&cid-version=1&raw-leaves=true&wrap-with-directory=false', '/add (only-hash)');
}

/**
 * Unpin a CID. Idempotent — succeeds even if already unpinned.
 */
async function unpin(cid) {
  try {
    await kuboFetch(`/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`);
    return { ok: true };
  } catch (e) {
    // Kubo returns 500 for "not pinned"; treat as success (idempotent).
    if (/not pinned/i.test(String(e.message))) {
      return { ok: true };
    }
    throw e;
  }
}

/**
 * Garbage collect. Should be called after a batch of unpins.
 */
async function gc() {
  await kuboFetch('/api/v0/repo/gc');
  return { ok: true };
}

/**
 * Check if a CID is currently pinned in our Kubo node.
 */
async function exists(cid) {
  try {
    const res = await kuboFetch(`/api/v0/pin/ls?arg=${encodeURIComponent(cid)}`);
    const text = await res.text();
    return text.includes(cid);
  } catch (e) {
    if (/not pinned/i.test(String(e.message))) return false;
    throw e;
  }
}

/**
 * Disk + version stats.
 */
async function stats() {
  try {
    const [statRes, verRes] = await Promise.all([
      kuboFetch('/api/v0/repo/stat'),
      kuboFetch('/api/v0/version')
    ]);
    const stat = await statRes.json();
    const ver = await verRes.json();

    // pin count via pin/ls is potentially heavy; skip exact count, expose disk
    return {
      status: 'ok',
      version: ver.Version || null,
      used_bytes: stat.RepoSize || null,
      num_objects: stat.NumObjects || null
    };
  } catch (e) {
    return {
      status: 'unreachable',
      error: e.message
    };
  }
}

/**
 * Fetch raw bytes for a CID (used by the GET /ipfs/:cid pass-through).
 * Returns a Response object so the caller can stream it.
 * Optional { offset, length } map onto Kubo /cat's query params (int64,
 * well-supported) to serve HTTP Range requests. No-args behaviour is
 * byte-identical to before — existing callers unaffected.
 */
async function cat(cid, { offset, length } = {}) {
  let qs = `arg=${encodeURIComponent(cid)}`;
  if (Number.isFinite(offset) && offset > 0) qs += `&offset=${offset}`;
  if (Number.isFinite(length)) qs += `&length=${length}`;
  const res = await fetch(`${KUBO_API_URL}/api/v0/cat?${qs}`, {
    method: 'POST',
    signal: AbortSignal.timeout(KUBO_TIMEOUT_MS)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 500 && /not pinned|no link|not found/i.test(text)) {
      const err = new Error('CID not found in Kubo');
      err.code = 'not_found';
      throw err;
    }
    const err = new Error(`Kubo /cat HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.code = 'bad_gateway';
    throw err;
  }
  return res;
}

module.exports = {
  pin,
  pinFile,
  cidOf,
  cidOfFile,
  unpin,
  gc,
  exists,
  stats,
  cat
};