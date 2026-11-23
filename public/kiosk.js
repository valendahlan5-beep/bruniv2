/* Bruni Coffee Lab — mode kiosk: layar penuh, layar tetap menyala, reset otomatis saat ditinggal.
   Aktif lewat alamat  /?kiosk=1  (diingat di perangkat ini).  Keluar: /?kiosk=0 */
(function () {
  'use strict';
  if (!document.documentElement.classList.contains('kiosk')) return;
  const $id = id => document.getElementById(id);
  let last = Date.now(), idleSec = 0, wl = null;
  const touch = () => { last = Date.now(); hideWarn(); };
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(ev => window.addEventListener(ev, touch, { passive: true, capture: true }));

  /* cegah menu klik-kanan & zoom cubit */
  document.addEventListener('contextmenu', e => e.preventDefault());
  ['gesturestart', 'gesturechange'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));

  /* layar tetap menyala */
  async function keepAwake() { try { if ('wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) { /* tidak didukung */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  keepAwake();

  /* layar penuh: butuh satu sentuhan pengguna */
  const root = document.documentElement, canFS = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  const gate = document.createElement('div');
  gate.className = 'kiosk-gate'; gate.hidden = true;
  gate.innerHTML = '<div><b>Sentuh layar untuk memulai</b><small>Mode kiosk · layar penuh</small></div>';
  document.body.appendChild(gate);
  const inFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const syncGate = () => { gate.hidden = !canFS || inFS(); };
  gate.addEventListener('click', async () => {
    try { await (root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen()); } catch (e) { /* ditolak */ }
    keepAwake(); syncGate(); if (!inFS()) gate.hidden = true;
  });
  document.addEventListener('fullscreenchange', syncGate);
  document.addEventListener('webkitfullscreenchange', syncGate);
  syncGate();

  /* peringatan sebelum reset */
  const warn = document.createElement('div');
  warn.className = 'kiosk-warn'; warn.hidden = true;
  warn.innerHTML = '<b id="kwT"></b><small>Sentuh layar untuk melanjutkan</small>';
  document.body.appendChild(warn);
  function hideWarn() { warn.hidden = true; }

  /* apa yang perlu dibersihkan? foto di layar atau jendela yang terbuka */
  const modalOpen = () => { const m = $id('modal'); return !!(m && m.classList.contains('open')); };
  const dirty = () => (typeof shots !== 'undefined' && shots.length > 0) || modalOpen();
  const holding = () => (typeof busy !== 'undefined' && busy) || (window.Bruni && Bruni.pending);   // sedang memotret / menunggu pembayaran

  setInterval(() => {
    if (!idleSec) {
      const c = window.Bruni && Bruni.cfg; if (c && c.kiosk) idleSec = +c.kiosk.idleSeconds || 0;
      if (!idleSec) return;
    }
    if (holding()) { last = Date.now(); return; }
    if (!dirty()) { hideWarn(); return; }
    const left = idleSec - Math.floor((Date.now() - last) / 1000);
    if (left <= 0) { location.reload(); return; }
    if (left <= 10) { warn.hidden = false; $id('kwT').textContent = 'Layar akan direset dalam ' + left + ' detik'; } else hideWarn();
  }, 1000);
})();
