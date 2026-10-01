'use strict';
/* Shared helpers (no inline scripts: CSP is script-src 'self'). */
window.$ = (s, r = document) => r.querySelector(s);
window.$$ = (s, r = document) => [...r.querySelectorAll(s)];
window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.api = async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'taarangana' }, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); } catch { const e = new Error('Network error. Check your connection and try again.'); e.network = true; throw e; }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) { const e = new Error(data?.message || `Request failed (${res.status})`); e.status = res.status; e.fields = data?.fields; e.code = data?.error; throw e; }
  return data ?? res;
};

// Show the official emblem if IGDTUW has supplied /assets/emblem.png; otherwise a labelled placeholder (never a redrawn logo).
document.addEventListener('DOMContentLoaded', () => {
  $$('.emblem').forEach((box) => {
    const img = new Image(); img.alt = 'IGDTUW emblem';
    img.onload = () => { box.textContent = ''; box.appendChild(img); };
    img.src = '/assets/emblem.png';
  });
});

window.fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
