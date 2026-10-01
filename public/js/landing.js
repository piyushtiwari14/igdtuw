api('GET', '/api/v1/public/info').then((i) => {
  if (!i.registrationOpen) {
    $('#status').textContent = i.full ? 'Registration capacity has been reached.' : 'Registration is currently closed.';
    $('#regbtn').setAttribute('aria-disabled', 'true');
    $('#regbtn').addEventListener('click', (e) => e.preventDefault());
  }
}).catch(() => {});
