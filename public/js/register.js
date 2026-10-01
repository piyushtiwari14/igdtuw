let step = 0;
const form = $('#form'), steps = $$('fieldset[data-step]');
const FIELDS = [['fullName', 'gender', 'dateOfBirth'], ['email', 'phone'], ['photo', 'instituteId', 'governmentIdType', 'governmentId', 'consent']];
const LIMIT = { photo: 3, instituteId: 5, governmentId: 5 };

api('GET', '/api/v1/public/info').then((i) => {
  $('#gender').innerHTML = '<option value="">Select…</option>' + i.genders.map((g) => `<option>${esc(g)}</option>`).join('');
  $('#governmentIdType').innerHTML = '<option value="">Select…</option>' + i.governmentIdTypes.map((g) => `<option>${esc(g)}</option>`).join('');
  if (!i.registrationOpen) { $('#banner').innerHTML = `<div class="alert error">${i.full ? 'Registration capacity has been reached.' : 'Registration is currently closed.'}</div>`; $('#next').disabled = true; }
});
$('#dateOfBirth').max = new Date().toISOString().slice(0, 10);

function setErr(name, msg) {
  const el = form.elements[name]; const box = el.closest('.field').querySelector('.err');
  if (msg) { box.textContent = msg; box.hidden = false; el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', 'e-' + name); box.id = 'e-' + name; }
  else { box.hidden = true; el.removeAttribute('aria-invalid'); }
}
function check(name) {
  const el = form.elements[name]; const v = el.type === 'file' ? el.files[0] : el.type === 'checkbox' ? el.checked : el.value.trim();
  let m = '';
  if (!v) m = name === 'consent' ? 'You must accept to register.' : el.type === 'file' ? 'Please choose a file.' : 'This field is required.';
  else if (name === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) m = 'Enter a valid email address.';
  else if (name === 'phone' && !/^(?:\+?91|0)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))) m = 'Enter a valid 10-digit Indian mobile number.';
  else if (name === 'fullName' && v.length < 2) m = 'Enter your full name.';
  else if (el.type === 'file' && v.size > LIMIT[name] * 1048576) m = `File is too large (max ${LIMIT[name]} MB).`;
  setErr(name, m); return !m;
}
const validStep = (s) => FIELDS[s].map(check).every(Boolean);
function show() {
  steps.forEach((f, i) => { f.hidden = i !== step; });
  $$('#ind li').forEach((li, i) => { li.classList.toggle('done', i < step); i === step ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current'); });
  $('#back').hidden = step === 0; $('#next').hidden = step === 2; $('#submit').hidden = step !== 2;
  const first = steps[step].querySelector('input,select'); first && first.focus();
}
$('#next').onclick = () => { if (validStep(step)) { step++; show(); } else steps[step].querySelector('[aria-invalid]')?.focus(); };
$('#back').onclick = () => { step--; show(); };
form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && step < 2) { e.preventDefault(); $('#next').click(); } });
FIELDS.flat().forEach((n) => form.elements[n].addEventListener('change', () => check(n)));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  for (let s = 0; s <= 2; s++) if (!validStep(s)) { step = s; show(); form.querySelector('[aria-invalid]')?.focus(); return; }
  const btn = $('#submit'); btn.disabled = true; btn.textContent = 'Submitting…'; $('#banner').innerHTML = '';
  try {
    const fd = new FormData(form); fd.set('consent', 'true');
    const pass = await api('POST', '/api/v1/registrations', fd);
    sessionStorage.setItem('taarPass', JSON.stringify(pass));
    location.href = '/pass?new=1';
  } catch (err) {
    $('#banner').innerHTML = `<div class="alert error" tabindex="-1">${esc(err.message)}</div>`; $('#banner .alert').focus();
    if (err.fields) { for (const [n, m] of Object.entries(err.fields)) { if (form.elements[n]) setErr(n, m); } const bad = FIELDS.findIndex((g) => g.some((n) => err.fields[n])); if (bad >= 0) { step = bad; show(); } }
    btn.disabled = false; btn.textContent = 'Submit registration';
  }
});
show();
