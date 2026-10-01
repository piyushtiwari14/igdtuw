'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { uuid } = require('./security');

const LIMITS = {
  photo: { max: 3 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
  institute_id: { max: 5 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
  government_id: { max: 5 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Detect the real type from magic bytes; the client-supplied MIME/extension is never trusted. */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Validates an uploaded file; returns {mime} or throws an Error with .field/.message. */
function validateUpload(kind, file) {
  const lim = LIMITS[kind];
  if (!file) throw fieldError(kind, 'This file is required.');
  if (file.size > lim.max) throw fieldError(kind, `File is too large (max ${lim.max / 1024 / 1024} MB).`);
  const mime = sniff(file.buffer);
  if (!mime || !lim.types.includes(mime)) {
    throw fieldError(kind, `Unsupported file type. Allowed: ${lim.types.map((t) => EXT[t].toUpperCase()).join(', ')}.`);
  }
  return { mime };
}

function fieldError(field, message) {
  const e = new Error(message);
  e.field = field;
  e.status = 400;
  return e;
}

function createStore(dir) {
  const root = path.join(dir, 'uploads');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    root,
    save(buf, mime) {
      const key = `${uuid()}.${EXT[mime]}`;
      fs.writeFileSync(path.join(root, key), buf, { mode: 0o600 });
      return key;
    },
    remove(key) {
      try { fs.unlinkSync(path.join(root, key)); } catch { /* already gone */ }
    },
    pathFor(key) {
      const p = path.join(root, path.basename(key));
      return p;
    },
  };
}

module.exports = { validateUpload, createStore, LIMITS };
