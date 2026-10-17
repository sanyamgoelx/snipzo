// Runs content snapping on a real snap-report screen image (PNG decoded with sharp-free raw: uses a .rgba dump)
const fs = require('fs'), C = require('../ui/content.js').Content;
const [raw, w, h, rx, ry, rw, rh] = process.argv.slice(2);
const buf = fs.readFileSync(raw), data = new Uint8Array(buf.length);
for (let i = 0; i < buf.length; i += 4) { data[i] = buf[i + 2]; data[i + 1] = buf[i + 1]; data[i + 2] = buf[i]; data[i + 3] = 255; } // RGBA -> BGRA
const img = { w: +w, h: +h, data };
const region = { x: +rx, y: +ry, w: +rw, h: +rh };
const t = C.tighten(img, 1, region);
const rects = C.find(img, 1, t);
console.log('tight', JSON.stringify(t));
for (const r of rects) console.log(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h), 'frame', r.frame, 'sides', r.sides);
