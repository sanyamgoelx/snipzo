// Synthetic After Effects viewer: pasteboard, 2px panel gutter, comp at a fractional zoom (blended edge),
// a shape and safe-zone guides inside the comp. Checks content.js snaps to the comp frame to the pixel.
const C = require('../ui/content.js').Content;
function make(W, H, scale, comp, opts = {}) {
  const w = Math.round(W * scale), h = Math.round(H * scale), d = new Uint8Array(w * h * 4);
  const set = (x, y, v) => { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; };
  const PB = opts.pb ?? 35, GUT = 22;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, PB);
  // panel gutter 2px all round (physical)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) set(x, y, GUT);
  // comp at fractional physical coords cx,cy,cw,ch: coverage blending on edges
  const { x: cx, y: cy, w: cw, h: ch } = comp;
  const content = (x, y) => opts.bg ?? (60 + Math.round(120 * (x - cx) / cw)); // gradient
  for (let y = Math.floor(cy); y < Math.ceil(cy + ch); y++) for (let x = Math.floor(cx); x < Math.ceil(cx + cw); x++) {
    const covX = Math.min(x + 1, cx + cw) - Math.max(x, cx), covY = Math.min(y + 1, cy + ch) - Math.max(y, cy);
    const cov = Math.max(0, covX) * Math.max(0, covY);
    let v = content(x, y);
    // a dark shape inside the comp
    if (x > cx + cw * 0.3 && x < cx + cw * 0.6 && y > cy + ch * 0.3 && y < cy + ch * 0.7) v = 200;
    // safe-zone guide lines (1px) at 10% inset
    const gx0 = Math.round(cx + cw * 0.1), gx1 = Math.round(cx + cw * 0.9), gy0 = Math.round(cy + ch * 0.1), gy1 = Math.round(cy + ch * 0.9);
    if (((x === gx0 || x === gx1) && y >= gy0 && y <= gy1) || ((y === gy0 || y === gy1) && x >= gx0 && x <= gx1)) v = 240;
    // comp content that matches the pasteboard for a few px along the top edge
    if (opts.gap && y < cy + 2 && x > cx + 100 && x < cx + 106) v = PB;
    set(x, y, Math.round(PB * (1 - cov) + v * cov));
  }
  return { img: { w, h, data: d }, sx: scale };
}
let fails = 0;
function check(name, scale, comp, opts) {
  const W = 1200, H = 700;
  const { img, sx } = make(W, H, scale, comp, opts);
  const region = { x: 0, y: 0, w: W, h: H };
  const t = C.tighten(img, sx, region);
  const rects = C.find(img, sx, t);
  const best = rects.filter((r) => r.frame >= 0.3).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  // expected: pixels more than half covered
  const ex = { x: Math.round(comp.x), y: Math.round(comp.y), r: Math.round(comp.x + comp.w), b: Math.round(comp.y + comp.h) };
  const got = best && { x: Math.round(best.x * sx), y: Math.round(best.y * sx), r: Math.round((best.x + best.w) * sx), b: Math.round((best.y + best.h) * sx) };
  const ok = got && Math.abs(got.x - ex.x) <= 0 && Math.abs(got.y - ex.y) <= 0 && Math.abs(got.r - ex.r) <= 0 && Math.abs(got.b - ex.b) <= 0;
  const tok = t.trimmed && t.trimmed.t === 2 && t.trimmed.l === 2;
  if (!ok || !tok) fails++;
  console.log(`${ok && tok ? 'PASS' : 'FAIL'} ${name}: expected ${JSON.stringify(ex)} got ${JSON.stringify(got)} frame=${best && best.frame} tighten=${JSON.stringify(t.trimmed)} (${rects.length} rects: ${rects.map((r) => `${Math.round(r.w * sx)}x${Math.round(r.h * sx)}@${r.frame}`).join(' ')})`);
}
check('100% scale, integer comp', 1, { x: 200, y: 100, w: 800, h: 450 });
check('100% scale, fractional comp edges', 1, { x: 200.3, y: 100.7, w: 800.5, h: 450.4 });
check('125% scale, fractional', 1.25, { x: 250.6, y: 125.2, w: 1000.3, h: 562.9 });
check('150% scale, gap in top edge', 1.5, { x: 300.4, y: 150.6, w: 1200, h: 675 }, { gap: true });
check('black comp on dark pasteboard', 1, { x: 200, y: 100, w: 800, h: 450 }, { bg: 0 });
check('9:16 comp', 1, { x: 400.4, y: 40.6, w: 345.2, h: 613.7 });
process.exit(fails ? 1 : 0);
