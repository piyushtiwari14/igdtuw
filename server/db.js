'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  day1_date TEXT NOT NULL,
  day2_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('photo','institute_id','government_id')),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  government_id_type TEXT NOT NULL,
  photo_file_id TEXT NOT NULL REFERENCES files(id),
  institute_id_file_id TEXT NOT NULL REFERENCES files(id),
  government_id_file_id TEXT NOT NULL REFERENCES files(id),
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_phone ON participants(phone);
CREATE INDEX IF NOT EXISTS idx_participants_email ON participants(email);
CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(full_name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  registration_id TEXT NOT NULL UNIQUE,
  qr_nonce TEXT NOT NULL,
  qr_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','PENDING','CANCELLED')),
  registered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_event_participant ON registrations(event_id, participant_id);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','VOLUNTEER','SUPPORT')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entry_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  registration_id TEXT REFERENCES registrations(id),
  event_day INTEGER,
  scan_status TEXT NOT NULL CHECK (scan_status IN ('ALLOWED','ALREADY_ENTERED','INVALID_QR','NOT_ELIGIBLE')),
  scanner_user_id TEXT REFERENCES users(id),
  device_id TEXT,
  scanned_at TEXT NOT NULL,
  reason TEXT
);
-- CRITICAL: one accepted entry per event / registration / day, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entry_allowed
  ON entry_logs(event_id, registration_id, event_day) WHERE scan_status = 'ALLOWED';
CREATE INDEX IF NOT EXISTS idx_entry_scanned_at ON entry_logs(scanned_at);
CREATE INDEX IF NOT EXISTS idx_entry_lookup ON entry_logs(event_id, registration_id, event_day);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  registration_limit: '3000',
  registration_open: '1',
  require_approval: '0',
  allow_duplicate_contact: '0',
  event_day_override: '',
  min_age: '0',
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare(
    `INSERT OR IGNORE INTO events (id, name, day1_date, day2_date) VALUES ('taarangana-2026','Taarangana 2026','2026-10-22','2026-10-23')`
  ).run();
  const ins = db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT; rolls back on throw. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx, DEFAULT_SETTINGS, EVENT_ID: 'taarangana-2026' };
