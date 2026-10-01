'use strict';
// Creates the first Super Admin (and optional demo accounts with --demo). Idempotent.
const crypto = require('node:crypto');
const path = require('node:path');
const config = require('./config');
const { openDb } = require('./db');
const S = require('./security');

(async () => {
  const db = openDb(path.join(config.dataDir, 'taarangana.db'));
  const make = async (username, fullName, role, password) => {
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return console.log(`exists: ${username}`);
    const pw = password || crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users(id,username,full_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)').run(S.uuid(), username, fullName, await S.hashPassword(pw), role, S.now());
    console.log(`created ${role.padEnd(11)} ${username} / ${pw}${password ? '' : '   (generated — store it now)'}`);
  };
  await make(process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin', 'Super Admin', 'SUPER_ADMIN', process.env.BOOTSTRAP_ADMIN_PASSWORD || undefined);
  if (process.argv.includes('--demo')) {
    await make('iadmin', 'IGDTUW Admin (demo)', 'ADMIN');
    await make('volunteer1', 'Volunteer 1 (demo)', 'VOLUNTEER');
    await make('support1', 'Support (demo)', 'SUPPORT');
  }
})();
