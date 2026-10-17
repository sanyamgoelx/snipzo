'use strict';
// Draws Snipzo's icons (no image tools needed): a dark rounded square, four sky-blue corner brackets
// (the picked area) and a red record dot. Writes assets/*.png, build/icon.ico and build/icon.png (Mac).
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// shape tests in unit coordinates (0..1)
function inRound(x, y, r) { const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; }
function draw(size, { recording = false } = {}) {
  const SS = 4, px = Buffer.alloc(size * size * 4);
  const bg = hex('#161921'), edge = hex('#2E3546'), sky = hex(recording ? '#FF4D5E' : '#7DD3FC'), red = hex('#FF4D5E');
  const small = size <= 24;
  const m = 0.20, len = small ? 0.22 : 0.20, th = small ? 0.11 : 0.085; // bracket inset, arm length, thickness
  const dotR = recording ? 0.17 : small ? 0.15 : 0.13;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      let c = null;
      if (inRound(u, v, 0.22)) {
        c = inRound((u - 0.03) / 0.94, (v - 0.03) / 0.94, 0.20) ? bg : edge;
        const nearX = u < m + th && u >= m || u > 1 - m - th && u <= 1 - m, nearY = v < m + th && v >= m || v > 1 - m - th && v <= 1 - m;
        const armX = (u >= m && u <= m + len) || (u <= 1 - m && u >= 1 - m - len);
        const armY = (v >= m && v <= m + len) || (v <= 1 - m && v >= 1 - m - len);
        if ((nearX && armY) || (nearY && armX)) c = sky;
        if ((u - 0.5) ** 2 + (v - 0.5) ** 2 <= dotR * dotR) c = red;
      }
      if (c) { acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255; }
    }
    const n = SS * SS, a = acc[3] / n, i = (y * size + x) * 4;
    px[i] = a ? Math.round(acc[0] / (acc[3] / 255)) : 0; px[i + 1] = a ? Math.round(acc[1] / (acc[3] / 255)) : 0; px[i + 2] = a ? Math.round(acc[2] / (acc[3] / 255)) : 0; px[i + 3] = Math.round(a);
  }
  return png(size, px);
}
function ico(images) { // [{ size, data }]
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length); let off = 6 + dir.length;
  images.forEach((im, k) => { const o = k * 16; dir[o] = im.size >= 256 ? 0 : im.size; dir[o + 1] = im.size >= 256 ? 0 : im.size; dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(im.data.length, o + 8); dir.writeUInt32LE(off, o + 12); off += im.data.length; });
  return Buffer.concat([head, dir, ...images.map((i) => i.data)]);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true }); fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'tray.png'), draw(16));
fs.writeFileSync(path.join(root, 'assets', 'tray@2x.png'), draw(32));
fs.writeFileSync(path.join(root, 'assets', 'tray-rec.png'), draw(16, { recording: true }));
fs.writeFileSync(path.join(root, 'assets', 'tray-rec@2x.png'), draw(32, { recording: true }));
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), draw(256));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), draw(1024)); // macOS app icon (electron-builder makes the .icns from it)
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: draw(s) }))));
console.log('icons written');
