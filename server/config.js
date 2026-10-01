'use strict';
const path = require('node:path');
const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const prod = process.env.NODE_ENV === 'production';
if (prod && (!process.env.SERVER_SECRET || process.env.SERVER_SECRET.length < 32)) {
  throw new Error('SERVER_SECRET must be set (32+ chars) in production.');
}
module.exports = {
  port: Number(process.env.PORT) || 3000,
  baseUrl,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  serverSecret: process.env.SERVER_SECRET || 'dev-only-secret-do-not-use-in-production',
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies: baseUrl.startsWith('https://'),
  hsts: baseUrl.startsWith('https://'),
};
