'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const hashPassword = (pw) => bcrypt.hash(pw, 12);
const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

/** Opaque, high-entropy QR token derived from a server secret so passes can be re-issued
 *  without storing the token itself (only its hash is stored). */
function deriveQrToken(secret, registrationUuid, nonce) {
  return crypto.createHmac('sha256', secret).update(`${registrationUuid}:${nonce}`).digest('base64url');
}

/** Human readable, non-sequential Registration ID: TAR26-NNNNNNN */
function newRegistrationId() {
  return 'TAR26-' + String(crypto.randomInt(0, 10_000_000)).padStart(7, '0');
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Fixed-window in-memory rate limiter. Use Redis in a multi-instance deployment. */
function rateLimiter({ windowMs, max, key, message = 'Too many requests. Please try again shortly.' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs).unref();
  void timer;
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= t) {
      e = { n: 0, reset: t + windowMs };
      hits.set(k, e);
    }
    e.n++;
    if (e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - t) / 1000)));
      return res.status(429).json({ error: 'RATE_LIMITED', message });
    }
    next();
  };
}

module.exports = { sha256, uuid, now, hashPassword, verifyPassword, deriveQrToken, newRegistrationId, newSessionToken, rateLimiter };
