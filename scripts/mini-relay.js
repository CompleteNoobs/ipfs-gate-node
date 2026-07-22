#!/usr/bin/env node
// ── mini-relay.js — a minimal in-memory Nostr relay for OFFLINE escrow testing ──
// Implements just enough NIP-01 for escrow-protocol/0.1: EVENT (store + OK ack +
// fan-out), REQ with a single filter (kinds + #p), EOSE, CLOSE. No persistence,
// no auth, no TLS — the escrow trust gate is the INNER schnorr signature, the
// relay is only delivery. Use when the fed relay (nGate) write-gates unknown
// pubkeys, or for fully-offline LXC testing:
//   node scripts/mini-relay.js            (port 7777, override PORT=…)
//   NOSTR_RELAYS=ws://<host>:7777 in both the node's and the box's .env

'use strict';

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '7777', 10);
const events = [];                       // in-memory, newest last (test relay!)
const MAX_EVENTS = 5000;

function matches(filter, ev) {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(ev.kind)) return false;
  if (Array.isArray(filter['#p'])) {
    const ps = (ev.tags || []).filter(t => t[0] === 'p').map(t => t[1]);
    if (!filter['#p'].some(p => ps.includes(p))) return false;
  }
  return true;
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[mini-relay] listening on ws://0.0.0.0:${PORT} (in-memory, test only)`);

wss.on('connection', (ws) => {
  const subs = new Map();                // subId → filter

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!Array.isArray(msg)) return;

    if (msg[0] === 'EVENT' && msg[1] && msg[1].id) {
      const ev = msg[1];
      events.push(ev);
      if (events.length > MAX_EVENTS) events.shift();
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const client of wss.clients) {
        if (client.readyState !== 1 || !client._subs) continue;
        for (const [subId, filter] of client._subs) {
          if (matches(filter, ev)) client.send(JSON.stringify(['EVENT', subId, ev]));
        }
      }
    } else if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
      const subId = msg[1];
      const filter = msg[2] || {};
      subs.set(subId, filter);
      for (const ev of events) {
        if (matches(filter, ev)) ws.send(JSON.stringify(['EVENT', subId, ev]));
      }
      ws.send(JSON.stringify(['EOSE', subId]));
    } else if (msg[0] === 'CLOSE' && typeof msg[1] === 'string') {
      subs.delete(msg[1]);
    }
  });

  ws._subs = subs;
  ws.on('close', () => subs.clear());
});
