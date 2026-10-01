'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const S = require('../server/security');

// Smallest valid-signature files for each type.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF');

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taar-'));
  const db = openDb(':memory:');
  const config = { dataDir, baseUrl: 'http://test.local', serverSecret: 'x'.repeat(40), trustProxy: false, secureCookies: false, hsts: false };
  const server = createApp({ db, config }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const addUser = async (username, role, password = 'correct-horse-battery') =>
    db.prepare('INSERT INTO users(id,username,full_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)')
      .run(S.uuid(), username, username, await S.hashPassword(password), role, S.now());
  return { db, base, dataDir, addUser, close: () => new Promise((r) => server.close(r)) };
}

/** Minimal cookie-aware client. */
function client(base) {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const headers = { 'X-Requested-With': 'taarangana', ...(cookie ? { cookie } : {}), ...extra };
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b),
    login: (username, password = 'correct-horse-battery') => call('POST', '/api/v1/auth/login', { username, password }),
  };
}

function regForm(over = {}, files = {}) {
  const f = new FormData();
  const v = { fullName: 'Asha Verma', gender: 'Female', dateOfBirth: '2004-05-17', email: 'asha@example.com', phone: '9876543210', governmentIdType: 'Election ID', consent: 'true', ...over };
  for (const [k, val] of Object.entries(v)) if (val !== undefined) f.append(k, val);
  f.append('photo', files.photo ?? new Blob([JPEG], { type: 'image/jpeg' }), 'p.jpg');
  f.append('instituteId', files.instituteId ?? new Blob([PNG], { type: 'image/png' }), 'i.png');
  f.append('governmentId', files.governmentId ?? new Blob([PDF], { type: 'application/pdf' }), 'g.pdf');
  return f;
}

/** Recompute a participant's QR token the same way the server does. */
function tokenFor(ctx, registrationId) {
  const r = ctx.db.prepare('SELECT id, qr_nonce FROM registrations WHERE registration_id=?').get(registrationId);
  return S.deriveQrToken('x'.repeat(40), r.id, r.qr_nonce);
}

module.exports = { startServer, client, regForm, tokenFor, JPEG, PNG, PDF };
