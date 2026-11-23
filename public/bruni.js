/* Bruni Coffee Lab — paket sesi, QRIS, token, dan QR unduh soft file.
   Bergantung pada skrip studio (shots, strip, snapshot, session, startBtn, toast, confetti, render, BRAND)
   dan window.__bruni (modal). Tanpa server → mode mandiri tanpa pembayaran. */
(function () {
  'use strict';
  const LSK = 'bruni-token', LSO = 'bruni-order';
  const $id = id => document.getElementById(id);
  const modalEl = $id('modal');
  const fmt = n => 'Rp' + Number(n).toLocaleString('id-ID');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* opsional */ } }
  };
  async function api(p, o) {
    const r = await fetch('api/' + p, o); let j = {};
    try { j = await r.json(); } catch (e) { /* kosong */ }
    if (!r.ok) { const e = new Error(j.error || ('Kesalahan ' + r.status)); e.status = r.status; throw e; }
    return j;
  }
  const post = (p, b, h) => api(p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: JSON.stringify(b || {}) });
  const B = window.Bruni = { cfg: null, code: ls.get(LSK), st: null, ticket: null, pending: null };
  const body = () => $id('mbody');
  const modalOpen = () => modalEl.classList.contains('open');
  let view = 0, timers = [];
  const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
  const setView = html => { view++; clearTimers(); body().innerHTML = html; return view; };

  /* ---------- Status & tampilan ---------- */
  function updateUI() {
    const bar = $id('paybar'), on = !!(B.cfg && B.cfg.paywall);
    bar.hidden = !on;
    if (!on) { startBtn.textContent = 'Mulai foto'; return; }
    const st = B.st, rem = st && st.valid ? st.remaining : 0, pb = $id('pb');
    const t = $id('pbTitle'), s = $id('pbSub');
    pb.className = 'pb' + (rem > 0 ? ' ok' : B.pending ? ' wait' : '');
    if (rem > 0) {
      t.textContent = 'Sisa ' + rem + ' dari ' + st.total + ' sesi';
      s.innerHTML = 'Kode <code class="tk">' + esc(B.code) + '</code>' + (st.expiresAt ? ' · berlaku s/d ' + new Date(st.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : '');
    } else if (B.pending) {
      t.textContent = 'Menunggu pembayaran'; s.textContent = B.pending.pkgName + ' · ' + fmt(B.pending.amount);
    } else if (B.code && st && st.valid) {
      t.textContent = 'Sesi habis'; s.innerHTML = 'Kode <code class="tk">' + esc(B.code) + '</code> sudah terpakai semua';
    } else { t.textContent = 'Belum ada sesi aktif'; s.textContent = 'Beli paket lewat QRIS atau masukkan kode untuk mulai foto'; }
    $id('pbBuy').textContent = B.pending && rem <= 0 ? 'Lanjutkan pembayaran' : 'Beli sesi';
    $id('pbOut').hidden = !B.code;
    startBtn.textContent = rem > 0 ? 'Mulai foto · sisa ' + rem : 'Beli sesi & mulai';
  }
  function setCode(code, st) { B.code = code; B.st = st || null; ls.set(LSK, code); updateUI(); }
  async function refresh() {
    if (!B.code) { B.st = null; return updateUI(); }
    try {
      const r = await post('token/check', { code: B.code });
      if (!r.valid) { toast(r.reason || 'Kode tidak aktif', 'err'); setCode(null, null); } else { B.st = r; updateUI(); }
    } catch (e) { updateUI(); }
  }

  /* ---------- Beli: pilih paket ---------- */
  function showPkgs() {
    setView(`<div class="buy"><span class="tagc">Bayar pakai QRIS</span><h3 id="mTitle" style="margin-top:8px">Pilih paket sesi</h3>
      <p class="note" style="margin:0">Satu sesi = satu kali sesi foto (hitung mundur + semua frame layout). Ulang satu foto dalam sesi yang sama gratis.</p>
      <div class="pkgs">${B.cfg.packages.map(p => `<button type="button" class="pkg" data-id="${esc(p.id)}">${p.popular ? '<span class="ribbon">Populer</span>' : ''}<b>${esc(p.name)}</b><span class="p">${fmt(p.price)}</span><small>${esc(p.note || '')}</small></button>`).join('')}</div>
      <p class="errl" id="buyErr"></p>
      <div class="row left"><button type="button" class="btn small" id="toRedeem">Punya kode? Masukkan</button></div></div>`);
    body().querySelectorAll('.pkg').forEach(b => b.onclick = () => choose(b.dataset.id));
    $id('toRedeem').onclick = showRedeem;
  }
  async function choose(id) {
    const err = $id('buyErr'); if (err) err.textContent = '';
    body().querySelectorAll('.pkg').forEach(b => b.disabled = true);
    try { const o = await post('orders', { packageId: id }); B.pending = o; updateUI(); showPay(o); }
    catch (e) { showPkgs(); const er = $id('buyErr'); if (er) er.textContent = e.message; }
  }

  /* ---------- Bayar: tampilkan QRIS & tunggu ---------- */
  function showPay(o) {
    const my = setView(`<div class="payv"><span class="tagc">${esc(o.pkgName)} · ${o.sessions} sesi</span><h3 id="mTitle">Scan QRIS untuk bayar</h3>
      ${o.demo ? '<div class="demo-b"><b>MODE DEMO</b> — QRIS merchant belum diatur, QR ini tidak bisa dibayar. Kasir menekan “Terima” di panel admin untuk uji coba.</div>' : ''}
      <div class="qrisbox" id="qrisbox"></div>
      <div class="amt-big">${fmt(o.amount)}</div>
      <p class="note" style="margin:0;max-width:38ch">${o.unique ? 'Bayar <b>tepat</b> ' + fmt(o.amount) + ' (sudah termasuk kode unik ' + o.unique + ').' : 'Nominal sudah terisi otomatis di QRIS.'} Bisa dari GoPay, OVO, DANA, ShopeePay, LinkAja, atau m-banking.</p>
      <div class="timer" id="payTimer"></div>
      <div id="payStat"><span class="spin"></span>Menunggu pembayaran…</div>
      <div class="row"><button type="button" class="btn small" id="payBack">Ganti paket</button><button type="button" class="btn small" id="payCancel">Batalkan</button></div></div>`);
    ls.set(LSO, o.id);
    try { $id('qrisbox').appendChild(BruniQR.toCanvas(o.qris, { ecl: 'M', scale: 6, quiet: 2 })); }
    catch (e) { $id('qrisbox').textContent = 'QR gagal dibuat'; }
    const tick = () => {
      if (my !== view) return;
      const left = o.expiresAt - Date.now(), t = $id('payTimer'); if (!t) return;
      if (left > 0) { t.className = 'timer'; t.textContent = 'QR berlaku ' + String(Math.floor(left / 60000)).padStart(2, '0') + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0'); }
      else { t.className = 'timer late'; t.textContent = 'QR sudah kedaluwarsa — jangan dibayar lagi'; }
    };
    tick(); timers.push(setInterval(tick, 1000));
    timers.push(setInterval(async () => {
      if (my !== view || !modalOpen()) { clearTimers(); return; }
      try {
        const r = await api('orders/' + o.id);
        if (my !== view) return;
        if (r.status === 'paid') paid(r);
        else if (r.status === 'expired' || r.status === 'cancelled') { B.pending = null; ls.set(LSO, null); updateUI(); expired(); }
      } catch (e) { /* coba lagi */ }
    }, 2500));
    $id('payBack').onclick = async () => { try { await post('orders/' + o.id + '/cancel'); } catch (e) { /* abaikan */ } B.pending = null; ls.set(LSO, null); updateUI(); showPkgs(); };
    $id('payCancel').onclick = async () => { try { await post('orders/' + o.id + '/cancel'); } catch (e) { /* abaikan */ } B.pending = null; ls.set(LSO, null); updateUI(); __bruni.closeModal(); };
  }
  function expired() {
    setView(`<div class="okv"><h3 id="mTitle">Pesanan berakhir</h3><p class="note" style="margin:0">Waktu pembayaran habis. Kalau sudah terlanjur bayar, hubungi kasir dengan bukti transfer.</p><div class="row"><button type="button" class="btn primary" id="again">Buat pesanan baru</button></div></div>`);
    $id('again').onclick = showPkgs;
  }
  async function paid(r) {
    B.pending = null; ls.set(LSO, null);
    setCode(r.token, null); await refresh();
    setView(`<div class="okv"><span class="tagc">Pembayaran diterima ✓</span><h3 id="mTitle">${r.sessions} sesi aktif, selamat ngopi!</h3>
      <p class="note" style="margin:0">Simpan kode ini kalau mau melanjutkan di perangkat lain:</p>
      <div class="tokbig">${esc(r.token)}</div>
      <div class="row"><button type="button" class="btn primary big" id="go">Mulai foto</button><button type="button" class="btn" id="cpy">Salin kode</button></div></div>`);
    if (typeof confetti === 'function') confetti();
    $id('go').onclick = () => { __bruni.closeModal(); __bruni.gotoStudio(); };
    $id('cpy').onclick = () => navigator.clipboard && navigator.clipboard.writeText(r.token).then(() => toast('Kode disalin.', 'ok'), () => {});
  }

  /* ---------- Masukkan kode ---------- */
  function showRedeem() {
    setView(`<div class="buy"><h3 id="mTitle">Masukkan kode sesi</h3><p class="note" style="margin:6px 0 14px">Kode dari pembelian sebelumnya atau voucher dari kasir.</p>
      <form id="rf" class="payv" style="gap:10px"><input type="text" id="rc" placeholder="BRN-XXXX-XXXX" maxlength="16" autocomplete="off" autocapitalize="characters" spellcheck="false" style="text-align:center;font-weight:800;letter-spacing:.08em"><p class="errl" id="rerr"></p>
      <div class="row"><button type="submit" class="btn primary">Pakai kode</button><button type="button" class="btn" id="rb">Beli paket</button></div></form></div>`);
    $id('rb').onclick = showPkgs;
    $id('rc').focus();
    $id('rf').onsubmit = async e => {
      e.preventDefault();
      const code = $id('rc').value.trim(); if (!code) return;
      try {
        const r = await post('token/check', { code });
        if (!r.valid) throw new Error(r.reason || 'Kode tidak valid');
        if (r.remaining <= 0) throw new Error('Sesi pada kode ini sudah habis');
        setCode(r.code, r); __bruni.closeModal(); toast('Kode aktif: sisa ' + r.remaining + ' sesi.', 'ok');
      } catch (er) { $id('rerr').textContent = er.message; }
    };
  }

  function openBuy(pkgId) {
    if (!B.cfg || !B.cfg.paywall) return;
    __bruni.openModal('');
    if (B.pending && !pkgId) return showPay(B.pending);
    pkgId ? choose(pkgId) : showPkgs();
  }

  /* ---------- Gerbang sesi ---------- */
  B.gate = async function () {
    if (!B.cfg || !B.cfg.paywall) return true;
    if (!B.code || !B.st || !B.st.valid || B.st.remaining <= 0) { openBuy(); return false; }
    try {
      const r = await post('token/use', { code: B.code });
      B.ticket = r.ticket; B.st = r; updateUI();
      if (r.remaining === 0) toast('Ini sesi terakhir di kodemu.', 'ok');
      return true;
    } catch (e) { toast(e.message, 'err'); await refresh(); openBuy(); return false; }
  };
  B.startSession = async function () {
    if (typeof busy !== 'undefined' && busy) return;
    if (await B.gate()) session();
  };

  /* ---------- QR unduh soft file ---------- */
  const blobP = (type, q) => new Promise(res => strip.toBlob(res, type, q));
  async function put(blob, id) {
    const h = { 'Content-Type': blob.type };
    if (B.ticket) h['X-Ticket'] = B.ticket;
    const r = await fetch('api/share' + (id ? '?id=' + encodeURIComponent(id) : ''), { method: 'POST', headers: h, body: blob });
    let j = {}; try { j = await r.json(); } catch (e) { /* kosong */ }
    if (!r.ok) { const e = new Error(j.error || 'Gagal mengunggah'); e.status = r.status; throw e; }
    return j;
  }
  async function shareQR() {
    if (!shots.length) return;
    if (!B.cfg) { toast('QR unduh butuh server Bruni (jalankan node server.js).', 'err'); return; }
    __bruni.openModal('');
    setView('<div class="shv"><h3 id="mTitle">Menyiapkan QR…</h3><p class="note" style="margin:0"><span class="spin"></span>Mengunggah foto ke tautan sementara</p></div>');
    const my = view;
    try {
      const [pngP, jpgP] = snapshot(() => [blobP('image/png'), blobP('image/jpeg', .92)]);
      const [png, jpg] = await Promise.all([pngP, jpgP]);
      const a = await put(png);
      let res = a;
      try { res = await put(jpg, a.id); } catch (e) { /* JPG opsional */ }
      if (my !== view) return;
      const host = new URL(a.url).hostname, priv = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || location.protocol === 'http:' && !/^https/.test(a.url);
      const hrs = Math.round((a.expiresAt - Date.now()) / 3600e3);
      setView(`<div class="shv"><span class="tagc">Foto siap ✓</span><h3 id="mTitle">Scan untuk unduh foto</h3>
        <p class="note" style="margin:0;max-width:36ch">Arahkan kamera HP ke QR ini, lalu simpan PNG/JPG. Tautan aktif ±${hrs} jam, setelah itu foto dihapus dari server.</p>
        <div class="qrisbox" id="shbox"></div><div class="lnk" id="shlnk">${esc(a.url)}</div>
        ${priv ? '<div class="warn-b">QR ini memakai alamat lokal (<b>' + esc(host) + '</b>) sehingga hanya terbuka di Wi-Fi yang sama. Untuk umum, isi <code>baseUrl</code> di config.json dengan alamat publik HTTPS.</div>' : ''}
        <div class="row"><button type="button" class="btn" id="shcp">Salin tautan</button><button type="button" class="btn primary" id="shx">Selesai</button></div></div>`);
      $id('shbox').appendChild(BruniQR.toCanvas(a.url, { ecl: 'M', scale: 6, quiet: 2 }));
      $id('shcp').onclick = () => navigator.clipboard && navigator.clipboard.writeText(a.url).then(() => toast('Tautan disalin.', 'ok'), () => {});
      $id('shx').onclick = () => __bruni.closeModal();
    } catch (e) {
      if (my !== view) return;
      setView(`<div class="shv"><h3 id="mTitle">QR belum bisa dibuat</h3><p class="errl">${esc(e.message)}</p>${e.status === 401 ? '<p class="note" style="margin:0">Mulai sesi foto baru agar tiket unggah aktif kembali.</p>' : ''}<div class="row"><button type="button" class="btn primary" id="shr">Coba lagi</button></div></div>`);
      $id('shr').onclick = shareQR;
    }
  }
  $id('qr').onclick = shareQR;

  /* ---------- Harga di landing ---------- */
  function renderPrices() {
    const sec = $id('harga'), nav = $id('navHarga'), box = $id('prices');
    if (!B.cfg) { sec.hidden = true; if (nav) nav.hidden = true; return; }
    if (!B.cfg.paywall) { box.outerHTML = '<div class="price-free" id="prices"><b>Photobooth sedang gratis.</b> Nyalakan kamera di studio dan langsung foto-foto.</div>'; return; }
    box.innerHTML = B.cfg.packages.map(p => `<div class="price${p.popular ? ' pop' : ''}">${p.popular ? '<span class="ribbon">Populer</span>' : ''}<h3>${esc(p.name)}</h3><div class="amt">${fmt(p.price)}</div><div class="per">${esc(p.note || '')} · ${fmt(Math.round(p.price / p.sessions))}/sesi</div><button type="button" class="btn primary" data-id="${esc(p.id)}">Beli ${esc(p.name)}</button></div>`).join('');
    box.querySelectorAll('button[data-id]').forEach(b => b.onclick = () => openBuy(b.dataset.id));
  }

  /* ---------- Mulai ---------- */
  $id('pbBuy').onclick = () => openBuy();
  $id('pbCode').onclick = () => { __bruni.openModal(''); showRedeem(); };
  $id('pbOut').onclick = () => {
    if (!confirm('Lepas kode dari perangkat ini?\nSimpan dulu kodenya: ' + B.code)) return;
    setCode(null, null); B.ticket = null; toast('Kode dilepas dari perangkat ini.');
  };
  (async function init() {
    try { B.cfg = await api('config'); } catch (e) { B.cfg = null; }
    if (B.cfg) {
      if (B.cfg.brand && B.cfg.brand.name) { BRAND = B.cfg.brand.name; render(); }
      const oid = ls.get(LSO);
      if (oid) {
        try {
          const r = await api('orders/' + oid);
          if (r.status === 'paid') { setCode(r.token, null); toast('Pembayaran sebelumnya sudah diterima.', 'ok'); }
          else if (r.status === 'pending') B.pending = r;
          else ls.set(LSO, null);
        } catch (e) { ls.set(LSO, null); }
      }
    }
    renderPrices(); await refresh(); updateUI();
  })();
})();
