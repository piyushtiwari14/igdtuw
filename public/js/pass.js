function render(p) {
  $('#lookup').hidden = true; $('#passview').hidden = false;
  $('#qr').innerHTML = p.qrSvg; $('#pname').textContent = p.name; $('#prid').textContent = p.registrationId;
  const s = $('#pstat'); s.textContent = p.status === 'PENDING' ? 'Pending approval' : p.status === 'CANCELLED' ? 'Cancelled' : 'Confirmed'; s.className = 'badge ' + p.status;
  document.title = `Entry pass ${p.registrationId} · Taarangana 2026`;
  $('#newmsg').hidden = !location.search.includes('new=1');
  $('#dlqr').onclick = () => {
    const svg = new Blob([p.qrSvg], { type: 'image/svg+xml' }); const url = URL.createObjectURL(svg); const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 800; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 800, 800); x.drawImage(img, 0, 0, 800, 800);
      c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${p.registrationId}-qr.png`; a.click(); }); URL.revokeObjectURL(url); };
    img.src = url;
  };
}
$('#print').onclick = () => window.print();
$('#other').onclick = () => { sessionStorage.removeItem('taarPass'); };
const saved = sessionStorage.getItem('taarPass');
if (saved) { try { render(JSON.parse(saved)); } catch { $('#lookup').hidden = false; } } else $('#lookup').hidden = false;
$('#lform').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#lerr').innerHTML = '';
  try { const p = await api('POST', '/api/v1/passes/lookup', { registrationId: $('#rid').value, contact: $('#contact').value }); sessionStorage.setItem('taarPass', JSON.stringify(p)); render(p); }
  catch (err) { $('#lerr').innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
});
