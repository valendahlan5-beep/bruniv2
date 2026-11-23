// Tes alur end-to-end: order → QRIS → konfirmasi → token → sesi → unggah → unduh → admin → webhook
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruni-'));
process.env.BRUNI_DATA = dir; process.env.BRUNI_CONFIG = path.join(dir, 'none.json'); process.env.PORT = '0'; process.env.ADMIN_PIN = '246810';
const S = require('../server.js');
(async () => {
  await S.start(0); const base = 'http://127.0.0.1:' + S.server.address().port;
  const j = async (p, o = {}) => { const r = await fetch(base + p, o); const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; } return { s: r.status, b, h: r.headers }; };
  const P = (p, body, h = {}) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
  let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log('  ✓', m); };

  const cfg = (await j('/api/config')).b; ok(cfg.paywall && cfg.packages.length === 3 && cfg.demo, 'config: paywall aktif, 3 paket, mode demo');
  let r = await P('/api/orders', { packageId: 'nope' }); ok(r.s === 400, 'paket tidak dikenal ditolak');
  r = await P('/api/orders', { packageId: 'trio' }); const o = r.b; ok(r.s === 201 && o.status === 'pending', 'order dibuat');
  ok(o.amount > 40000 && o.amount < 40100 && o.amount - 40000 === o.unique, 'nominal = harga + kode unik (' + o.amount + ')');
  const body = o.qris.slice(0, -4); ok(S.crc16(body) === o.qris.slice(-4), 'CRC16 QRIS dinamis valid');
  const tl = Object.fromEntries(S.parseTLV(o.qris)); ok(tl['01'] === '12' && tl['54'] === String(o.amount), 'QRIS dinamis: tag 01=12, tag 54=nominal');
  r = await j('/api/orders/' + o.id); ok(r.b.status === 'pending' && !r.b.token, 'status pending, belum ada token');
  r = await P('/api/token/use', { code: 'BRN-AAAA-BBBB' }); ok(r.s === 403, 'token palsu ditolak');
  r = await j('/api/admin/orders'); ok(r.s === 401, 'admin tanpa login ditolak');
  r = await P('/api/admin/login', { pin: '000000' }); ok(r.s === 401, 'PIN salah ditolak');
  r = await P('/api/admin/login', { pin: '246810' }); const A = { Authorization: 'Bearer ' + r.b.token }; ok(r.s === 200, 'login admin');
  r = await P('/api/admin/orders/' + o.id + '/confirm', {}, A); ok(r.s === 200 && /^BRN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.b.token), 'kasir terima → token ' + r.b.token);
  const code = r.b.token;
  r = await j('/api/orders/' + o.id); ok(r.b.status === 'paid' && r.b.token === code, 'pelanggan menerima token via polling');
  r = await P('/api/admin/orders/' + o.id + '/confirm', {}, A); ok(r.b.token === code, 'konfirmasi ganda idempoten (token sama)');
  r = await P('/api/token/check', { code: code.toLowerCase().replace(/-/g, ' ') }); ok(r.b.valid && r.b.remaining === 3, 'cek token (format longgar), sisa 3');
  const u = []; for (let i = 0; i < 3; i++) u.push((await P('/api/token/use', { code })).b); ok(u[2].remaining === 0 && u[0].ticket, '3 sesi terpakai → sisa 0');
  r = await P('/api/token/use', { code }); ok(r.s === 402, 'sesi ke-4 ditolak (402)');
  // unggah foto
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), crypto.randomBytes(500)]);
  const up = (buf, type, q, tk) => j('/api/share' + (q || ''), { method: 'POST', headers: { 'Content-Type': type, ...(tk === null ? {} : { 'X-Ticket': tk || u[0].ticket }) }, body: buf });
  r = await up(png, 'image/png', '', null); ok(r.s === 401, 'unggah tanpa tiket ditolak');
  r = await up(png, 'image/png', '', 'x.y'); ok(r.s === 401, 'tiket palsu ditolak');
  r = await up(Buffer.from('<script>alert(1)</script>'.repeat(10)), 'image/png'); ok(r.s === 400, 'berkas bukan PNG (magic byte) ditolak');
  r = await up(png, 'text/html'); ok(r.s === 415, 'tipe selain PNG/JPEG ditolak');
  r = await up(png, 'image/png'); const sh = r.b; ok(r.s === 201 && sh.url.endsWith('/s/' + sh.id), 'unggah PNG → ' + sh.url);
  const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(400)]);
  r = await up(jpg, 'image/jpeg', '?id=' + sh.id); ok(r.s === 201 && r.b.files.length === 2, 'JPG ditambahkan ke tautan yang sama');
  r = await j('/s/' + sh.id); ok(r.s === 200 && /Unduh PNG/.test(r.b) && /Unduh JPG/.test(r.b), 'halaman unduh tampil');
  const dl = await fetch(base + '/f/' + sh.id + '/png?dl=1'); const buf = Buffer.from(await dl.arrayBuffer());
  ok(dl.status === 200 && buf.equals(png) && /attachment/.test(dl.headers.get('content-disposition')), 'unduh PNG utuh (byte sama)');
  r = await j('/f/' + sh.id + '/gif'); ok(r.s === 404, 'ekstensi lain 404');
  r = await j('/f/..%2F..%2Fdata%2Fdb/png'); ok(r.s === 403 || r.s === 404, 'path traversal ditolak (' + r.s + ')');
  r = await j('/..%2fserver.js'); ok(r.s === 403 || r.s === 404, 'static path traversal ditolak (' + r.s + ')');
  // admin
  r = await j('/api/admin/summary', { headers: A }); ok(r.b.today.revenue === 40000 && r.b.sessionsUsed === 3 && r.b.activeShares === 1, 'ringkasan: omzet Rp40.000, 3 sesi terpakai, 1 tautan');
  r = await P('/api/admin/vouchers', { sessions: 2, count: 3, validDays: 7, note: 'tes' }, A); ok(r.s === 201 && r.b.tokens.length === 3, 'voucher dibuat (3)');
  const v = r.b.tokens[0].code; r = await P('/api/admin/tokens/' + v + '/revoke', {}, A); r = await P('/api/token/use', { code: v }); ok(r.s === 403, 'voucher dinonaktifkan ditolak');
  r = await P('/api/admin/tokens/' + v + '/restore', {}, A); r = await P('/api/admin/tokens/' + v + '/add', { sessions: 1 }, A); r = await P('/api/token/check', { code: v }); ok(r.b.remaining === 3, 'voucher diaktifkan + tambah sesi → 3');
  const csv = await fetch(base + '/api/admin/export.csv', { headers: A }); ok(csv.status === 200 && (await csv.text()).includes(code), 'CSV memuat token');
  // webhook generik
  r = await P('/api/orders', { packageId: 'single' }); const o2 = r.b;
  const wb = JSON.stringify({ order_id: o2.id, status: 'paid', amount: o2.amount, ref: 'BANK123' });
  const sig = crypto.createHmac('sha256', S.cfg.webhookSecret).update(wb).digest('hex');
  r = await j('/api/webhook/payment', { method: 'POST', body: wb, headers: { 'X-Signature': 'deadbeef' } }); ok(r.s === 401, 'webhook signature salah ditolak');
  const wbBad = JSON.stringify({ order_id: o2.id, status: 'paid', amount: 1 });
  r = await j('/api/webhook/payment', { method: 'POST', body: wbBad, headers: { 'X-Signature': crypto.createHmac('sha256', S.cfg.webhookSecret).update(wbBad).digest('hex') } }); ok(r.s === 409, 'webhook nominal tidak cocok ditolak');
  r = await j('/api/webhook/payment', { method: 'POST', body: wb, headers: { 'X-Signature': sig } }); ok(r.s === 200, 'webhook valid diterima');
  r = await j('/api/orders/' + o2.id); ok(r.b.status === 'paid' && r.b.token, 'order via webhook lunas + token');
  // midtrans signature
  S.cfg.midtrans.serverKey = 'SB-KEY';
  r = await P('/api/orders', { packageId: 'single' }); const o3 = r.b; // mode manual → tetap order biasa
  const ms = (st, amt) => crypto.createHash('sha512').update(o3.id + '200' + amt + 'SB-KEY').digest('hex');
  r = await P('/api/webhook/midtrans', { order_id: o3.id, status_code: '200', gross_amount: o3.amount + '.00', signature_key: 'x', transaction_status: 'settlement' }); ok(r.s === 401, 'midtrans signature salah ditolak');
  r = await P('/api/webhook/midtrans', { order_id: o3.id, status_code: '200', gross_amount: o3.amount + '.00', signature_key: ms('', o3.amount + '.00'), transaction_status: 'settlement' }); ok(r.s === 200 && (await j('/api/orders/' + o3.id)).b.status === 'paid', 'midtrans settlement valid → lunas');
  // rate limit login
  let last; for (let i = 0; i < 7; i++) last = await P('/api/admin/login', { pin: 'salah' }); ok(last.s === 429, 'brute-force PIN dibatasi (429)');
  r = await j('/s/doesnotexist'); ok(r.s === 410, 'tautan tak dikenal → halaman berakhir (410)');
  console.log('\nSemua ' + n + ' pemeriksaan lulus.'); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
