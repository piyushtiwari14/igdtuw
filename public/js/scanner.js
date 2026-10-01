const view = { ALLOWED: ['ALLOWED', '✓', 'Entry allowed'], ALREADY_ENTERED: ['WARN', '⚠', 'Already entered'], INVALID_QR: ['ERR', '✕', 'Invalid QR'], NOT_ELIGIBLE: ['ERR', '✕', 'Not eligible'] };
const STATUS_MAP = { ENTRY_ALLOWED: 'ALLOWED' };
let stream = null, busy = false, lastToken = '', lastAt = 0, detector = null, timer = null, hide = null;
const deviceId = (() => { try { let d = localStorage.getItem('taarDev'); if (!d) { d = crypto.randomUUID().slice(0, 8); localStorage.setItem('taarDev', d); } return d; } catch { return 'n/a'; } })();

function setNet(on) { $('#net').textContent = on ? 'ONLINE' : 'OFFLINE'; $('#netdot').classList.toggle('off', !on); }
addEventListener('online', () => setNet(true)); addEventListener('offline', () => setNet(false)); setNet(navigator.onLine);

async function boot() {
  try { const me = await api('GET', '/api/v1/auth/me'); if (!['VOLUNTEER', 'ADMIN', 'SUPER_ADMIN'].includes(me.user.role)) throw new Error('role'); start(me); }
  catch { $('#login').hidden = false; $('#app').style.display = 'none'; }
}
function start(me) {
  $('#login').hidden = true; $('#app').style.display = 'flex'; $('#vname').textContent = me.user.fullName;
  const d = $('#day'); d.hidden = false; d.textContent = me.eventDay ? `Day ${me.eventDay}` : 'No event today'; d.classList.toggle('none', !me.eventDay);
  const t = new URLSearchParams(location.search).get('t'); if (t) $('#mtoken').value = t;
  startCamera();
}
$('#lform').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#lerr').innerHTML = '';
  try { await api('POST', '/api/v1/auth/login', { username: $('#u').value, password: $('#p').value }); $('#p').value = ''; boot(); }
  catch (err) { $('#lerr').innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
});
$('#logout').onclick = async () => { stopCamera(); await api('POST', '/api/v1/auth/logout').catch(() => {}); location.href = '/scanner'; };

async function startCamera() {
  const box = $('#camerr'); box.style.display = 'none';
  if (!navigator.mediaDevices?.getUserMedia) return camErr('Camera is not available. This page must be opened over HTTPS in a modern browser. You can still paste the QR link below.');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    const v = $('#video'); v.srcObject = stream; await v.play();
    if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
    loop();
  } catch (e) {
    if (e.name === 'NotAllowedError') camErr('Camera permission was denied. Allow camera access for this site in your browser settings, then tap Retry.');
    else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') camErr('No camera was found on this device.');
    else camErr('Could not start the camera: ' + e.message);
  }
}
function camErr(msg) { const b = $('#camerr'); b.style.display = 'block'; b.innerHTML = `<strong>✕ ${esc(msg)}</strong><br><button class="btn btn-primary btn-sm" id="retrycam" style="margin-top:8px">Retry camera</button>`; $('#retrycam').onclick = startCamera; }
function stopCamera() { clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); stream = null; }

const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
function loop() {
  timer = setTimeout(async () => {
    const v = $('#video');
    if (!busy && v.readyState >= 2) {
      try {
        let text = '';
        if (detector) { const c = await detector.detect(v); text = c[0]?.rawValue || ''; }
        else { const w = v.videoWidth, h = v.videoHeight; if (w) { const s = Math.min(1, 640 / w); canvas.width = w * s; canvas.height = h * s; ctx.drawImage(v, 0, 0, canvas.width, canvas.height); text = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data || ''; } }
        if (text && !(text === lastToken && Date.now() - lastAt < 4000)) { lastToken = text; lastAt = Date.now(); verify(text); }
      } catch { /* frame decode failure: keep scanning */ }
    }
    if (stream) loop();
  }, 120);
}

$('#manual').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#mtoken').value.trim(); if (t) { verify(t); $('#mtoken').value = ''; } });

async function verify(token) {
  if (busy) return; busy = true;
  try {
    const r = await api('POST', '/api/v1/entry/verify', { token, deviceId });
    const k = STATUS_MAP[r.status] || r.status; const [cls, icon, title] = view[k] || ['ERR', '✕', 'Verification failed'];
    let detail = r.message || '';
    if (k === 'ALLOWED') detail = `${r.registrationId} · Day ${r.eventDay}`;
    if (k === 'ALREADY_ENTERED') detail = `${r.registrationId} · first entry ${fmtTime(r.previousEntryTime)}`;
    if (k === 'NOT_ELIGIBLE' || k === 'INVALID_QR') detail = (r.registrationId ? r.registrationId + ' · ' : '') + detail;
    showResult(cls, icon, title, r.participant, detail, k === 'ALLOWED');
  } catch (e) {
    if (e.status === 401) { stopCamera(); showResult('ERR', '✕', 'Signed out', null, 'Your session expired. Sign in again.', false); $('#rnext').onclick = () => location.reload(); busy = true; return; }
    showResult('NET', '⚠', e.network ? 'Network error' : 'Verification failed', null, (e.message || '') + ' Do NOT admit automatically — retry the scan.', false, true);
    lastToken = '';
  }
}
function showResult(cls, icon, title, person, detail, autoHide, isErr) {
  const r = $('#result'); r.className = 'result show ' + cls; $('#ricon').textContent = icon; $('#rtitle').textContent = title;
  $('#rname').textContent = person?.name || ''; $('#rdetail').textContent = detail;
  const ph = $('#rphoto'); if (person?.photoUrl && !isErr) { ph.src = person.photoUrl; ph.alt = 'Participant photo'; ph.hidden = false; } else ph.hidden = true;
  $('#rnext').textContent = isErr ? 'Retry' : 'Scan next'; $('#rnext').onclick = close; r.focus();
  clearTimeout(hide); if (autoHide) hide = setTimeout(close, 3500);
  if (navigator.vibrate) navigator.vibrate(cls === 'ALLOWED' ? 80 : [120, 60, 120]);
}
function close() { clearTimeout(hide); $('#result').className = 'result'; busy = false; }
boot();
