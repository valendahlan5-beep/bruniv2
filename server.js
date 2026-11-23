#!/usr/bin/env node
/* Bruni Coffee Lab — Photobooth server (Node >= 18, tanpa dependensi)
   Fitur: paket sesi/token, QRIS dinamis, konfirmasi kasir / webhook, redeem token,
   upload foto + tautan unduh (QR), panel admin, laporan penjualan. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.BRUNI_DATA || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = process.env.BRUNI_CONFIG || path.join(ROOT, 'config.json');
const SHARE_DIR = path.join(DATA_DIR, 'shares');
fs.mkdirSync(SHARE_DIR, { recursive: true });

/* ---------------- Konfigurasi ---------------- */
const DEFAULTS = {
  port: 3000,
  baseUrl: '',                       // URL publik/LAN untuk tautan unduh, mis. https://photo.brunicoffeelab.id
  brand: { name: 'Bruni Coffee Lab', tagline: 'Brew your moment. Frame your vibe.' },
  paywall: true,                     // false = gratis (tanpa token)
  packages: [
    { id: 'single', name: '1 Sesi', sessions: 1, price: 15000, note: '1 strip foto' },
    { id: 'trio', name: '3 Sesi', sessions: 3, price: 40000, note: 'Hemat Rp5.000', popular: true },
    { id: 'party', name: '6 Sesi', sessions: 6, price: 75000, note: 'Untuk rombongan' }
  ],
  qris: {
    mode: 'manual',                  // manual | webhook | midtrans
    staticString: '',                // isi dengan string QRIS statis merchant (hasil decode QR QRIS Anda)
    uniqueCode: true,                // tambah 1–99 rupiah agar kasir mudah mencocokkan mutasi
    expiryMinutes: 10
  },
  token: { validDays: 30 },          // masa berlaku token hasil pembelian
  share: { ttlHours: 24, maxMb: 12 },
  adminPin: '',                      // kosong = dibuat acak saat pertama jalan
  webhookSecret: '',                 // kosong = dibuat acak saat pertama jalan
  midtrans: { serverKey: '', production: false },
  ui: { defaultSecs: 3, idleSeconds: 90 }   // hitung mundur bawaan (detik) & reset otomatis mode kiosk (0 = mati)
};
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { const o = { ...a }; for (const k in b) o[k] = isObj(a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k]; return o; };
let userCfg = {};
try { userCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error('config.json tidak valid:', e.message); process.exit(1); } }
const cfg = merge(DEFAULTS, userCfg);
const env = process.env;
if (env.PORT) cfg.port = +env.PORT;
if (env.BASE_URL) cfg.baseUrl = env.BASE_URL;
if (env.ADMIN_PIN) cfg.adminPin = env.ADMIN_PIN;
if (env.QRIS_STATIC) cfg.qris.staticString = env.QRIS_STATIC;
if (env.WEBHOOK_SECRET) cfg.webhookSecret = env.WEBHOOK_SECRET;
if (env.MIDTRANS_SERVER_KEY) cfg.midtrans.serverKey = env.MIDTRANS_SERVER_KEY;

// rahasia yang dibuat otomatis disimpan di data/secrets.json (bukan di config.json)
const SECRET_FILE = path.join(DATA_DIR, 'secrets.json');
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')); } catch (e) { /* baru */ }
let generated = false;
if (!secrets.signKey) { secrets.signKey = crypto.randomBytes(32).toString('hex'); generated = true; }
if (!cfg.adminPin) { if (!secrets.adminPin) { secrets.adminPin = String(crypto.randomInt(100000, 1000000)); generated = true; } cfg.adminPin = secrets.adminPin; }
if (!cfg.webhookSecret) { if (!secrets.webhookSecret) { secrets.webhookSecret = crypto.randomBytes(24).toString('hex'); generated = true; } cfg.webhookSecret = secrets.webhookSecret; }
if (generated) fs.writeFileSync(SECRET_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });

/* ---------------- Database JSON (atomik) ---------------- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { orders: {}, tokens: {}, shares: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { /* baru */ }
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 150); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } catch (e) { /* abaikan */ } process.exit(0); });
process.on('exit', () => { if (saveTimer) try { flush(); } catch (e) { /* abaikan */ } });

/* ---------------- Util ---------------- */
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString('base64url');
const CODE_AL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let s = ''; for (let i = 0; i < 8; i++) s += CODE_AL[crypto.randomInt(CODE_AL.length)];
    const code = 'BRN-' + s.slice(0, 4) + '-' + s.slice(4);
    if (!db.tokens[code]) return code;
  }
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BRN/, '').replace(/^(.{4})(.{4}).*$/, 'BRN-$1-$2');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = (s, alg = 'sha256') => crypto.createHmac(alg, secrets.signKey).update(s).digest('base64url');
const sign = (obj, ttlMs) => { const p = Buffer.from(JSON.stringify({ ...obj, e: now() + ttlMs })).toString('base64url'); return p + '.' + hmac(p); };
function verify(tok) {
  const [p, s] = String(tok || '').split('.');
  if (!p || !s || !eq(hmac(p), s)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > now() ? o : null; } catch (e) { return null; }
}
const rupiah = n => 'Rp' + Number(n).toLocaleString('id-ID');
const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* ---------------- QRIS (EMV QR Code) ---------------- */
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function parseTLV(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    if (i + 4 > s.length) throw new Error('TLV terpotong');
    const tag = s.slice(i, i + 2), len = parseInt(s.slice(i + 2, i + 4), 10);
    if (!/^\d\d$/.test(tag) || !Number.isInteger(len) || i + 4 + len > s.length) throw new Error('TLV tidak valid');
    out.push([tag, s.slice(i + 4, i + 4 + len)]); i += 4 + len;
  }
  return out;
}
function validateStaticQris(s) {
  const body = s.slice(0, -4);
  if (s.slice(-8, -4) !== '6304') throw new Error('QRIS tidak diakhiri tag CRC (6304xxxx)');
  if (crc16(body).toLowerCase() !== s.slice(-4).toLowerCase()) throw new Error('CRC QRIS tidak cocok — string QRIS salah/terpotong');
  const t = Object.fromEntries(parseTLV(s));
  return { merchant: t['59'] || '', city: t['60'] || '' };
}
// Ubah QRIS statis → dinamis dengan nominal (tag 01=12, tag 54=nominal, hitung ulang CRC)
function dynamicQris(staticStr, amount) {
  const tlv = parseTLV(staticStr.slice(0, -8)).filter(([t]) => t !== '54' && t !== '63');
  const set = (tag, val) => { const i = tlv.findIndex(([t]) => t === tag); if (i >= 0) tlv[i][1] = val; else tlv.push([tag, val]); };
  set('01', '12'); set('54', String(amount));
  tlv.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const body = tlv.map(([t, v]) => t + String(v.length).padStart(2, '0') + v).join('') + '6304';
  return body + crc16(body);
}
// String contoh untuk MODE DEMO (bukan QRIS yang bisa dibayar)
function demoStaticQris() {
  const f = (t, v) => t + String(v.length).padStart(2, '0') + v;
  const body = f('00', '01') + f('01', '11') + f('26', f('00', 'ID.DEMO.WWW') + f('01', 'DEMO000000') + f('02', 'DEMO') + f('03', 'UMI')) + f('51', f('00', 'ID.CO.QRIS.WWW')) + f('52', '5812') + f('53', '360') + f('58', 'ID') + f('59', 'BRUNI COFFEE LAB (DEMO)') + f('60', 'JAKARTA') + '6304';
  return body + crc16(body);
}
let qrisInfo = { configured: false, demo: true, merchant: 'BRUNI COFFEE LAB (DEMO)', city: 'JAKARTA', error: '' };
let STATIC_QRIS = demoStaticQris();
if (cfg.qris.staticString) {
  try {
    const s = cfg.qris.staticString.trim();
    const info = validateStaticQris(s);
    STATIC_QRIS = s; qrisInfo = { configured: true, demo: false, ...info, error: '' };
  } catch (e) { qrisInfo.error = e.message; console.error('⚠ QRIS:', e.message, '— memakai MODE DEMO'); }
}

/* ---------------- Order & token ---------------- */
const pkgById = id => cfg.packages.find(p => p.id === id);
function uniqueAmount(price) {
  if (!cfg.qris.uniqueCode) return { amount: price, unique: 0 };
  const used = new Set(Object.values(db.orders).filter(o => o.status === 'pending').map(o => o.amount));
  for (let i = 0; i < 200; i++) {
    const u = crypto.randomInt(1, 100);
    if (!used.has(price + u)) return { amount: price + u, unique: u };
  }
  throw httpErr(503, 'Terlalu banyak pesanan tertunda, coba lagi sebentar');
}
function issueToken({ sessions, source, orderId, note, validDays }) {
  const code = newCode(), t = {
    code, sessions, used: 0, source, orderId: orderId || null, note: note || '', createdAt: now(),
    expiresAt: validDays ? now() + validDays * 864e5 : null, revoked: false, uploads: 0, lastUsedAt: null
  };
  db.tokens[code] = t; save(); return t;
}
function markPaid(order, by, ref) {
  if (order.status === 'paid') return order;
  if (order.status === 'cancelled') throw httpErr(409, 'Pesanan sudah dibatalkan');
  // pesanan kedaluwarsa yang tetap dibayar: tetap diterima (uang sudah masuk)
  order.status = 'paid'; order.paidAt = now(); order.paidBy = by; if (ref) order.ref = ref;
  const t = issueToken({ sessions: order.sessions, source: 'order', orderId: order.id, validDays: cfg.token.validDays, note: order.pkgName });
  order.token = t.code; save(); return order;
}
const publicOrder = o => ({
  id: o.id, status: o.status, amount: o.amount, price: o.price, unique: o.unique, pkgName: o.pkgName, sessions: o.sessions,
  expiresAt: o.expiresAt, qris: o.status === 'pending' ? o.qris : undefined, demo: o.demo,
  token: o.status === 'paid' ? o.token : undefined
});
function tokenState(t) {
  if (!t) return { valid: false, reason: 'Kode tidak ditemukan' };
  if (t.revoked) return { valid: false, reason: 'Kode dinonaktifkan' };
  if (t.expiresAt && t.expiresAt < now()) return { valid: false, reason: 'Kode sudah kedaluwarsa' };
  const remaining = t.sessions - t.used;
  return { valid: true, code: t.code, remaining, total: t.sessions, expiresAt: t.expiresAt };
}

/* ---------------- HTTP helpers ---------------- */
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(httpErr(413, 'Data terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req, limit = 64 * 1024) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { const o = JSON.parse(b.toString('utf8')); return isObj(o) ? o : {}; } catch (e) { throw httpErr(400, 'JSON tidak valid'); }
}
const TRUST_PROXY = env.TRUST_PROXY === '1';   // aktifkan di balik proxy (Railway) agar pembatasan laju per-klien, bukan per-proxy
const ipOf = req => {
  if (TRUST_PROXY) { const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean); if (xff.length) return xff[xff.length - 1]; }
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
};
const buckets = new Map();
function limit(key, max, windowMs) {
  const t = now(), b = (buckets.get(key) || []).filter(x => t - x < windowMs);
  if (b.length >= max) { buckets.set(key, b); throw httpErr(429, 'Terlalu banyak percobaan, coba lagi nanti'); }
  b.push(t); buckets.set(key, b);
}
function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}
function baseUrl(req) {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/+$/, '');
  const host = req.headers.host || ('localhost:' + cfg.port);
  if (/^(localhost|127\.|\[::1\])/.test(host)) { const ip = lanIP(); if (ip) return 'http://' + ip + ':' + (req.socket.localPort || cfg.port); }
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return proto + '://' + host;
}

/* ---------------- Admin auth ---------------- */
function adminAuth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const o = m && verify(m[1]);
  if (!o || o.r !== 'admin') throw httpErr(401, 'Perlu login admin');
}

/* ---------------- Midtrans (opsional) ---------------- */
const MT_BASE = () => cfg.midtrans.production ? 'https://api.midtrans.com' : (process.env.MIDTRANS_BASE || 'https://api.sandbox.midtrans.com');
async function midtransCharge(order) {
  const r = await fetch(MT_BASE() + '/v2/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(cfg.midtrans.serverKey + ':').toString('base64') },
    body: JSON.stringify({
      payment_type: 'qris', transaction_details: { order_id: order.id, gross_amount: order.amount },
      qris: { acquirer: 'gopay' }, custom_expiry: { expiry_duration: cfg.qris.expiryMinutes, unit: 'minute' }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.qr_string) throw httpErr(502, 'Gateway pembayaran menolak: ' + (j.status_message || r.status));
  return j.qr_string;
}

/* ---------------- Handler API ---------------- */
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

route('GET', /^\/api\/config$/, async (req, res) => json(res, 200, {
  brand: cfg.brand, paywall: cfg.paywall, currency: 'IDR', packages: cfg.packages, qrisMode: cfg.qris.mode,
  defaultSecs: cfg.ui.defaultSecs, kiosk: { idleSeconds: cfg.ui.idleSeconds },
  demo: cfg.paywall && qrisInfo.demo && cfg.qris.mode !== 'midtrans', shareTtlHours: cfg.share.ttlHours, expiryMinutes: cfg.qris.expiryMinutes
}));

route('POST', /^\/api\/orders$/, async (req, res) => {
  if (!cfg.paywall) throw httpErr(400, 'Pembayaran tidak aktif');
  limit('order:' + ipOf(req), 12, 10 * 60e3);
  const b = await readJSON(req), pkg = pkgById(String(b.packageId || ''));
  if (!pkg) throw httpErr(400, 'Paket tidak ditemukan');
  const pending = Object.values(db.orders).filter(o => o.status === 'pending').length;
  if (pending > 200) throw httpErr(503, 'Terlalu banyak pesanan tertunda');
  const { amount, unique } = uniqueAmount(pkg.price);
  const o = {
    id: rid(12), pkgId: pkg.id, pkgName: pkg.name, sessions: pkg.sessions, price: pkg.price, unique, amount,
    status: 'pending', createdAt: now(), expiresAt: now() + cfg.qris.expiryMinutes * 60e3, mode: cfg.qris.mode, demo: false, qris: ''
  };
  if (cfg.qris.mode === 'midtrans') {
    if (!cfg.midtrans.serverKey) throw httpErr(500, 'Midtrans belum dikonfigurasi');
    o.amount = pkg.price; o.unique = 0;
    o.qris = await midtransCharge(o);
  } else {
    o.demo = qrisInfo.demo;
    o.qris = dynamicQris(STATIC_QRIS, o.amount);
  }
  db.orders[o.id] = o; save();
  json(res, 201, publicOrder(o));
});

route('GET', /^\/api\/orders\/([\w-]+)$/, async (req, res, m) => {
  const o = db.orders[m[1]]; if (!o) throw httpErr(404, 'Pesanan tidak ditemukan');
  json(res, 200, publicOrder(o));
});
route('POST', /^\/api\/orders\/([\w-]+)\/cancel$/, async (req, res, m) => {
  const o = db.orders[m[1]]; if (!o) throw httpErr(404, 'Pesanan tidak ditemukan');
  if (o.status === 'pending') { o.status = 'cancelled'; save(); }
  json(res, 200, publicOrder(o));
});

route('POST', /^\/api\/token\/check$/, async (req, res) => {
  limit('tok:' + ipOf(req), 30, 10 * 60e3);
  const b = await readJSON(req);
  json(res, 200, tokenState(db.tokens[normCode(b.code)]));
});
route('POST', /^\/api\/token\/use$/, async (req, res) => {
  limit('use:' + ipOf(req), 60, 10 * 60e3);
  const b = await readJSON(req), t = db.tokens[normCode(b.code)], st = tokenState(t);
  if (!st.valid) throw httpErr(403, st.reason);
  if (st.remaining <= 0) throw httpErr(402, 'Sesi pada kode ini sudah habis');
  t.used++; t.lastUsedAt = now(); save();
  json(res, 200, { ...tokenState(t), ticket: sign({ c: t.code, r: 'share' }, 60 * 60e3) });
});

/* Webhook generik: HMAC-SHA256(rawBody, webhookSecret) di header X-Signature (hex). Body: {order_id, status:"paid", amount, ref} */
route('POST', /^\/api\/webhook\/payment$/, async (req, res) => {
  const raw = await readBody(req, 64 * 1024), sig = String(req.headers['x-signature'] || '');
  const want = crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex');
  if (!sig || !eq(sig.toLowerCase(), want)) throw httpErr(401, 'Signature tidak valid');
  let b; try { b = JSON.parse(raw.toString('utf8')); } catch (e) { throw httpErr(400, 'JSON tidak valid'); }
  const o = db.orders[String(b.order_id || '')];
  if (!o) throw httpErr(404, 'Pesanan tidak ditemukan');
  if (String(b.status).toLowerCase() !== 'paid') return json(res, 200, { ok: true, ignored: true });
  if (Number(b.amount) !== o.amount) throw httpErr(409, 'Nominal tidak cocok');
  markPaid(o, 'webhook', b.ref); json(res, 200, { ok: true });
});
/* Notifikasi Midtrans: signature_key = SHA512(order_id + status_code + gross_amount + serverKey) */
route('POST', /^\/api\/webhook\/midtrans$/, async (req, res) => {
  const b = await readJSON(req);
  if (!cfg.midtrans.serverKey) throw httpErr(500, 'Midtrans belum dikonfigurasi');
  const want = crypto.createHash('sha512').update(String(b.order_id) + String(b.status_code) + String(b.gross_amount) + cfg.midtrans.serverKey).digest('hex');
  if (!eq(String(b.signature_key || ''), want)) throw httpErr(401, 'Signature tidak valid');
  const o = db.orders[String(b.order_id)];
  if (!o) throw httpErr(404, 'Pesanan tidak ditemukan');
  const ok = (b.transaction_status === 'settlement' || b.transaction_status === 'capture') && (!b.fraud_status || b.fraud_status === 'accept');
  if (ok) { if (Math.round(Number(b.gross_amount)) !== o.amount) throw httpErr(409, 'Nominal tidak cocok'); markPaid(o, 'midtrans', b.transaction_id); }
  else if (['expire', 'cancel', 'deny'].includes(b.transaction_status) && o.status === 'pending') { o.status = 'expired'; save(); }
  json(res, 200, { ok: true });
});

/* ---------- Berbagi foto ---------- */
const MIMES = { 'image/png': ['png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], 'image/jpeg': ['jpg', Buffer.from([0xFF, 0xD8, 0xFF])] };
route('POST', /^\/api\/share$/, async (req, res, m, url) => {
  limit('share:' + ipOf(req), 40, 10 * 60e3);
  let tok = null;
  if (cfg.paywall) {
    const o = verify(req.headers['x-ticket']);
    if (!o || o.r !== 'share') throw httpErr(401, 'Tiket sesi tidak valid / kedaluwarsa');
    tok = db.tokens[o.c];
    if (!tok || !tokenState(tok).valid) throw httpErr(403, 'Kode tidak aktif');
    if (tok.uploads >= Math.max(1, tok.used) * 6) throw httpErr(429, 'Batas unggah untuk kode ini tercapai');
  }
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), spec = MIMES[mime];
  if (!spec) throw httpErr(415, 'Hanya PNG atau JPEG');
  const body = await readBody(req, cfg.share.maxMb * 1048576);
  if (body.length < 100 || !body.subarray(0, spec[1].length).equals(spec[1])) throw httpErr(400, 'Berkas bukan gambar ' + spec[0].toUpperCase());
  let id = url.searchParams.get('id'), s;
  if (id) {
    s = db.shares[id];
    if (!s || s.expiresAt < now()) throw httpErr(404, 'Tautan tidak ditemukan / kedaluwarsa');
    if (s.owner !== (tok ? tok.code : ipOf(req))) throw httpErr(403, 'Bukan pemilik tautan');
  } else {
    id = rid(9);
    s = db.shares[id] = { id, createdAt: now(), expiresAt: now() + cfg.share.ttlHours * 3600e3, files: {}, downloads: 0, owner: tok ? tok.code : ipOf(req) };
  }
  if (Object.keys(s.files).length >= 2 && !s.files[spec[0]]) throw httpErr(400, 'Terlalu banyak berkas');
  fs.writeFileSync(path.join(SHARE_DIR, id + '.' + spec[0]), body);
  s.files[spec[0]] = body.length;
  if (tok) tok.uploads++;
  save();
  json(res, 201, { id, url: baseUrl(req) + '/s/' + id, expiresAt: s.expiresAt, files: Object.keys(s.files) });
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sharePage(s) {
  const left = Math.max(0, Math.round((s.expiresAt - now()) / 60000)), name = esc(cfg.brand.name);
  const has = Object.keys(s.files), first = has.includes('jpg') ? 'jpg' : 'png';
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Foto kamu · ${name}</title><meta name="theme-color" content="#120D0A">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(60% 40% at 50% 0%,rgba(212,145,93,.28),transparent 70%),#120D0A;color:#F7EBDD;font:500 15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(420px,100%);text-align:center}h1{margin:0 0 4px;font-size:13px;letter-spacing:.28em;text-transform:uppercase;color:#E6B98A}p{margin:0 0 18px;color:#bfa990}
.ph{display:block;max-width:100%;max-height:68vh;margin:0 auto 20px;border-radius:12px;background:#fff;box-shadow:0 0 0 1px rgba(230,185,138,.4),0 24px 60px rgba(0,0,0,.55)}
.btns{display:grid;gap:10px}a.b{display:flex;align-items:center;justify-content:center;min-height:50px;border-radius:999px;border:1px solid rgba(230,185,138,.4);color:#F7EBDD;text-decoration:none;font-weight:800}
a.b.main{background:linear-gradient(135deg,#D4915D,#8A5A3B);border-color:transparent}small{display:block;margin-top:18px;color:#8f7b66}</style></head><body><main>
<h1>${name}</h1><p>Foto kamu siap dibawa pulang ☕</p>
<img class="ph" alt="Foto kamu" src="/f/${s.id}/${first}">
<div class="btns">${has.includes('png') ? `<a class="b main" href="/f/${s.id}/png?dl=1" download>Unduh PNG (kualitas penuh)</a>` : ''}${has.includes('jpg') ? `<a class="b${has.includes('png') ? '' : ' main'}" href="/f/${s.id}/jpg?dl=1" download>Unduh JPG (lebih ringan)</a>` : ''}</div>
<small>Tautan aktif sekitar ${left >= 60 ? Math.round(left / 60) + ' jam' : left + ' menit'} lagi, lalu foto dihapus otomatis dari server.</small></main></body></html>`;
}
route('GET', /^\/s\/([\w-]+)$/, async (req, res, m) => {
  const s = db.shares[m[1]];
  if (!s || s.expiresAt < now()) return send(res, 410, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tautan berakhir</title><body style="font:16px system-ui;background:#120D0A;color:#F7EBDD;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px"><div><h2>Tautan sudah berakhir</h2><p style="color:#bfa990">Foto dihapus otomatis demi privasi. Minta kasir untuk membuat QR baru.</p></div>`, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  send(res, 200, sharePage(s), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
});
route('GET', /^\/f\/([\w-]+)\/(png|jpg)$/, async (req, res, m, url) => {
  const s = db.shares[m[1]];
  if (!s || s.expiresAt < now() || !s.files[m[2]]) return send(res, 404, 'Tidak ditemukan', { 'Content-Type': 'text/plain; charset=utf-8' });
  const file = path.join(SHARE_DIR, m[1] + '.' + m[2]);
  let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, 'Tidak ditemukan'); }
  const h = { 'Content-Type': m[2] === 'png' ? 'image/png' : 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'private, no-store' };
  if (url.searchParams.get('dl')) { h['Content-Disposition'] = `attachment; filename="bruni-photobooth.${m[2]}"`; s.downloads++; save(); }
  res.writeHead(200, { ...SEC_HEADERS, ...h }); fs.createReadStream(file).pipe(res);
});

/* ---------- Admin ---------- */
route('POST', /^\/api\/admin\/login$/, async (req, res) => {
  limit('login:' + ipOf(req), 6, 10 * 60e3);
  const b = await readJSON(req);
  if (!eq(String(b.pin || ''), cfg.adminPin)) throw httpErr(401, 'PIN salah');
  json(res, 200, { token: sign({ r: 'admin' }, 12 * 3600e3) });
});
route('GET', /^\/api\/admin\/summary$/, async (req, res) => {
  adminAuth(req);
  const paid = Object.values(db.orders).filter(o => o.status === 'paid'), t0 = dayStart(now());
  const sum = from => paid.filter(o => o.paidAt >= from).reduce((a, o) => a + o.price, 0);
  const cnt = from => paid.filter(o => o.paidAt >= from).length;
  const toks = Object.values(db.tokens);
  const days = []; for (let i = 6; i >= 0; i--) { const a = t0 - i * 864e5, b = a + 864e5; days.push({ day: a, revenue: paid.filter(o => o.paidAt >= a && o.paidAt < b).reduce((s, o) => s + o.price, 0), orders: paid.filter(o => o.paidAt >= a && o.paidAt < b).length }); }
  json(res, 200, {
    today: { revenue: sum(t0), orders: cnt(t0) }, week: { revenue: sum(t0 - 6 * 864e5), orders: cnt(t0 - 6 * 864e5) },
    month: { revenue: sum(t0 - 29 * 864e5), orders: cnt(t0 - 29 * 864e5) },
    pending: Object.values(db.orders).filter(o => o.status === 'pending').length,
    sessionsSold: toks.reduce((a, t) => a + t.sessions, 0), sessionsUsed: toks.reduce((a, t) => a + t.used, 0),
    activeShares: Object.values(db.shares).filter(s => s.expiresAt > now()).length, days,
    info: { mode: cfg.qris.mode, qris: qrisInfo, paywall: cfg.paywall, baseUrl: baseUrl(req), baseUrlSet: !!cfg.baseUrl, webhook: baseUrl(req) + '/api/webhook/payment', midtransWebhook: baseUrl(req) + '/api/webhook/midtrans', brand: cfg.brand.name, packages: cfg.packages, ui: cfg.ui, shareTtlHours: cfg.share.ttlHours }
  });
});
route('GET', /^\/api\/admin\/orders$/, async (req, res, m, url) => {
  adminAuth(req);
  const st = url.searchParams.get('status');
  const list = Object.values(db.orders).filter(o => !st || o.status === st).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
  json(res, 200, { orders: list.map(o => ({ id: o.id, status: o.status, pkgName: o.pkgName, sessions: o.sessions, price: o.price, amount: o.amount, unique: o.unique, createdAt: o.createdAt, expiresAt: o.expiresAt, paidAt: o.paidAt, paidBy: o.paidBy, token: o.token, demo: o.demo })) });
});
route('POST', /^\/api\/admin\/orders\/([\w-]+)\/confirm$/, async (req, res, m) => {
  adminAuth(req);
  const o = db.orders[m[1]]; if (!o) throw httpErr(404, 'Pesanan tidak ditemukan');
  markPaid(o, 'kasir'); json(res, 200, { ok: true, token: o.token });
});
route('POST', /^\/api\/admin\/orders\/([\w-]+)\/cancel$/, async (req, res, m) => {
  adminAuth(req);
  const o = db.orders[m[1]]; if (!o) throw httpErr(404, 'Pesanan tidak ditemukan');
  if (o.status === 'paid') throw httpErr(409, 'Pesanan sudah lunas');
  o.status = 'cancelled'; save(); json(res, 200, { ok: true });
});
route('GET', /^\/api\/admin\/tokens$/, async (req, res) => {
  adminAuth(req);
  const list = Object.values(db.tokens).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
  json(res, 200, { tokens: list.map(t => ({ ...t, state: tokenState(t) })) });
});
route('POST', /^\/api\/admin\/vouchers$/, async (req, res) => {
  adminAuth(req);
  const b = await readJSON(req), sessions = Math.floor(+b.sessions), count = Math.floor(+b.count || 1), days = b.validDays == null || b.validDays === '' ? 0 : Math.floor(+b.validDays);
  if (!(sessions >= 1 && sessions <= 100)) throw httpErr(400, 'Jumlah sesi 1–100');
  if (!(count >= 1 && count <= 100)) throw httpErr(400, 'Jumlah voucher 1–100');
  const out = Array.from({ length: count }, () => issueToken({ sessions, source: 'voucher', note: String(b.note || '').slice(0, 60), validDays: days > 0 ? days : 0 }));
  json(res, 201, { tokens: out });
});
route('POST', /^\/api\/admin\/tokens\/([\w-]+)\/(revoke|restore|add)$/, async (req, res, m) => {
  adminAuth(req);
  const t = db.tokens[m[1]]; if (!t) throw httpErr(404, 'Kode tidak ditemukan');
  if (m[2] === 'revoke') t.revoked = true; else if (m[2] === 'restore') t.revoked = false;
  else { const n = Math.floor(+(await readJSON(req)).sessions); if (!(n >= 1 && n <= 100)) throw httpErr(400, 'Tambah 1–100 sesi'); t.sessions += n; }
  save(); json(res, 200, { ok: true });
});
route('GET', /^\/api\/admin\/export\.csv$/, async (req, res) => {
  adminAuth(req);
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"', iso = t => t ? new Date(t).toISOString() : '';
  const rows = [['id', 'status', 'paket', 'sesi', 'harga', 'nominal_bayar', 'kode_unik', 'dibuat', 'dibayar', 'via', 'token']];
  Object.values(db.orders).sort((a, b) => a.createdAt - b.createdAt).forEach(r => rows.push([r.id, r.status, r.pkgName, r.sessions, r.price, r.amount, r.unique, iso(r.createdAt), iso(r.paidAt), r.paidBy || '', r.token || '']));
  send(res, 200, '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bruni-penjualan.csv"', 'Cache-Control': 'no-store' });
});

/* ---------- Pengaturan booth (disimpan di data/settings.json, menimpa config.json) ---------- */
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SECS_OPTIONS = [3, 5, 10];
const intIn = (v, min, max, label) => { const n = Math.floor(+v); if (!(n >= min && n <= max)) throw httpErr(400, label + ' harus ' + min.toLocaleString('id-ID') + '–' + max.toLocaleString('id-ID')); return n; };
const txt = (v, max, label, req) => { const t = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim(); if (req && !t) throw httpErr(400, label + ' wajib diisi'); if (t.length > max) throw httpErr(400, label + ' maksimal ' + max + ' karakter'); return t; };
function cleanSettings(b) {
  const brand = { name: txt(b.brand && b.brand.name, 40, 'Nama brand', true), tagline: txt(b.brand && b.brand.tagline, 80, 'Tagline') };
  if (!Array.isArray(b.packages) || b.packages.length < 1 || b.packages.length > 6) throw httpErr(400, 'Jumlah paket 1–6');
  const seen = new Set();
  const packages = b.packages.map((p, i) => {
    let id = String((p && p.id) || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || ('paket' + (i + 1));
    while (seen.has(id)) id += 'x';
    seen.add(id);
    const out = { id, name: txt(p.name, 30, 'Nama paket', true), sessions: intIn(p.sessions, 1, 100, 'Jumlah sesi'), price: intIn(p.price, 1000, 10000000, 'Harga') };
    const note = txt(p.note, 40, 'Catatan paket'); if (note) out.note = note;
    if (p.popular) out.popular = true;
    return out;
  });
  const defaultSecs = Math.floor(+b.defaultSecs);
  if (!SECS_OPTIONS.includes(defaultSecs)) throw httpErr(400, 'Hitung mundur harus ' + SECS_OPTIONS.join(', ') + ' detik');
  const idleSeconds = Math.floor(+b.idleSeconds || 0);
  if (idleSeconds !== 0 && !(idleSeconds >= 20 && idleSeconds <= 900)) throw httpErr(400, 'Reset otomatis: 0 (mati) atau 20–900 detik');
  return { brand, packages, defaultSecs, idleSeconds };
}
function applySettings(s) {
  cfg.brand = { ...cfg.brand, ...s.brand };
  cfg.packages = s.packages;
  cfg.ui = { defaultSecs: s.defaultSecs, idleSeconds: s.idleSeconds };
}
const currentSettings = () => ({ brand: cfg.brand, packages: cfg.packages, defaultSecs: cfg.ui.defaultSecs, idleSeconds: cfg.ui.idleSeconds });
try { applySettings(cleanSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')))); } catch (e) { if (e.code !== 'ENOENT') console.error('⚠ settings.json diabaikan:', e.message); }
route('GET', /^\/api\/admin\/settings$/, async (req, res) => { adminAuth(req); json(res, 200, { ...currentSettings(), secsOptions: SECS_OPTIONS }); });
route('POST', /^\/api\/admin\/settings$/, async (req, res) => {
  adminAuth(req);
  const s = cleanSettings(await readJSON(req));
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, SETTINGS_FILE);
  applySettings(s); json(res, 200, { ok: true, ...currentSettings() });
});

/* ---------------- Static ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/admin') pathname = '/admin.html';
  let file; try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname))); } catch (e) { return send(res, 400, 'Bad request'); }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Tidak ditemukan', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (p === '/healthz') return json(res, 200, { ok: true });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p); if (!m) continue;
      return await r.fn(req, res, m, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    throw httpErr(404, 'Tidak ditemukan');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Kesalahan server' : e.message });
  }
});
server.requestTimeout = 60e3;

/* ---------------- Pembersihan berkala ---------------- */
function sweep() {
  const t = now(); let dirty = false;
  for (const o of Object.values(db.orders)) if (o.status === 'pending' && o.expiresAt < t - 5 * 60e3) { o.status = 'expired'; dirty = true; } // jeda 5 menit untuk pembayaran yang telat masuk
  for (const [id, s] of Object.entries(db.shares)) if (s.expiresAt < t) {
    for (const ext of Object.keys(s.files)) fs.rm(path.join(SHARE_DIR, id + '.' + ext), () => {});
    delete db.shares[id]; dirty = true;
  }
  for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1] > 3600e3) buckets.delete(k);
  if (dirty) save();
}
setInterval(sweep, 60e3).unref(); sweep();

module.exports = { crc16, dynamicQris, validateStaticQris, parseTLV, demoStaticQris, server, cfg, start: port => new Promise(r => server.listen(port, r)) };
if (require.main === module) {
  server.listen(cfg.port, () => {
    const ip = lanIP();
    console.log(`\n  ☕ ${cfg.brand.name} — photobooth berjalan`);
    console.log(`  Studio : http://localhost:${cfg.port}/`);
    console.log(`  Admin  : http://localhost:${cfg.port}/admin   (PIN: ${cfg.adminPin})`);
    if (ip) console.log(`  LAN    : http://${ip}:${cfg.port}/`);
    console.log(`  Mode   : ${cfg.paywall ? 'berbayar' : 'gratis'} · QRIS ${cfg.qris.mode}${qrisInfo.demo && cfg.paywall && cfg.qris.mode !== 'midtrans' ? ' · ⚠ DEMO (isi qris.staticString)' : qrisInfo.configured ? ' · ' + qrisInfo.merchant : ''}`);
    if (!cfg.baseUrl) console.log('  ⚠ baseUrl belum diatur: tautan QR unduh memakai ' + (ip ? `http://${ip}:${cfg.port}` : 'host saat ini') + ' (isi baseUrl dengan alamat publik/HTTPS untuk produksi)');
    if (generated) console.log('  PIN admin & rahasia dibuat otomatis → data/secrets.json');
    console.log('');
  });
}
