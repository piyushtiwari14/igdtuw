let me = null, current = 'dashboard', pollTimer = null, regQuery = { q: '', status: '', page: 1 };
const TABS = [['dashboard', 'Dashboard', ['SUPER_ADMIN', 'ADMIN']], ['participants', 'Participants', ['SUPER_ADMIN', 'ADMIN']], ['entries', 'Entries', ['SUPER_ADMIN', 'ADMIN']], ['reports', 'Reports', ['SUPER_ADMIN', 'ADMIN']],
  ['users', 'Users', ['SUPER_ADMIN']], ['settings', 'Settings', ['SUPER_ADMIN', 'ADMIN']], ['audit', 'Audit log', ['SUPER_ADMIN']], ['diag', 'Diagnostics', ['SUPER_ADMIN', 'SUPPORT']]];
const st = (s) => `<span class="st ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const err = (e) => `<div class="alert error" role="alert">${esc(e.message)}</div>`;

async function boot() {
  try { const r = await api('GET', '/api/v1/auth/me'); me = r.user; if (me.role === 'VOLUNTEER') throw new Error('Volunteer accounts use the scanner.'); show(); }
  catch (e) { $('#login').hidden = false; $('#shell').hidden = true; if (e.message.startsWith('Volunteer')) $('#lerr').innerHTML = err(e); }
}
function show() {
  $('#login').hidden = true; $('#shell').hidden = false;
  const tabs = TABS.filter((t) => t[2].includes(me.role));
  $('#tabs').innerHTML = tabs.map(([id, l]) => `<button class="tab" role="tab" data-id="${id}" aria-selected="${id === current}">${l}</button>`).join('') +
    `<span class="who">${esc(me.fullName)} · ${esc(me.role.replace('_', ' '))} <button class="btn" id="logout">Sign out</button></span>`;
  $$('#tabs .tab').forEach((b) => b.onclick = () => go(b.dataset.id));
  $('#logout').onclick = async () => { await api('POST', '/api/v1/auth/logout').catch(() => {}); location.reload(); };
  go(tabs.some((t) => t[0] === current) ? current : tabs[0][0]);
}
function go(id) { current = id; clearInterval(pollTimer); $$('#tabs .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.id === id)); ({ dashboard, participants, entries, reports, users, settings, audit, diag })[id](); }
$('#lform').addEventListener('submit', async (e) => { e.preventDefault(); $('#lerr').innerHTML = ''; try { await api('POST', '/api/v1/auth/login', { username: $('#u').value, password: $('#p').value }); location.reload(); } catch (x) { $('#lerr').innerHTML = err(x); } });
$('#dclose').onclick = () => $('#dlg').close();
const modal = (title, html) => { $('#dtitle').textContent = title; $('#dbody').innerHTML = html; $('#dlg').showModal(); };

async function dashboard() {
  const draw = async () => {
    try {
      const d = await api('GET', '/api/v1/dashboard');
      const M = (v, k, extra = '') => `<div class="metric"><div class="v">${v}</div><div class="k">${k}</div>${extra}</div>`;
      $('#main').innerHTML = `<h2>Dashboard</h2><p class="muted small">Live · refreshes every 10 s · ${d.currentEventDay ? 'Today is Day ' + d.currentEventDay : 'No event day active'}</p><div class="metrics">
        ${M(d.totalRegistrations, 'Total registrations')}${M(d.day1Entries, 'Day 1 entries')}${M(d.day2Entries, 'Day 2 entries')}${M(d.pendingRegistrations, 'Pending registrations')}
        ${M(d.duplicateAttempts, 'Duplicate scan attempts', `<div class="small muted">D1 ${d.duplicateAttemptsDay1} · D2 ${d.duplicateAttemptsDay2}</div>`)}${M(d.rejectedScans, 'Rejected scans')}
        ${M(d.registrationLimit, 'Registration limit')}${M(d.capacityUtilization + '%', 'Capacity utilisation', `<div class="bar"><i style="width:${Math.min(100, d.capacityUtilization)}%"></i></div>`)}</div>
        <h3>Recent entry activity</h3>${entryTable(d.recent)}`;
    } catch (e) { $('#main').innerHTML = err(e); }
  };
  await draw(); pollTimer = setInterval(draw, 10000);
}
const entryTable = (rows) => `<div class="tablewrap"><table class="t"><thead><tr><th>Time (IST)</th><th>Day</th><th>Result</th><th>Registration</th><th>Name</th><th>Scanner</th><th>Note</th></tr></thead><tbody>${
  rows.map((r) => `<tr><td>${fmtTime(r.scannedAt)}</td><td>${r.eventDay ?? '—'}</td><td>${st(r.scanStatus)}</td><td>${esc(r.registrationId || '—')}</td><td>${esc(r.name || '—')}</td><td>${esc(r.scanner || '—')}</td><td>${esc(r.reason || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No scans yet.</td></tr>'}</tbody></table></div>`;

async function participants() {
  $('#main').innerHTML = `<h2>Participants</h2><form class="toolbar" id="sf"><div><label class="small" for="q">Search ID, name, phone or email</label><input class="input" id="q" value="${esc(regQuery.q)}"></div>
    <div><label class="small" for="sts">Status</label><select class="input" id="sts"><option value="">All</option>${['CONFIRMED', 'PENDING', 'CANCELLED'].map((s) => `<option ${regQuery.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div><button class="btn btn-primary">Search</button></form><div id="list"></div>`;
  $('#sf').onsubmit = (e) => { e.preventDefault(); regQuery = { q: $('#q').value, status: $('#sts').value, page: 1 }; load(); };
  const load = async () => {
    try {
      const r = await api('GET', `/api/v1/registrations?q=${encodeURIComponent(regQuery.q)}&status=${regQuery.status}&page=${regQuery.page}`);
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      $('#list').innerHTML = `<div class="tablewrap"><table class="t"><thead><tr><th>Reg. ID</th><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>D1</th><th>D2</th><th></th></tr></thead><tbody>${
        r.rows.map((x) => `<tr><td><b>${esc(x.registrationId)}</b></td><td>${esc(x.fullName)}</td><td>${esc(x.phone)}</td><td>${esc(x.email)}</td><td>${st(x.status)}</td><td>${x.day1Entry ? '✓' : '–'}</td><td>${x.day2Entry ? '✓' : '–'}</td><td><button class="btn btn-secondary btn-sm" data-id="${esc(x.registrationId)}">View / edit</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No matching registrations.</td></tr>'}</tbody></table></div>
        <div class="pager"><span class="muted small">${r.total} total · page ${r.page} of ${pages}</span><button class="btn btn-secondary btn-sm" id="pp" ${r.page <= 1 ? 'disabled' : ''}>Prev</button><button class="btn btn-secondary btn-sm" id="pn" ${r.page >= pages ? 'disabled' : ''}>Next</button></div>`;
      $('#pp').onclick = () => { regQuery.page--; load(); }; $('#pn').onclick = () => { regQuery.page++; load(); };
      $$('#list [data-id]').forEach((b) => b.onclick = () => editReg(b.dataset.id, load));
    } catch (e) { $('#list').innerHTML = err(e); }
  };
  load();
}
async function editReg(id, reload) {
  const x = await api('GET', `/api/v1/registrations/${id}`);
  const f = (n, l, v, t = 'text') => `<div class="field"><label for="e_${n}">${l}</label><input class="input" id="e_${n}" type="${t}" value="${esc(v)}"></div>`;
  modal(`${x.registrationId}`, `<div id="eerr"></div><form id="ef" novalidate>${f('fullName', 'Full name', x.fullName)}<div class="cols2">${f('dateOfBirth', 'Date of birth', x.dateOfBirth, 'date')}
    <div class="field"><label for="e_gender">Gender</label><select class="input" id="e_gender">${['Female', 'Male', 'Non-binary', 'Prefer not to say'].map((g) => `<option ${g === x.gender ? 'selected' : ''}>${g}</option>`).join('')}</select></div></div>
    <div class="cols2">${f('email', 'Email', x.email, 'email')}${f('phone', 'Mobile', x.phone, 'tel')}</div>
    <div class="field"><label for="e_status">Status</label><select class="input" id="e_status">${['CONFIRMED', 'PENDING', 'CANCELLED'].map((s) => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    <p class="small muted">Government ID type: ${esc(x.governmentIdType)} · Registered ${fmtTime(x.registeredAt)}</p>
    <div class="docs"><a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="/api/v1/files/${x.photoFileId}">Photo</a><a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="/api/v1/files/${x.instituteIdFileId}">Institute ID</a><a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="/api/v1/files/${x.governmentIdFileId}">Government ID (audited)</a></div>
    <div class="row-actions"><button type="button" class="btn btn-secondary" id="pass">Open pass</button><button class="btn btn-primary" type="submit">Save changes</button></div></form>`);
  $('#pass').onclick = async () => { const p = await api('GET', `/api/v1/registrations/${id}/pass`); sessionStorage.setItem('taarPass', JSON.stringify(p)); window.open('/pass', '_blank', 'noopener'); };
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/v1/registrations/${id}`, { fullName: $('#e_fullName').value, dateOfBirth: $('#e_dateOfBirth').value, gender: $('#e_gender').value, email: $('#e_email').value, phone: $('#e_phone').value, status: $('#e_status').value });
      $('#dlg').close(); reload();
    } catch (x) { $('#eerr').innerHTML = err(x) + (x.fields ? `<ul>${Object.values(x.fields).map((m) => `<li class="err">${esc(m)}</li>`).join('')}</ul>` : ''); }
  };
}
let entryQ = { day: '', status: '', page: 1 };
async function entries() {
  $('#main').innerHTML = `<h2>Entry logs</h2><form class="toolbar" id="ef"><div><label class="small" for="d">Day</label><select class="input" id="d"><option value="">Both</option><option value="1">Day 1</option><option value="2">Day 2</option></select></div>
    <div><label class="small" for="s">Result</label><select class="input" id="s"><option value="">All</option><option value="ALLOWED">Allowed</option><option value="ALREADY_ENTERED">Already entered</option><option value="INVALID_QR">Invalid QR</option><option value="NOT_ELIGIBLE">Not eligible</option></select></div><button class="btn btn-primary">Filter</button></form><div id="list"></div>`;
  $('#d').value = entryQ.day; $('#s').value = entryQ.status;
  const load = async () => {
    try {
      const r = await api('GET', `/api/v1/entries?day=${entryQ.day}&status=${entryQ.status}&page=${entryQ.page}`); const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      $('#list').innerHTML = entryTable(r.rows) + `<div class="pager"><span class="muted small">${r.total} total · page ${r.page} of ${pages}</span><button class="btn btn-secondary btn-sm" id="pp" ${r.page <= 1 ? 'disabled' : ''}>Prev</button><button class="btn btn-secondary btn-sm" id="pn" ${r.page >= pages ? 'disabled' : ''}>Next</button></div>`;
      $('#pp').onclick = () => { entryQ.page--; load(); }; $('#pn').onclick = () => { entryQ.page++; load(); };
    } catch (e) { $('#list').innerHTML = err(e); }
  };
  $('#ef').onsubmit = (e) => { e.preventDefault(); entryQ = { day: $('#d').value, status: $('#s').value, page: 1 }; load(); };
  load();
}
function reports() {
  const R = [['registrations', 'Registration export', 'Registration ID, participant fields, date/time, status'], ['entries', 'Entry export', 'All scans with day, status, timestamp, scanner'], ['duplicates', 'Duplicate scan report', 'Every repeat-scan attempt'], ['summary', 'Summary report', 'Totals for registrations, entries, duplicates, rejects']];
  $('#main').innerHTML = `<h2>Reports &amp; exports</h2><p class="muted">Exports contain personal data and are recorded in the audit log.</p>` + R.map(([k, t, d]) =>
    `<div class="card" style="margin-bottom:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="margin-right:auto"><h3>${t}</h3><div class="muted small">${d}</div></div><a class="btn btn-secondary" href="/api/v1/reports/${k}?format=csv" download>CSV</a><a class="btn btn-primary" href="/api/v1/reports/${k}?format=xlsx" download>Excel (.xlsx)</a></div>`).join('');
}
async function users() {
  const draw = async () => {
    try {
      const u = await api('GET', '/api/v1/users');
      $('#main').innerHTML = `<h2>Users &amp; roles</h2><div class="card" style="margin-bottom:18px"><h3>Add user</h3><div id="uerr"></div><form id="uf" class="toolbar"><input class="input" id="nu" placeholder="username" aria-label="Username" required><input class="input" id="nn" placeholder="full name" aria-label="Full name" required>
        <input class="input" id="np" type="password" placeholder="password (10+ chars)" aria-label="Password" autocomplete="new-password" required><select class="input" id="nr" aria-label="Role"><option>VOLUNTEER</option><option>ADMIN</option><option>SUPPORT</option><option>SUPER_ADMIN</option></select><button class="btn btn-primary">Create</button></form></div>
        <div class="tablewrap"><table class="t"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Active</th><th>Last login</th><th></th></tr></thead><tbody>${u.map((x) => `<tr><td><b>${esc(x.username)}</b></td><td>${esc(x.fullName)}</td>
        <td><select class="input" style="min-height:34px;padding:4px" data-role="${x.id}" aria-label="Role for ${esc(x.username)}" ${x.username === me.username ? 'disabled' : ''}>${['VOLUNTEER', 'ADMIN', 'SUPPORT', 'SUPER_ADMIN'].map((r) => `<option ${r === x.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td>${x.active ? st('CONFIRMED').replace('CONFIRMED', 'Active') : st('CANCELLED').replace('CANCELLED', 'Disabled')}</td><td>${fmtTime(x.lastLoginAt)}</td>
        <td>${x.username === me.username ? '' : `<button class="btn btn-secondary btn-sm" data-toggle="${x.id}" data-active="${x.active}">${x.active ? 'Disable' : 'Enable'}</button> <button class="btn btn-secondary btn-sm" data-reset="${x.id}">Reset password</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      $('#uf').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/v1/users', { username: $('#nu').value, fullName: $('#nn').value, password: $('#np').value, role: $('#nr').value }); draw(); } catch (x) { $('#uerr').innerHTML = err(x); } };
      $$('[data-role]').forEach((s) => s.onchange = async () => { try { await api('PATCH', `/api/v1/users/${s.dataset.role}`, { role: s.value }); } catch (x) { alert(x.message); } draw(); });
      $$('[data-toggle]').forEach((b) => b.onclick = async () => { await api('PATCH', `/api/v1/users/${b.dataset.toggle}`, { active: b.dataset.active !== '1' }).catch((x) => alert(x.message)); draw(); });
      $$('[data-reset]').forEach((b) => b.onclick = async () => { const p = prompt('New password (10+ characters):'); if (p) await api('PATCH', `/api/v1/users/${b.dataset.reset}`, { password: p }).then(() => alert('Password reset; user signed out.')).catch((x) => alert(x.message)); });
    } catch (e) { $('#main').innerHTML = err(e); }
  };
  draw();
}
async function settings() {
  try {
    const s = await api('GET', '/api/v1/settings'); const can = me.role === 'SUPER_ADMIN';
    const row = (k, label, help, ctl) => `<div class="setting"><div><strong>${label}</strong><div class="muted small">${help}</div></div>${ctl}</div>`;
    const sel = (k, opts) => `<select class="input" style="width:auto" data-k="${k}" ${can ? '' : 'disabled'}>${opts.map(([v, l]) => `<option value="${v}" ${s[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    $('#main').innerHTML = `<h2>Settings</h2>${can ? '' : '<p class="alert warn">Only a Super Admin can change settings.</p>'}<div id="serr"></div><div class="card">
      ${row('registration_limit', 'Registration limit', 'Maximum total registrations (one registration covers both days). Default 3,000.', `<input class="input" style="width:140px" type="number" min="0" data-k="registration_limit" value="${esc(s.registration_limit)}" ${can ? '' : 'disabled'}>`)}
      ${row('registration_open', 'Registration open', 'Turn public registration on or off.', sel('registration_open', [['1', 'Open'], ['0', 'Closed']]))}
      ${row('require_approval', 'Require admin approval', 'New registrations start as PENDING and cannot enter until set to CONFIRMED.', sel('require_approval', [['0', 'No'], ['1', 'Yes']]))}
      ${row('allow_duplicate_contact', 'Allow repeated email / phone', 'Normally one registration per email and phone.', sel('allow_duplicate_contact', [['0', 'No'], ['1', 'Yes']]))}
      ${row('min_age', 'Minimum age', '0 disables the age rule.', `<input class="input" style="width:100px" type="number" min="0" max="100" data-k="min_age" value="${esc(s.min_age)}" ${can ? '' : 'disabled'}>`)}
      ${row('event_day_override', 'Event-day override (testing only)', 'Force the scanner to treat today as Day 1 or 2 for UAT/rehearsal. <b>Set back to Automatic before the event.</b>', sel('event_day_override', [['', 'Automatic (IST date)'], ['1', 'Force Day 1'], ['2', 'Force Day 2']]))}
      ${can ? '<div style="margin-top:14px"><button class="btn btn-primary" id="save">Save settings</button></div>' : ''}</div>`;
    if (can) $('#save').onclick = async () => { const body = {}; $$('[data-k]').forEach((e) => body[e.dataset.k] = e.value); try { const r = await api('PUT', '/api/v1/settings', body); $('#serr').innerHTML = `<div class="alert ok">Saved${r.changed.length ? ': ' + r.changed.join(', ') : ' (no changes)'}.</div>`; } catch (x) { $('#serr').innerHTML = err(x); } };
  } catch (e) { $('#main').innerHTML = err(e); }
}
let auditPage = 1;
async function audit() {
  try {
    const r = await api('GET', `/api/v1/audit-logs?page=${auditPage}`); const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    $('#main').innerHTML = `<h2>Audit log</h2><div class="tablewrap"><table class="t"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${fmtTime(x.createdAt)}</td><td>${esc(x.actor || '—')}</td><td><b>${esc(x.action)}</b></td><td>${esc(x.target || '')}</td><td class="small" style="word-break:break-word;max-width:380px">${esc(x.details || '')}</td><td>${esc(x.ip || '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="pager"><span class="muted small">${r.total} entries · page ${r.page} of ${pages}</span><button class="btn btn-secondary btn-sm" id="pp" ${r.page <= 1 ? 'disabled' : ''}>Prev</button><button class="btn btn-secondary btn-sm" id="pn" ${r.page >= pages ? 'disabled' : ''}>Next</button></div>`;
    $('#pp').onclick = () => { auditPage--; audit(); }; $('#pn').onclick = () => { auditPage++; audit(); };
  } catch (e) { $('#main').innerHTML = err(e); }
}
async function diag() {
  const draw = async () => { try { const d = await api('GET', '/api/v1/diagnostics'); $('#main').innerHTML = `<h2>Diagnostics</h2><div class="card"><table class="t"><tbody>
    <tr><th>Server time</th><td>${esc(d.time)}</td></tr><tr><th>Uptime</th><td>${d.uptimeSec} s</td></tr><tr><th>Node</th><td>${esc(d.node)}</td></tr><tr><th>Database</th><td>${d.dbOk ? 'OK' : 'ERROR'}</td></tr><tr><th>Event day</th><td>${d.currentEventDay ?? 'none'}</td></tr>
    <tr><th>Active sessions</th><td>${d.activeSessions}</td></tr><tr><th>Registrations / D1 / D2</th><td>${d.counts.registrations} / ${d.counts.day1Entries} / ${d.counts.day2Entries}</td></tr></tbody></table></div>`; } catch (e) { $('#main').innerHTML = err(e); } };
  await draw(); pollTimer = setInterval(draw, 10000);
}
boot();
