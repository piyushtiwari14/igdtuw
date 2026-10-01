'use strict';
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { tx, EVENT_ID } = require('./db');
const S = require('./security');
const { validateUpload, createStore } = require('./files');

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'VOLUNTEER', 'SUPPORT'];
const ADMINS = ['SUPER_ADMIN', 'ADMIN'];
const SCANNERS = ['SUPER_ADMIN', 'ADMIN', 'VOLUNTEER'];
const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
const GOV_ID_TYPES = ['Aadhaar (masked)', 'Election ID', 'Other government photo ID'];
const REG_STATUSES = ['CONFIRMED', 'PENDING', 'CANCELLED'];
const COOKIE = 'tsid';
const SESSION_HOURS = 12;

function createApp({ db, config }) {
  const app = express();
  const store = createStore(config.dataDir);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 20 } });
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---------- helpers ----------
  const setting = (k) => db.prepare('SELECT value FROM system_settings WHERE key=?').get(k)?.value;
  const setSetting = (k, v) => db.prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const ip = (req) => req.ip;
  function audit(req, action, target, details) {
    db.prepare('INSERT INTO audit_logs(id,actor_user_id,actor_name,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(S.uuid(), req.user?.id ?? null, req.user?.username ?? null, action, target ?? null, details ? JSON.stringify(details) : null, ip(req), S.now());
  }
  const event = () => db.prepare('SELECT * FROM events WHERE id=?').get(EVENT_ID);

  /** 1 or 2 for event days (IST calendar date), else null. An admin override supports UAT/rehearsal. */
  function currentEventDay(at = new Date()) {
    const o = setting('event_day_override');
    if (o === '1' || o === '2') return Number(o);
    const ist = new Date(at.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const ev = event();
    if (ist === ev.day1_date) return 1;
    if (ist === ev.day2_date) return 2;
    return null;
  }

  function qrTokenFor(reg) { return S.deriveQrToken(config.serverSecret, reg.id, reg.qr_nonce); }

  async function buildPass(reg, participant) {
    const token = qrTokenFor(reg);
    const url = `${config.baseUrl}/verify?t=${token}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return {
      registrationId: reg.registration_id,
      name: participant.full_name,
      status: reg.status,
      event: { name: 'Taarangana 2026', dates: '22nd & 23rd October 2026', venue: 'IGDTUW, Kashmere Gate, Delhi-110006' },
      qrSvg,
    };
  }

  // ---------- security headers ----------
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (config.hsts) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // ---------- auth ----------
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  app.use('/api', (req, res, next) => {
    const raw = parseCookies(req)[COOKIE];
    if (raw) {
      const row = db.prepare(
        `SELECT u.id,u.username,u.full_name,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`
      ).get(S.sha256(raw));
      if (row && row.active && row.expires_at > S.now()) req.user = row;
    }
    // CSRF: cookie auth + SameSite=Strict, plus a custom header required on state-changing requests.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.user && req.get('X-Requested-With') !== 'taarangana') {
      return res.status(403).json({ error: 'CSRF', message: 'Missing request header.' });
    }
    next();
  });
  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Please sign in.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have access to this.' });
    next();
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const loginByIp = S.rateLimiter({ windowMs: 10 * 60_000, max: 30, key: (r) => 'ip:' + ip(r) });
  const loginByUser = S.rateLimiter({ windowMs: 10 * 60_000, max: 10, key: (r) => 'u:' + String(r.body?.username || '').toLowerCase() });
  const DUMMY_HASH = require('bcryptjs').hashSync('timing-equaliser', 12); // equalises timing for unknown usernames

  app.post('/api/v1/auth/login', loginByIp, loginByUser, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'BAD_REQUEST', message: 'Username and password are required.' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username.trim());
    const ok = await S.verifyPassword(password, u ? u.password_hash : DUMMY_HASH).catch(() => false);
    if (!u || !u.active || !ok) {
      db.prepare('INSERT INTO audit_logs(id,actor_name,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(S.uuid(), username.slice(0, 64), 'LOGIN_FAILED', null, null, ip(req), S.now());
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Incorrect username or password.' });
    }
    const token = S.newSessionToken();
    const exp = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(S.sha256(token), u.id, S.now(), exp);
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(S.now(), u.id);
    req.user = { id: u.id, username: u.username };
    audit(req, 'LOGIN', u.username);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: SESSION_HOURS * 3600_000, path: '/' });
    res.json({ user: { username: u.username, fullName: u.full_name, role: u.role } });
  }));
  app.post('/api/v1/auth/logout', (req, res) => {
    const raw = parseCookies(req)[COOKIE];
    if (raw) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(S.sha256(raw));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/v1/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Please sign in.' });
    res.json({ user: { username: req.user.username, fullName: req.user.full_name, role: req.user.role }, eventDay: currentEventDay() });
  });

  // ---------- public: event info ----------
  app.get('/api/v1/public/info', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) n FROM registrations').get().n;
    const limit = Number(setting('registration_limit'));
    res.json({
      registrationOpen: setting('registration_open') === '1' && total < limit,
      full: total >= limit,
      genders: GENDERS,
      governmentIdTypes: GOV_ID_TYPES,
    });
  });

  // ---------- public: registration ----------
  const registerLimiter = S.rateLimiter({ windowMs: 10 * 60_000, max: 60, key: (r) => 'reg:' + ip(r) });
  const uploadFields = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'instituteId', maxCount: 1 }, { name: 'governmentId', maxCount: 1 }]);

  function validateRegistration(b) {
    const errors = {};
    const name = String(b.fullName ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 100) errors.fullName = 'Enter your full name (2–100 characters).';
    if (!GENDERS.includes(b.gender)) errors.gender = 'Select a gender option.';
    const dob = String(b.dateOfBirth ?? '');
    const d = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(dob + 'T00:00:00Z') : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) errors.dateOfBirth = 'Enter a valid date of birth.';
    else {
      const age = (Date.now() - d.getTime()) / (365.25 * 86400_000);
      if (age < 0 || d.getUTCFullYear() < 1930) errors.dateOfBirth = 'Enter a valid date of birth.';
      else if (age < Number(setting('min_age') || 0)) errors.dateOfBirth = `Participants must be at least ${setting('min_age')} years old.`;
    }
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) errors.email = 'Enter a valid email address.';
    const digits = String(b.phone ?? '').replace(/[\s-]/g, '');
    const m = digits.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
    if (!m) errors.phone = 'Enter a valid 10-digit Indian mobile number.';
    if (!GOV_ID_TYPES.includes(b.governmentIdType)) errors.governmentIdType = 'Select the type of government ID you are uploading.';
    if (!(b.consent === 'true' || b.consent === true || b.consent === 'on')) errors.consent = 'You must accept the privacy notice to register.';
    return { errors, value: { fullName: name, gender: b.gender, dateOfBirth: dob, email, phone: m?.[1], governmentIdType: b.governmentIdType } };
  }

  app.post('/api/v1/registrations', registerLimiter, uploadFields, wrap(async (req, res) => {
    if (setting('registration_open') !== '1') return res.status(403).json({ error: 'REGISTRATION_CLOSED', message: 'Registration is currently closed.' });
    const { errors, value } = validateRegistration(req.body || {});
    const mimes = {};
    for (const [kind, field] of [['photo', 'photo'], ['institute_id', 'instituteId'], ['government_id', 'governmentId']]) {
      try { mimes[kind] = validateUpload(kind, req.files?.[field]?.[0]).mime; } catch (e) { errors[field] = e.message; }
    }
    if (Object.keys(errors).length) return res.status(400).json({ error: 'VALIDATION', message: 'Please correct the highlighted fields.', fields: errors });

    const saved = [];
    try {
      const result = tx(db, () => {
        const total = db.prepare('SELECT COUNT(*) n FROM registrations').get().n;
        if (total >= Number(setting('registration_limit'))) { const e = new Error('Registration capacity has been reached.'); e.status = 409; e.code = 'REGISTRATION_FULL'; throw e; }
        if (setting('allow_duplicate_contact') !== '1') {
          const dup = db.prepare('SELECT 1 FROM participants WHERE email=? OR phone=?').get(value.email, value.phone);
          if (dup) { const e = new Error('Someone has already registered with this email or phone number. Use "Download Entry Pass" to retrieve your pass.'); e.status = 409; e.code = 'DUPLICATE'; throw e; }
        }
        const fileIds = {};
        for (const [kind, field] of [['photo', 'photo'], ['institute_id', 'instituteId'], ['government_id', 'governmentId']]) {
          const f = req.files[field][0];
          const key = store.save(f.buffer, mimes[kind]);
          saved.push(key);
          const id = S.uuid();
          db.prepare('INSERT INTO files(id,kind,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?)').run(id, kind, mimes[kind], f.size, key, S.now());
          fileIds[kind] = id;
        }
        const pid = S.uuid(); const t = S.now();
        db.prepare(`INSERT INTO participants(id,full_name,gender,date_of_birth,email,phone,government_id_type,photo_file_id,institute_id_file_id,government_id_file_id,consent_at,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(pid, value.fullName, value.gender, value.dateOfBirth, value.email, value.phone, value.governmentIdType, fileIds.photo, fileIds.institute_id, fileIds.government_id, t, t, t);
        const rid = S.uuid(); const nonce = S.newSessionToken();
        const token = S.deriveQrToken(config.serverSecret, rid, nonce);
        let regCode;
        for (let i = 0; i < 20; i++) {
          regCode = S.newRegistrationId();
          if (!db.prepare('SELECT 1 FROM registrations WHERE registration_id=?').get(regCode)) break;
        }
        const status = setting('require_approval') === '1' ? 'PENDING' : 'CONFIRMED';
        db.prepare('INSERT INTO registrations(id,event_id,participant_id,registration_id,qr_nonce,qr_token_hash,status,registered_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(rid, EVENT_ID, pid, regCode, nonce, S.sha256(token), status, t);
        return { reg: { id: rid, qr_nonce: nonce, registration_id: regCode, status }, participant: { full_name: value.fullName } };
      });
      res.status(201).json(await buildPass(result.reg, result.participant));
    } catch (e) {
      saved.forEach((k) => store.remove(k));
      if (e.status) return res.status(e.status).json({ error: e.code || 'ERROR', message: e.message });
      throw e;
    }
  }));

  // ---------- public: retrieve pass ----------
  const lookupLimiter = S.rateLimiter({ windowMs: 10 * 60_000, max: 30, key: (r) => 'lk:' + ip(r) });
  const lookupByIdLimiter = S.rateLimiter({ windowMs: 10 * 60_000, max: 8, key: (r) => 'lkid:' + String(r.body?.registrationId || '').toUpperCase() });
  app.post('/api/v1/passes/lookup', lookupLimiter, lookupByIdLimiter, wrap(async (req, res) => {
    const rid = String(req.body?.registrationId || '').trim().toUpperCase();
    const contact = String(req.body?.contact || '').trim().toLowerCase();
    const phone = contact.replace(/[\s-]/g, '').match(/^(?:\+?91|0)?([6-9]\d{9})$/)?.[1];
    const row = db.prepare(`SELECT r.*, p.full_name, p.email, p.phone FROM registrations r JOIN participants p ON p.id=r.participant_id WHERE r.registration_id=?`).get(rid);
    // Same response whether the ID is unknown or the contact does not match (no enumeration).
    if (!row || !(contact === row.email || (phone && phone === row.phone))) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No registration matches those details.' });
    }
    res.json(await buildPass(row, { full_name: row.full_name }));
  }));

  // ---------- entry verification ----------
  const verifyLimiter = S.rateLimiter({ windowMs: 60_000, max: 600, key: (r) => 'v:' + (r.user?.id || ip(r)) });

  function extractToken(input) {
    const s = String(input || '').trim();
    if (!s || s.length > 500) return '';
    try { const t = new URL(s).searchParams.get('t'); if (t) return t; } catch { /* not a URL */ }
    return s;
  }

  app.post('/api/v1/entry/verify', requireRole(...SCANNERS), verifyLimiter, (req, res) => {
    const token = extractToken(req.body?.token);
    const deviceId = req.body?.deviceId ? String(req.body.deviceId).slice(0, 64) : null;
    const eventDay = currentEventDay();
    const log = (regId, status, day, reason) => {
      const id = S.uuid(); const t = S.now();
      db.prepare('INSERT INTO entry_logs(id,event_id,registration_id,event_day,scan_status,scanner_user_id,device_id,scanned_at,reason) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, EVENT_ID, regId, day, status, req.user.id, deviceId, t, reason ?? null);
      return t;
    };
    const reg = token ? db.prepare(`SELECT r.*, p.full_name, p.gender, p.date_of_birth, p.email, p.phone, p.photo_file_id FROM registrations r JOIN participants p ON p.id=r.participant_id WHERE r.qr_token_hash=?`).get(S.sha256(token)) : null;
    if (!reg || reg.event_id !== EVENT_ID) {
      log(null, 'INVALID_QR', eventDay, token ? 'Token not recognised' : 'Empty token');
      return res.json({ status: 'INVALID_QR', message: 'This QR code is not recognised.' });
    }
    const person = () => {
      const base = { name: reg.full_name, photoUrl: `/api/v1/files/${reg.photo_file_id}` };
      if (!ADMINS.includes(req.user.role)) return base; // volunteers: minimum necessary information
      return { ...base, gender: reg.gender, dob: reg.date_of_birth, email: reg.email, phone: reg.phone };
    };
    if (reg.status !== 'CONFIRMED') {
      log(reg.id, 'NOT_ELIGIBLE', eventDay, `Registration ${reg.status}`);
      return res.json({ status: 'NOT_ELIGIBLE', registrationId: reg.registration_id, participant: person(), message: reg.status === 'PENDING' ? 'Registration is pending approval.' : 'Registration has been cancelled.' });
    }
    if (!eventDay) {
      log(reg.id, 'NOT_ELIGIBLE', null, 'Not an event day');
      return res.json({ status: 'NOT_ELIGIBLE', registrationId: reg.registration_id, participant: person(), message: 'Entry is not open today (event days are 22 and 23 October 2026).' });
    }
    try {
      const t = tx(db, () => {
        const prior = db.prepare(`SELECT scanned_at FROM entry_logs WHERE event_id=? AND registration_id=? AND event_day=? AND scan_status='ALLOWED'`).get(EVENT_ID, reg.id, eventDay);
        if (prior) { const e = new Error('dup'); e.prior = prior.scanned_at; throw e; }
        return log(reg.id, 'ALLOWED', eventDay, null); // unique index is the final guard
      });
      return res.json({ status: 'ENTRY_ALLOWED', registrationId: reg.registration_id, participant: person(), eventDay, entryTime: t });
    } catch (e) {
      let prior = e.prior;
      if (!prior && /UNIQUE/i.test(e.message)) prior = db.prepare(`SELECT scanned_at FROM entry_logs WHERE event_id=? AND registration_id=? AND event_day=? AND scan_status='ALLOWED'`).get(EVENT_ID, reg.id, eventDay)?.scanned_at;
      if (!prior) throw e;
      log(reg.id, 'ALREADY_ENTERED', eventDay, 'Duplicate scan');
      return res.json({ status: 'ALREADY_ENTERED', registrationId: reg.registration_id, participant: person(), eventDay, previousEntryTime: prior, message: `Already entered on Day ${eventDay}.` });
    }
  });

  // ---------- files (private) ----------
  app.get('/api/v1/files/:id', requireRole(...SCANNERS, 'SUPPORT'), (req, res) => {
    const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'NOT_FOUND', message: 'File not found.' });
    const isAdmin = ADMINS.includes(req.user.role);
    if (!isAdmin && !(f.kind === 'photo' && req.user.role === 'VOLUNTEER')) return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have access to this.' });
    if (f.kind !== 'photo') audit(req, 'VIEW_ID_DOCUMENT', f.id, { kind: f.kind });
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.sendFile(store.pathFor(f.storage_key));
  });

  // ---------- admin: registrations ----------
  const regSelect = `SELECT r.registration_id AS registrationId, r.status, r.registered_at AS registeredAt, p.full_name AS fullName, p.gender, p.date_of_birth AS dateOfBirth,
      p.email, p.phone, p.government_id_type AS governmentIdType, p.photo_file_id AS photoFileId, p.institute_id_file_id AS instituteIdFileId, p.government_id_file_id AS governmentIdFileId,
      (SELECT COUNT(*) FROM entry_logs e WHERE e.registration_id=r.id AND e.scan_status='ALLOWED' AND e.event_day=1) AS day1Entry,
      (SELECT COUNT(*) FROM entry_logs e WHERE e.registration_id=r.id AND e.scan_status='ALLOWED' AND e.event_day=2) AS day2Entry
    FROM registrations r JOIN participants p ON p.id=r.participant_id`;
  const like = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';

  app.get('/api/v1/registrations', requireRole(...ADMINS), (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const status = REG_STATUSES.includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(5, parseInt(req.query.pageSize) || 25));
    const where = []; const args = [];
    if (q) { where.push(`(r.registration_id LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')`); args.push(like(q), like(q), like(q), like(q)); }
    if (status) { where.push('r.status=?'); args.push(status); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM registrations r JOIN participants p ON p.id=r.participant_id${w}`).get(...args).n;
    const rows = db.prepare(`${regSelect}${w} ORDER BY r.registered_at DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    res.json({ total, page, pageSize: size, rows });
  });
  app.get('/api/v1/registrations/:id', requireRole(...ADMINS), (req, res) => {
    const row = db.prepare(`${regSelect} WHERE r.registration_id=?`).get(req.params.id.toUpperCase());
    if (!row) return res.status(404).json({ error: 'NOT_FOUND', message: 'Registration not found.' });
    res.json(row);
  });
  app.patch('/api/v1/registrations/:id', requireRole(...ADMINS), (req, res) => {
    const cur = db.prepare(`SELECT r.id rid, r.status, p.id pid, p.full_name, p.gender, p.date_of_birth, p.email, p.phone FROM registrations r JOIN participants p ON p.id=r.participant_id WHERE r.registration_id=?`).get(req.params.id.toUpperCase());
    if (!cur) return res.status(404).json({ error: 'NOT_FOUND', message: 'Registration not found.' });
    const b = req.body || {};
    const merged = { fullName: b.fullName ?? cur.full_name, gender: b.gender ?? cur.gender, dateOfBirth: b.dateOfBirth ?? cur.date_of_birth, email: b.email ?? cur.email, phone: b.phone ?? cur.phone, governmentIdType: GOV_ID_TYPES[0], consent: true };
    const { errors, value } = validateRegistration(merged);
    delete errors.governmentIdType; delete errors.consent;
    if (b.status !== undefined && !REG_STATUSES.includes(b.status)) errors.status = 'Invalid status.';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'VALIDATION', message: 'Please correct the highlighted fields.', fields: errors });
    const next = { full_name: value.fullName, gender: value.gender, date_of_birth: value.dateOfBirth, email: value.email, phone: value.phone };
    const changes = {};
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) changes[k] = { old: cur[k], new: next[k] };
    if (b.status && b.status !== cur.status) changes.status = { old: cur.status, new: b.status };
    if (Object.keys(changes).length) {
      tx(db, () => {
        db.prepare('UPDATE participants SET full_name=?,gender=?,date_of_birth=?,email=?,phone=?,updated_at=? WHERE id=?').run(next.full_name, next.gender, next.date_of_birth, next.email, next.phone, S.now(), cur.pid);
        if (changes.status) db.prepare('UPDATE registrations SET status=? WHERE id=?').run(b.status, cur.rid);
        audit(req, 'EDIT_PARTICIPANT', req.params.id.toUpperCase(), changes);
      });
    }
    res.json({ ok: true, changed: Object.keys(changes) });
  });
  app.get('/api/v1/registrations/:id/pass', requireRole(...ADMINS), wrap(async (req, res) => {
    const row = db.prepare('SELECT r.*, p.full_name FROM registrations r JOIN participants p ON p.id=r.participant_id WHERE r.registration_id=?').get(req.params.id.toUpperCase());
    if (!row) return res.status(404).json({ error: 'NOT_FOUND', message: 'Registration not found.' });
    audit(req, 'ISSUE_PASS', row.registration_id);
    res.json(await buildPass(row, { full_name: row.full_name }));
  }));

  // ---------- admin: entries, dashboard ----------
  app.get('/api/v1/entries', requireRole(...ADMINS), (req, res) => {
    const day = [1, 2].includes(Number(req.query.day)) ? Number(req.query.day) : null;
    const st = ['ALLOWED', 'ALREADY_ENTERED', 'INVALID_QR', 'NOT_ELIGIBLE'].includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, parseInt(req.query.page) || 1); const size = 50;
    const where = []; const args = [];
    if (day) { where.push('e.event_day=?'); args.push(day); }
    if (st) { where.push('e.scan_status=?'); args.push(st); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM entry_logs e${w}`).get(...args).n;
    const rows = db.prepare(`${entrySelect}${w} ORDER BY e.scanned_at DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    res.json({ total, page, pageSize: size, rows });
  });
  const entrySelect = `SELECT e.scanned_at AS scannedAt, e.event_day AS eventDay, e.scan_status AS scanStatus, e.reason, r.registration_id AS registrationId, p.full_name AS name, u.username AS scanner
      FROM entry_logs e LEFT JOIN registrations r ON r.id=e.registration_id LEFT JOIN participants p ON p.id=r.participant_id LEFT JOIN users u ON u.id=e.scanner_user_id`;

  function metrics() {
    const c = (sql, ...a) => db.prepare(sql).get(...a).n;
    const total = c('SELECT COUNT(*) n FROM registrations');
    const limit = Number(setting('registration_limit'));
    return {
      totalRegistrations: total,
      day1Entries: c(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status='ALLOWED' AND event_day=1`),
      day2Entries: c(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status='ALLOWED' AND event_day=2`),
      pendingRegistrations: c(`SELECT COUNT(*) n FROM registrations WHERE status='PENDING'`),
      duplicateAttempts: c(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status='ALREADY_ENTERED'`),
      duplicateAttemptsDay1: c(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status='ALREADY_ENTERED' AND event_day=1`),
      duplicateAttemptsDay2: c(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status='ALREADY_ENTERED' AND event_day=2`),
      rejectedScans: c(`SELECT COUNT(*) n FROM entry_logs WHERE scan_status IN ('INVALID_QR','NOT_ELIGIBLE')`),
      registrationLimit: limit,
      capacityUtilization: limit ? Math.round((total / limit) * 1000) / 10 : 0,
      currentEventDay: currentEventDay(),
    };
  }
  app.get('/api/v1/dashboard', requireRole(...ADMINS), (req, res) => {
    res.json({ ...metrics(), recent: db.prepare(`${entrySelect} ORDER BY e.scanned_at DESC LIMIT 15`).all() });
  });

  // ---------- admin: settings ----------
  const SETTING_RULES = {
    registration_limit: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 100000,
    registration_open: (v) => ['0', '1'].includes(String(v)),
    require_approval: (v) => ['0', '1'].includes(String(v)),
    allow_duplicate_contact: (v) => ['0', '1'].includes(String(v)),
    event_day_override: (v) => ['', '1', '2'].includes(String(v)),
    min_age: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 100,
  };
  app.get('/api/v1/settings', requireRole(...ADMINS), (req, res) => {
    res.json(Object.fromEntries(db.prepare('SELECT key,value FROM system_settings').all().map((r) => [r.key, r.value])));
  });
  app.put('/api/v1/settings', requireRole('SUPER_ADMIN'), (req, res) => {
    const b = req.body || {};
    const changes = {};
    for (const [k, v] of Object.entries(b)) {
      if (!SETTING_RULES[k]) return res.status(400).json({ error: 'VALIDATION', message: `Unknown setting: ${k}` });
      if (!SETTING_RULES[k](v)) return res.status(400).json({ error: 'VALIDATION', message: `Invalid value for ${k}.` });
      const old = setting(k);
      if (String(v) !== old) changes[k] = { old, new: String(v) };
    }
    tx(db, () => {
      for (const [k, v] of Object.entries(changes)) setSetting(k, v.new);
      for (const [k, v] of Object.entries(changes)) audit(req, k === 'registration_limit' ? 'LIMIT_CHANGE' : 'SETTING_CHANGE', k, v);
    });
    res.json({ ok: true, changed: Object.keys(changes) });
  });

  // ---------- admin: users ----------
  app.get('/api/v1/users', requireRole('SUPER_ADMIN'), (req, res) => {
    res.json(db.prepare('SELECT id,username,full_name AS fullName,role,active,created_at AS createdAt,last_login_at AS lastLoginAt FROM users ORDER BY created_at').all());
  });
  app.post('/api/v1/users', requireRole('SUPER_ADMIN'), wrap(async (req, res) => {
    const { username, fullName, password, role } = req.body || {};
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username || '')) return res.status(400).json({ error: 'VALIDATION', message: 'Username must be 3–32 characters (letters, digits, . _ -).' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'VALIDATION', message: 'Invalid role.' });
    if (typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: 'VALIDATION', message: 'Password must be at least 10 characters.' });
    if (!fullName || String(fullName).length > 100) return res.status(400).json({ error: 'VALIDATION', message: 'Full name is required.' });
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'DUPLICATE', message: 'That username is taken.' });
    const id = S.uuid();
    db.prepare('INSERT INTO users(id,username,full_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)').run(id, username, String(fullName).trim(), await S.hashPassword(password), role, S.now());
    audit(req, 'USER_CREATE', username, { role });
    res.status(201).json({ id });
  }));
  app.patch('/api/v1/users/:id', requireRole('SUPER_ADMIN'), wrap(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found.' });
    const b = req.body || {}; const changes = {};
    if (u.id === req.user.id && (b.active === false || (b.role && b.role !== u.role))) return res.status(400).json({ error: 'VALIDATION', message: 'You cannot deactivate or demote your own account.' });
    if (b.role !== undefined) { if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'VALIDATION', message: 'Invalid role.' }); if (b.role !== u.role) changes.role = { old: u.role, new: b.role }; }
    if (b.active !== undefined && (b.active ? 1 : 0) !== u.active) changes.active = { old: !!u.active, new: !!b.active };
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 10) return res.status(400).json({ error: 'VALIDATION', message: 'Password must be at least 10 characters.' });
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await S.hashPassword(b.password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      changes.password = 'reset';
    }
    if (changes.role) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, u.id);
    if (changes.active) { db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, u.id); if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); }
    if (Object.keys(changes).length) audit(req, 'USER_CHANGE', u.username, changes);
    res.json({ ok: true });
  }));

  // ---------- audit + diagnostics ----------
  app.get('/api/v1/audit-logs', requireRole('SUPER_ADMIN'), (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1); const size = 50;
    const total = db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
    const rows = db.prepare('SELECT created_at AS createdAt, actor_name AS actor, action, target, details, ip FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(size, (page - 1) * size);
    res.json({ total, page, pageSize: size, rows });
  });
  app.get('/api/v1/diagnostics', requireRole('SUPER_ADMIN', 'SUPPORT'), (req, res) => {
    const m = metrics();
    res.json({ time: S.now(), uptimeSec: Math.round(process.uptime()), node: process.version, currentEventDay: m.currentEventDay,
      counts: { registrations: m.totalRegistrations, day1Entries: m.day1Entries, day2Entries: m.day2Entries }, activeSessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at>?').get(S.now()).n,
      dbOk: db.prepare('SELECT 1 ok').get().ok === 1 });
  });
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });

  // ---------- reports ----------
  const REPORTS = {
    registrations: {
      sql: `SELECT r.registration_id AS "Registration ID", p.full_name AS "Name", p.gender AS "Gender", p.date_of_birth AS "Date of Birth", p.email AS "Email", p.phone AS "Phone",
            p.government_id_type AS "Government ID Type", r.registered_at AS "Registered At", r.status AS "Status" FROM registrations r JOIN participants p ON p.id=r.participant_id ORDER BY r.registered_at`,
    },
    entries: {
      sql: `SELECT r.registration_id AS "Registration ID", p.full_name AS "Participant", e.event_day AS "Event Day", e.scan_status AS "Scan Status", e.scanned_at AS "Timestamp", u.username AS "Scanner"
            FROM entry_logs e LEFT JOIN registrations r ON r.id=e.registration_id LEFT JOIN participants p ON p.id=r.participant_id LEFT JOIN users u ON u.id=e.scanner_user_id ORDER BY e.scanned_at`,
    },
    duplicates: {
      sql: `SELECT r.registration_id AS "Registration ID", e.event_day AS "Event Day", e.scanned_at AS "Attempted At", u.username AS "Scanner", e.reason AS "Reason"
            FROM entry_logs e LEFT JOIN registrations r ON r.id=e.registration_id LEFT JOIN users u ON u.id=e.scanner_user_id WHERE e.scan_status='ALREADY_ENTERED' ORDER BY e.scanned_at`,
    },
  };
  const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
  app.get('/api/v1/reports/:type', requireRole(...ADMINS), wrap(async (req, res) => {
    const type = req.params.type; const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    let rows;
    if (type === 'summary') {
      const m = metrics();
      rows = [['Total registrations', m.totalRegistrations], ['Day 1 entries', m.day1Entries], ['Day 2 entries', m.day2Entries], ['Pending registrations', m.pendingRegistrations],
        ['Duplicate scan attempts', m.duplicateAttempts], ['Rejected scans (invalid / not eligible)', m.rejectedScans], ['Registration limit', m.registrationLimit]].map(([Metric, Value]) => ({ Metric, Value }));
    } else if (REPORTS[type]) rows = db.prepare(REPORTS[type].sql).all();
    else return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown report.' });
    audit(req, 'EXPORT', type, { format, rows: rows.length });
    const cols = rows.length ? Object.keys(rows[0]) : type === 'summary' ? ['Metric', 'Value'] : db.prepare(REPORTS[type].sql).columns().map((c) => c.name);
    const fname = `taarangana-${type}-${new Date().toISOString().slice(0, 10)}.${format}`;
    res.set({ 'Content-Disposition': `attachment; filename="${fname}"`, 'Cache-Control': 'no-store' });
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(type);
      const heads = cols;
      ws.addRow(heads).font = { bold: true };
      for (const r of rows) ws.addRow(heads.map((h) => safeCell(r[h])));
      ws.columns.forEach((c) => { c.width = 22; });
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    const heads = cols;
    const esc = (v) => { const s = String(safeCell(v) ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.send('﻿' + [heads.join(','), ...rows.map((r) => heads.map((h) => esc(r[h])).join(','))].join('\r\n'));
  }));

  // ---------- static + errors ----------
  app.get('/vendor/jsqr.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
  app.get('/verify', (req, res) => res.redirect('/scanner?t=' + encodeURIComponent(String(req.query.t || '').slice(0, 200))));
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'UPLOAD', message: err.code === 'LIMIT_FILE_SIZE' ? 'A file is too large (max 5 MB).' : 'Upload error.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_REQUEST', message: 'Malformed JSON.' });
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
