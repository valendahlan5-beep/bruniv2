/* Bruni QR — encoder QR Code mandiri (tanpa dependensi, tanpa internet).
   Mode byte (UTF-8), level koreksi L/M/Q/H, versi 1–40.
   Browser: BruniQR.make(text, 'M') / BruniQR.toCanvas(text, opts). Node: require('./qr.js'). */
(function (root) {
  'use strict';
  const ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  const NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  const ECL = { L: 0, M: 1, Q: 2, H: 3 };
  const FMT = [1, 0, 3, 2]; // bit format untuk L, M, Q, H

  function rawModules(v) {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCapacity(v, e) { return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[e][v] * NUM_BLOCKS[e][v]; }
  function utf8(s) { return Array.from(new TextEncoder().encode(s)); }

  // Reed–Solomon di GF(256), polinomial 0x11D
  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsDivisor(deg) {
    const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
    for (let i = 0; i < deg; i++) {
      for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
      root = gfMul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = new Array(div.length).fill(0);
    for (const b of data) {
      const f = b ^ r.shift(); r.push(0);
      div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
    }
    return r;
  }

  function make(text, level) {
    const e = ECL[level || 'M'];
    if (e === undefined) throw new Error('Level QR tidak dikenal');
    const bytes = utf8(String(text));
    let ver = 0;
    for (let v = 1; v <= 40; v++) {
      const cc = v < 10 ? 8 : 16;
      if (4 + cc + bytes.length * 8 <= dataCapacity(v, e) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('Data terlalu panjang untuk QR');
    const cc = ver < 10 ? 8 : 16, bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, cc); bytes.forEach(b => put(b, 8));
    const cap = dataCapacity(ver, e) * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }

    // bagi blok, hitung ECC, interleave
    const nb = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver], raw = Math.floor(rawModules(ver) / 8);
    const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const len = shortLen - eccLen + (i < nShort ? 0 : 1);
      const d = data.slice(k, k + len); k += len;
      const ecc = rsRemainder(d, div);
      if (i < nShort) d.push(0);
      blocks.push(d.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });

    const size = ver * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
      }
    });
    let pos = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      pos = [6]; for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    }
    pos.forEach((cx, i) => pos.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = mask => {
      const d = (FMT[e] << 3) | mask; let r = d;
      for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const f = ((d << 10) | r) ^ 0x5412, g = i => ((f >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) setF(8, i, g(i));
      setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, g(i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, g(i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, g(i));
      setF(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const v = (ver << 12) | r;
      for (let i = 0; i < 18; i++) {
        const c = ((v >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3);
        setF(a, b, c); setF(b, a, c);
      }
    }
    // tempatkan data zig-zag
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && k < out.length * 8) { m[y][x] = ((out[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0; k++; }
      }
    }
    const MASK = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
    ];
    const applyMask = mk => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASK[mk](x, y)) m[y][x] = !m[y][x]; };
    const penalty = () => {
      let p = 0;
      for (let t = 0; t < 2; t++) {
        const at = (a, b) => t ? m[b][a] : m[a][b];
        for (let a = 0; a < size; a++) {
          let run = 1;
          for (let b = 1; b < size; b++) {
            if (at(a, b) === at(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
          }
          const s = []; for (let b = 0; b < size; b++) s.push(at(a, b) ? 1 : 0);
          const str = s.join('');
          for (const pat of ['10111010000', '00001011101']) { let i = -1; while ((i = str.indexOf(pat, i + 1)) >= 0) p += 40; }
        }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
      let dark = 0; m.forEach(r => r.forEach(c => { if (c) dark++; }));
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let mk = 0; mk < 8; mk++) { applyMask(mk); drawFormat(mk); const p = penalty(); if (p < bestP) { bestP = p; best = mk; } applyMask(mk); }
    applyMask(best); drawFormat(best);
    return { size, version: ver, mask: best, get: (x, y) => m[y][x] };
  }

  // Gambar ke <canvas>. opts: { ecl, scale, quiet, dark, light }
  function toCanvas(text, o) {
    o = o || {};
    const q = make(text, o.ecl || 'M'), quiet = o.quiet == null ? 4 : o.quiet, scale = o.scale || 8;
    const px = (q.size + quiet * 2) * scale, c = document.createElement('canvas');
    c.width = c.height = px;
    const x = c.getContext('2d');
    x.fillStyle = o.light || '#ffffff'; x.fillRect(0, 0, px, px);
    x.fillStyle = o.dark || '#000000';
    for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.get(k, r)) x.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
    return c;
  }
  const api = { make, toCanvas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BruniQR = api;
})(typeof self !== 'undefined' ? self : this);
