// Pairing and request authentication for the companion service.
//
// Security model (v1):
//  - Binds to 127.0.0.1 by default; LAN exposure is opt-in via --host/--lan.
//  - Pairing code is shown ONLY in the local console (never served).
//  - Successful pairing mints a bearer token stored on disk; all /api/* calls
//    (except /health and /pair) require it.
//  - Pairing is rate limited. Roadmap: per-device keys, TLS in companion (docs).
import { isTokenValid, getState, addToken, log, resetPairingCode } from './config.js';
import { sendJson, rateLimiter } from './http-utils.js';
import { VERSION } from './config.js';

const pairLimit = rateLimiter(6);

export function extractToken(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (url && url.searchParams.get('token')) return url.searchParams.get('token');
  return null;
}

export function authOk(req, url) {
  return isTokenValid(extractToken(req, url));
}

export async function handlePair(req, res, body) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!pairLimit(`pair:${ip}`)) {
    return sendJson(res, 429, { error: 'Too many pairing attempts. Wait a minute.' });
  }
  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return sendJson(res, 400, { error: 'Missing pairing code.' });
  const expected = getState().pairingCode;
  if (!timingSafeEq(code, expected)) {
    log('pair_fail', { ip });
    return sendJson(res, 403, { error: 'Invalid pairing code. Check the companion console output.' });
  }
  const token = addToken(body.deviceLabel || 'browser');
  log('pair_ok', { ip, label: body.deviceLabel || 'browser' });
  return sendJson(res, 200, {
    token,
    companion: { name: 'localforge-companion', version: VERSION, platform: process.platform },
  });
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still do a comparison to keep timing flat-ish
    Buffer.from(String(b)).equals(Buffer.from(String(b)));
    return false;
  }
  return cryptoTiming(ba, bb);
}

import crypto from 'node:crypto';
function cryptoTiming(a, b) {
  return crypto.timingSafeEqual(a, b);
}

export { resetPairingCode };
