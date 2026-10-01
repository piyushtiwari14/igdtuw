'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, regForm, tokenFor, JPEG } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(async () => { await ctx.close(); });

async function register(over, files) {
  const c = client(ctx.base);
  return c.post('/api/v1/registrations', regForm(over, files));
}
const uniq = (() => { let n = 0; return () => { n++; return { email: `u${n}@example.com`, phone: `98765${String(10000 + n)}` }; }; })();

test('registration: valid submit issues ID + QR with no PII inside', async () => {
  const r = await register(uniq());
  assert.equal(r.status, 201);
  assert.match(r.body.registrationId, /^TAR26-\d{7}$/);
  assert.match(r.body.qrSvg, /<svg/);
  const tok = tokenFor(ctx, r.body.registrationId);
  assert.ok(tok.length >= 40);
  assert.ok(!tok.includes('Asha'));
  const stored = ctx.db.prepare('SELECT qr_token_hash FROM registrations WHERE registration_id=?').get(r.body.registrationId);
  assert.notEqual(stored.qr_token_hash, tok, 'only a hash of the token is stored');
});

test('registration: validation errors are field-specific', async () => {
  const r = await register({ ...uniq(), fullName: 'A', phone: '12345', email: 'nope', consent: undefined, gender: 'x', dateOfBirth: '2004-13-40' });
  assert.equal(r.status, 400);
  for (const k of ['fullName', 'phone', 'email', 'consent', 'gender', 'dateOfBirth']) assert.ok(r.body.fields[k], k);
});

test('registration: rejects files whose bytes do not match an allowed type', async () => {
  const r = await register(uniq(), { photo: new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/jpeg' }) });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.photo);
  const pdfAsPhoto = await register(uniq(), { photo: new Blob([Buffer.from('%PDF-1.4 x')], { type: 'application/pdf' }) });
  assert.equal(pdfAsPhoto.status, 400, 'photo may not be a PDF');
});

test('registration: duplicate email/phone blocked; limit enforced', async () => {
  const c = uniq();
  assert.equal((await register(c)).status, 201);
  const d = await register(c);
  assert.equal(d.status, 409);
  ctx.db.prepare(`UPDATE system_settings SET value='0' WHERE key='registration_limit'`).run();
  const full = await register(uniq());
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'REGISTRATION_FULL');
  ctx.db.prepare(`UPDATE system_settings SET value='3000' WHERE key='registration_limit'`).run();
});

test('pass lookup needs matching contact; unknown ID and wrong contact look identical', async () => {
  const c = uniq(); const r = await register(c);
  const cl = client(ctx.base);
  const ok = await cl.post('/api/v1/passes/lookup', { registrationId: r.body.registrationId.toLowerCase(), contact: c.email.toUpperCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.registrationId, r.body.registrationId);
  const byPhone = await cl.post('/api/v1/passes/lookup', { registrationId: r.body.registrationId, contact: '+91 ' + c.phone });
  assert.equal(byPhone.status, 200);
  const wrong = await cl.post('/api/v1/passes/lookup', { registrationId: r.body.registrationId, contact: 'x@y.com' });
  const unknown = await cl.post('/api/v1/passes/lookup', { registrationId: 'TAR26-0000000', contact: c.email });
  assert.equal(wrong.status, 404); assert.deepEqual(wrong.body, unknown.body);
});

test('auth + RBAC enforced on the API', async () => {
  await ctx.addUser('vol', 'VOLUNTEER'); await ctx.addUser('adm', 'ADMIN'); await ctx.addUser('sup', 'SUPER_ADMIN'); await ctx.addUser('tech', 'SUPPORT');
  const anon = client(ctx.base);
  assert.equal((await anon.get('/api/v1/registrations')).status, 401);
  assert.equal((await anon.post('/api/v1/entry/verify', { token: 'x' })).status, 401);
  assert.equal((await anon.login('vol', 'wrong-password-xx')).status, 401);
  const vol = client(ctx.base); assert.equal((await vol.login('vol')).status, 200);
  assert.equal((await vol.get('/api/v1/registrations')).status, 403);
  assert.equal((await vol.get('/api/v1/dashboard')).status, 403);
  assert.equal((await vol.get('/api/v1/reports/registrations')).status, 403);
  const adm = client(ctx.base); await adm.login('adm');
  assert.equal((await adm.get('/api/v1/registrations')).status, 200);
  assert.equal((await adm.get('/api/v1/users')).status, 403);
  assert.equal((await adm.get('/api/v1/audit-logs')).status, 403);
  assert.equal((await adm.put('/api/v1/settings', { registration_limit: '10' })).status, 403);
  const tech = client(ctx.base); await tech.login('tech');
  assert.equal((await tech.get('/api/v1/diagnostics')).status, 200);
  assert.equal((await tech.get('/api/v1/registrations')).status, 403, 'support has no PII access');
});

test('CSRF header required for authenticated writes', async () => {
  const login = await fetch(ctx.base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sup', password: 'correct-horse-battery' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/i);
  const bad = await fetch(ctx.base + '/api/v1/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ registration_limit: '1' }) });
  assert.equal(bad.status, 403);
  const good = await fetch(ctx.base + '/api/v1/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'taarangana' }, body: JSON.stringify({ registration_limit: '3000' }) });
  assert.equal(good.status, 200);
});

test('entry: Day 1 and Day 2 each allow exactly one entry; duplicates are logged', async () => {
  const r = await register(uniq()); const rid = r.body.registrationId; const token = tokenFor(ctx, rid);
  const vol = client(ctx.base); await vol.login('vol');
  const setDay = (d) => ctx.db.prepare(`UPDATE system_settings SET value=? WHERE key='event_day_override'`).run(d);

  setDay('');
  const closed = await vol.post('/api/v1/entry/verify', { token });
  assert.equal(closed.body.status, 'NOT_ELIGIBLE', 'outside event days');

  setDay('1');
  const a = await vol.post('/api/v1/entry/verify', { token: `http://test.local/verify?t=${token}` });
  assert.equal(a.body.status, 'ENTRY_ALLOWED');
  assert.equal(a.body.eventDay, 1);
  assert.deepEqual(Object.keys(a.body.participant).sort(), ['name', 'photoUrl'], 'volunteers get minimum info');
  const b = await vol.post('/api/v1/entry/verify', { token });
  assert.equal(b.body.status, 'ALREADY_ENTERED');
  assert.ok(b.body.previousEntryTime);

  setDay('2');
  assert.equal((await vol.post('/api/v1/entry/verify', { token })).body.status, 'ENTRY_ALLOWED', 'Day 2 needs no re-registration');
  assert.equal((await vol.post('/api/v1/entry/verify', { token })).body.status, 'ALREADY_ENTERED');
  setDay('');

  const allowed = ctx.db.prepare(`SELECT event_day FROM entry_logs e JOIN registrations g ON g.id=e.registration_id WHERE g.registration_id=? AND scan_status='ALLOWED' ORDER BY 1`).all(rid).map((x) => x.event_day);
  assert.deepEqual(allowed, [1, 2]);
});

test('entry: invalid, altered and cancelled QR are rejected and logged', async () => {
  const r = await register(uniq()); const token = tokenFor(ctx, r.body.registrationId);
  const vol = client(ctx.base); await vol.login('vol');
  ctx.db.prepare(`UPDATE system_settings SET value='1' WHERE key='event_day_override'`).run();
  assert.equal((await vol.post('/api/v1/entry/verify', { token: 'garbage' })).body.status, 'INVALID_QR');
  assert.equal((await vol.post('/api/v1/entry/verify', { token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') })).body.status, 'INVALID_QR');
  assert.equal((await vol.post('/api/v1/entry/verify', {})).body.status, 'INVALID_QR');
  ctx.db.prepare(`UPDATE registrations SET status='CANCELLED' WHERE registration_id=?`).run(r.body.registrationId);
  assert.equal((await vol.post('/api/v1/entry/verify', { token })).body.status, 'NOT_ELIGIBLE');
  ctx.db.prepare(`UPDATE system_settings SET value='' WHERE key='event_day_override'`).run();
  assert.ok(ctx.db.prepare(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status='INVALID_QR'`).get().n >= 3);
});

test('CRITICAL concurrency: one QR scanned by 11 devices at once → exactly one ENTRY_ALLOWED', async () => {
  const r = await register(uniq()); const token = tokenFor(ctx, r.body.registrationId);
  ctx.db.prepare(`UPDATE system_settings SET value='1' WHERE key='event_day_override'`).run();
  const vols = [];
  for (let i = 0; i < 11; i++) { await ctx.addUser(`cv${i}`, 'VOLUNTEER'); const c = client(ctx.base); await c.login(`cv${i}`); vols.push(c); }
  const results = await Promise.all(vols.map((v, i) => v.post('/api/v1/entry/verify', { token, deviceId: 'dev' + i })));
  const tally = {};
  for (const x of results) tally[x.body.status] = (tally[x.body.status] || 0) + 1;
  assert.deepEqual(tally, { ENTRY_ALLOWED: 1, ALREADY_ENTERED: 10 });
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM entry_logs e JOIN registrations g ON g.id=e.registration_id WHERE g.registration_id=? AND scan_status='ALLOWED'`).get(r.body.registrationId).n, 1);
  ctx.db.prepare(`UPDATE system_settings SET value='' WHERE key='event_day_override'`).run();
});

test('database unique index independently blocks a second accepted entry', () => {
  const reg = ctx.db.prepare('SELECT id FROM registrations LIMIT 1').get();
  const ins = () => ctx.db.prepare(`INSERT INTO entry_logs(id,event_id,registration_id,event_day,scan_status,scanned_at) VALUES(?,?,?,?,?,?)`).run(Math.random().toString(), 'taarangana-2026', reg.id, 2, 'ALLOWED', new Date().toISOString());
  ctx.db.prepare(`DELETE FROM entry_logs WHERE registration_id=? AND event_day=2`).run(reg.id);
  ins();
  assert.throws(ins, /UNIQUE/);
});

test('files: ID documents are private; volunteers can only see photos', async () => {
  const r = await register(uniq());
  const row = ctx.db.prepare(`SELECT p.photo_file_id ph, p.government_id_file_id gv FROM registrations g JOIN participants p ON p.id=g.participant_id WHERE g.registration_id=?`).get(r.body.registrationId);
  assert.equal((await client(ctx.base).get(`/api/v1/files/${row.gv}`)).status, 401);
  const vol = client(ctx.base); await vol.login('vol');
  assert.equal((await vol.get(`/api/v1/files/${row.ph}`)).status, 200);
  assert.equal((await vol.get(`/api/v1/files/${row.gv}`)).status, 403);
  const adm = client(ctx.base); await adm.login('adm');
  const f = await adm.get(`/api/v1/files/${row.gv}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('cache-control'), 'private, no-store');
  const direct = await fetch(ctx.base + '/uploads/x'); assert.notEqual(direct.status, 200);
});

test('admin: search, edit (audited), dashboard, settings, exports', async () => {
  const adm = client(ctx.base); await adm.login('adm');
  const sup = client(ctx.base); await sup.login('sup');
  const c = uniq(); const reg = (await register({ ...c, fullName: 'Searchable Person' })).body;
  const list = await adm.get('/api/v1/registrations?q=Searchable');
  assert.equal(list.body.total, 1);
  assert.equal((await adm.get('/api/v1/registrations?q=' + encodeURIComponent("' OR 1=1 --"))).body.total, 0);
  const ed = await adm.patch(`/api/v1/registrations/${reg.registrationId}`, { fullName: 'Renamed Person', status: 'PENDING' });
  assert.deepEqual(ed.body.changed.sort(), ['full_name', 'status']);
  const audit = (await sup.get('/api/v1/audit-logs')).body.rows.find((x) => x.action === 'EDIT_PARTICIPANT');
  assert.match(audit.details, /Renamed Person/);

  const dash = (await adm.get('/api/v1/dashboard')).body;
  assert.ok(dash.totalRegistrations >= 1 && dash.pendingRegistrations >= 1);
  assert.equal(dash.registrationLimit, 3000);

  assert.equal((await sup.put('/api/v1/settings', { registration_limit: '3500' })).status, 200);
  assert.equal((await adm.get('/api/v1/dashboard')).body.registrationLimit, 3500);
  assert.equal((await sup.put('/api/v1/settings', { registration_limit: 'abc' })).status, 400);
  assert.ok((await sup.get('/api/v1/audit-logs')).body.rows.some((x) => x.action === 'LIMIT_CHANGE'));

  const csv = await adm.get('/api/v1/reports/registrations?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = csv.body.toString();
  assert.match(text, /Registration ID,Name,Gender/);
  assert.equal(text.trim().split('\r\n').length - 1, ctx.db.prepare('SELECT COUNT(*) n FROM registrations').get().n, 'CSV reconciles with DB');
  const xlsx = await adm.get('/api/v1/reports/entries?format=xlsx');
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  for (const t of ['duplicates', 'summary']) assert.equal((await adm.get(`/api/v1/reports/${t}?format=csv`)).status, 200);
  assert.ok((await sup.get('/api/v1/audit-logs')).body.rows.some((x) => x.action === 'EXPORT'));
});

test('CSV export neutralises spreadsheet formula injection', async () => {
  const adm = client(ctx.base); await adm.login('adm');
  await register({ ...uniq(), fullName: '=HYPERLINK("http://evil")' });
  const text = (await adm.get('/api/v1/reports/registrations?format=csv')).body.toString();
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`));
});

test('user management: create, disable (kills sessions), cannot self-demote', async () => {
  const sup = client(ctx.base); await sup.login('sup');
  assert.equal((await sup.post('/api/v1/users', { username: 'newvol', fullName: 'New', password: 'short', role: 'VOLUNTEER' })).status, 400);
  const mk = await sup.post('/api/v1/users', { username: 'newvol', fullName: 'New Vol', password: 'a-long-password-1', role: 'VOLUNTEER' });
  assert.equal(mk.status, 201);
  const nv = client(ctx.base); assert.equal((await nv.login('newvol', 'a-long-password-1')).status, 200);
  assert.equal((await sup.patch(`/api/v1/users/${mk.body.id}`, { active: false })).status, 200);
  assert.equal((await nv.get('/api/v1/auth/me')).status, 401);
  assert.equal((await client(ctx.base).login('newvol', 'a-long-password-1')).status, 401);
  const me = ctx.db.prepare(`SELECT id FROM users WHERE username='sup'`).get().id;
  assert.equal((await sup.patch(`/api/v1/users/${me}`, { role: 'VOLUNTEER' })).status, 400);
});

test('security headers present; login is rate limited', async () => {
  const res = await fetch(ctx.base + '/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const c = client(ctx.base); let last;
  for (let i = 0; i < 12; i++) last = await c.login('ratelimited-user', 'nope-nope-nope');
  assert.equal(last.status, 429);
});
