'use strict';
// Content snapping: finds rectangles an app draws itself (After Effects' comp frame, a video inside a player,
// the viewer without its tab row and toolbar) in a still image of the screen taken when the picker opened.
// Windows and panels come from the window list; these come from long straight edges in the picture.
//
// v0.2 accuracy work (Crofty: "the snap is not always accurate to the viewport"):
//  - the image is now the monitor's real pixels (not shrunk to DIPs), so edges land on the exact pixel
//  - an edge may have small gaps (comp content that happens to match the pasteboard colour for a few pixels)
//  - each edge is refined to the pixel: a half-blended line at a fractional viewer zoom is only kept when it
//    is more picture than pasteboard, so no grey sliver of pasteboard ends up in the recording
//  - each rectangle gets a "frame" score: a plain, even colour all round it that is also the colour at the
//    panel's own edges (the pasteboard). The comp frame scores high; a shape or a safe-zone guide inside the
//    comp does not, so the picker picks the comp frame by default instead of something drawn inside it
//  - tighten(): a panel's thin even-coloured border (AE's panel gutters) is trimmed off the panel rectangle
(function (root) {
  const DIFF = 7;        // brightness step that counts as an edge (0-255)
  const MIN_W = 160, MIN_H = 120, NEAR = 3;
  const SAME = 4;        // two greys within this are "the same colour"

  const lumaOf = (img) => {
    const d = img.data, stride = img.w * 4;
    return (x, y) => { const i = y * stride + x * 4; return (d[i] + 2 * d[i + 1] + d[i + 2]) >> 2; };
  };
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // img: { w, h, data: Uint8Array BGRA }, sx: image pixels per DIP, r: region in DIPs (display-relative)
  // Returns rectangles in DIPs, best frame first then largest, not including r itself. Each has .frame (0-1).
  function find(img, sx, r) {
    const x0 = Math.max(1, Math.round(r.x * sx)), y0 = Math.max(1, Math.round(r.y * sx));
    const x1 = Math.min(img.w - 2, Math.round((r.x + r.w) * sx)), y1 = Math.min(img.h - 2, Math.round((r.y + r.h) * sx));
    const W = x1 - x0, H = y1 - y0;
    if (W < MIN_W * sx || H < MIN_H * sx) return [];
    const g = lumaOf(img);
    const minH = Math.max(80 * sx, W * 0.15), minV = Math.max(60 * sx, H * 0.15);
    const GAP = Math.max(2, Math.round(4 * sx));

    // A run of edge pixels along a line, allowed to have gaps up to GAP long, at least 85% edge overall
    const runs = (len, isEdge, min, push) => {
      let start = -1, last = -1, count = 0;
      for (let i = 0; i <= len; i++) {
        const e = i < len && isEdge(i);
        if (e) { if (start < 0) { start = i; count = 0; } last = i; count++; }
        else if (start >= 0 && (i >= len || i - last > GAP)) {
          const L = last - start + 1;
          if (L >= min && count >= L * 0.85) push(start, last);
          start = -1;
        }
      }
    };
    // horizontal segments: a row whose pixels differ from the row above along a long run
    const hs = [{ y: y0, a: x0, b: x1 }, { y: y1, a: x0, b: x1 }];
    for (let y = y0 + 1; y < y1; y++) runs(W, (i) => Math.abs(g(x0 + i, y) - g(x0 + i, y - 1)) >= DIFF, minH, (a, b) => hs.push({ y, a: x0 + a, b: x0 + b }));
    const vs = [{ x: x0, a: y0, b: y1 }, { x: x1, a: y0, b: y1 }];
    for (let x = x0 + 1; x < x1; x++) runs(H, (i) => Math.abs(g(x, y0 + i) - g(x - 1, y0 + i)) >= DIFF, minV, (a, b) => vs.push({ x, a: y0 + a, b: y0 + b }));

    const top = (list, key, n) => { // drop near-duplicates (a 2 px line gives two edges), keep the longest n
      list.sort((p, q) => (q.b - q.a) - (p.b - p.a));
      const out = [];
      for (const s of list) if (!out.some((o) => Math.abs(o[key] - s[key]) <= 2 && Math.abs(o.a - s.a) <= NEAR * sx && Math.abs(o.b - s.b) <= NEAR * sx)) { out.push(s); if (out.length >= n) break; }
      return out;
    };
    const H2 = top(hs, 'y', 40), V2 = top(vs, 'x', 40);
    const tol = NEAR * sx + 1;
    const rects = [];
    for (const l of V2) for (const rt of V2) {
      if (rt.x - l.x < MIN_W * sx) continue;
      for (const t of H2) {
        if (!(t.a <= l.x + tol && t.b >= rt.x - tol)) continue;
        for (const b of H2) {
          if (b.y - t.y < MIN_H * sx) continue;
          if (!(b.a <= l.x + tol && b.b >= rt.x - tol)) continue;
          if (!(l.a <= t.y + tol && l.b >= b.y - tol && rt.a <= t.y + tol && rt.b >= b.y - tol)) continue;
          rects.push({ x: l.x, y: t.y, w: rt.x - l.x, h: b.y - t.y });
        }
      }
    }
    // largest first, refine each to the pixel, score it, back to DIPs, without the region and near-duplicates
    const region = { x: x0, y: y0, w: W, h: H };
    const ring = regionRing(g, region);
    const out = [];
    for (const q0 of rects.sort((p, s) => s.w * s.h - p.w * p.h).slice(0, 60)) {
      const q = refine(g, img, q0);
      const frame = frameScore(g, img, q, region, ring);
      const dip = { x: q.x / sx, y: q.y / sx, w: q.w / sx, h: q.h / sx, frame };
      if (Math.abs(dip.x - r.x) <= 2 && Math.abs(dip.y - r.y) <= 2 && Math.abs(dip.w - r.w) <= 3 && Math.abs(dip.h - r.h) <= 3) continue;
      if (out.some((o) => Math.abs(o.x - dip.x) <= 2 && Math.abs(o.y - dip.y) <= 2 && Math.abs(o.w - dip.w) <= 3 && Math.abs(o.h - dip.h) <= 3)) continue;
      out.push(dip); if (out.length >= 12) break;
    }
    return out;
  }

  // Move each edge of q (image pixels, right/bottom exclusive) to the exact pixel. For every row/column with
  // clear contrast across the edge, a pixel counts as inside when it is closer to the picture 4 px in than to
  // the background 4 px out; the edge goes where most of them agree.
  function refine(g, img, q) {
    const R = 3, REF = 4;
    const side = (len, at, inward) => { // at(i, off): luma at position i along the edge, `off` px from the found edge (+ = inside)
      const step = Math.max(1, Math.floor(len / 240));
      const votes = new Array(2 * R + 1).fill(0); let n = 0;
      for (let i = 4; i < len - 4; i += step) {
        const o = at(i, -REF), p = at(i, REF);
        if (o == null || p == null || Math.abs(o - p) < DIFF * 2) continue;
        n++;
        for (let k = -R; k <= R; k++) { const v = at(i, k); if (v != null && Math.abs(v - o) > Math.abs(v - p)) votes[k + R]++; }
      }
      if (n < 8) return 0;
      // the first offset (going inward) from which most rows say "inside" and keep saying it up to the found edge
      for (let k = -R; k <= R; k++) if (votes[k + R] > n / 2) { let ok = true; for (let j = k; j <= Math.min(R, Math.max(k, 0)); j++) if (votes[j + R] <= n / 2) ok = false; if (ok) return inward * k; }
      return 0;
    };
    // (no offset had a majority: keep the edge where it was found)
    const inImg = (x, y) => x >= 0 && y >= 0 && x < img.w && y < img.h;
    const L = q.x, T = q.y, Rr = q.x + q.w, B = q.y + q.h; // right and bottom are the first outside pixels
    const dT = side(q.w, (i, off) => { const x = L + i, y = T + off; return inImg(x, y) ? g(x, y) : null; }, 1);
    const dB = side(q.w, (i, off) => { const x = L + i, y = B - 1 - off; return inImg(x, y) ? g(x, y) : null; }, 1);
    const dL = side(q.h, (i, off) => { const x = L + off, y = T + i; return inImg(x, y) ? g(x, y) : null; }, 1);
    const dR = side(q.h, (i, off) => { const x = Rr - 1 - off, y = T + i; return inImg(x, y) ? g(x, y) : null; }, 1);
    const nx = L + dL, ny = T + dT, nr = Rr - dR, nb = B - dB;
    return nr - nx > 8 && nb - ny > 8 ? { x: nx, y: ny, w: nr - nx, h: nb - ny } : q;
  }

  // Colour along the inside edge of the panel itself (where AE's pasteboard reaches)
  function regionRing(g, reg) {
    const s = [], k = 3, step = Math.max(1, Math.floor((reg.w + reg.h) / 400));
    for (let x = reg.x + k; x < reg.x + reg.w - k; x += step) { s.push(g(x, reg.y + k), g(x, reg.y + reg.h - 1 - k)); }
    for (let y = reg.y + k; y < reg.y + reg.h - k; y += step) { s.push(g(reg.x + k, y), g(reg.x + reg.w - 1 - k, y)); }
    return s;
  }
  // 0-1: how much q looks like a frame sitting on a plain background (the comp on AE's pasteboard).
  // The ring 3-5 px outside q must be one even colour (sides touching the panel edge are skipped), and that
  // colour must also be what the panel shows along its own edges.
  function frameScore(g, img, q, reg, ring) { // eslint-disable-line no-unused-vars
    // Only sides with room outside them count, and at least two must: a comp fitted to the viewer's height has
    // just its left and right sides on the pasteboard, while "comp + the pasteboard beside it" (a rectangle that
    // borrows the panel's own edges) has only one, and is not a frame (real AE screen, 17 Oct)
    const s = [], step = Math.max(1, Math.floor((q.w + q.h) / 300)), room = 6;
    const sides = [q.y - room > reg.y, q.y + q.h - 1 + room < reg.y + reg.h - 1, q.x - room > reg.x, q.x + q.w - 1 + room < reg.x + reg.w - 1];
    if (sides.filter(Boolean).length < 2) return 0;
    for (const off of [3, 5]) {
      if (sides[0]) for (let x = q.x; x < q.x + q.w; x += step) s.push(g(x, q.y - off));
      if (sides[1]) for (let x = q.x; x < q.x + q.w; x += step) s.push(g(x, q.y + q.h - 1 + off));
      if (sides[2]) for (let y = q.y; y < q.y + q.h; y += step) s.push(g(q.x - off, y));
      if (sides[3]) for (let y = q.y; y < q.y + q.h; y += step) s.push(g(q.x + q.w - 1 + off, y));
    }
    if (s.length < 40) return 0;
    const m = median(s);
    const even = s.filter((v) => Math.abs(v - m) <= SAME).length / s.length;
    if (even < 0.85) return 0;
    const onEdge = ring.length ? ring.filter((v) => Math.abs(v - m) <= SAME).length / ring.length : 0;
    // and the picture inside must differ from that background somewhere along the edge (not an empty box)
    return Math.round(Math.min(1, onEdge / 0.6) * even * 100) / 100;
  }

  // A panel rectangle without its thin even-coloured border: on each side, if the first lines are one plain
  // colour and then the picture changes within a few pixels, the edge moves in to where it changes. A side whose
  // plain colour goes on further (AE's pasteboard) is left alone. r and the result are DIPs.
  function tighten(img, sx, r) {
    if (!img) return r;
    const g = lumaOf(img), K = Math.max(3, Math.round(3 * sx)); // panel borders are 1-2 px; a comp starting 4 px in is not a border
    let L = Math.round(r.x * sx), T = Math.round(r.y * sx), Rr = Math.round((r.x + r.w) * sx), B = Math.round((r.y + r.h) * sx);
    L = clampI(L, 0, img.w - 1); T = clampI(T, 0, img.h - 1); Rr = clampI(Rr, 1, img.w); B = clampI(B, 1, img.h);
    if (Rr - L < 40 || B - T < 40) return r;
    const line = (len, at) => { const s = []; const step = Math.max(1, Math.floor(len / 200)); for (let i = 6; i < len - 6; i += step) s.push(at(i)); const m = median(s); return { m, even: s.filter((v) => Math.abs(v - m) <= SAME).length / Math.max(1, s.length) }; };
    const side = (len, at) => {
      const first = line(len, (i) => at(i, 0));
      if (first.even < 0.95) return 0;
      for (let k = 1; k <= K; k++) {
        const l = line(len, (i) => at(i, k));
        if (!(l.even >= 0.95 && Math.abs(l.m - first.m) <= SAME)) return k <= K - 1 ? k : 0; // the picture starts at line k
      }
      return 0; // plain all the way: that is content (pasteboard), not a border
    };
    const dT = side(Rr - L, (i, k) => g(L + i, T + k));
    const dB = side(Rr - L, (i, k) => g(L + i, B - 1 - k));
    const dL = side(B - T, (i, k) => g(L + k, T + i));
    const dR = side(B - T, (i, k) => g(Rr - 1 - k, T + i));
    if (!(dT || dB || dL || dR)) return r;
    const nx = L + dL, ny = T + dT, nr = Rr - dR, nb = B - dB;
    return { ...r, x: nx / sx, y: ny / sx, w: (nr - nx) / sx, h: (nb - ny) / sx, trimmed: { t: dT, b: dB, l: dL, r: dR } };
  }

  root.Content = { find, tighten };
})(typeof self !== 'undefined' ? self : this);
