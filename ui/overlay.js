'use strict';
// Pick overlay (one per monitor). Hover shows the window or panel under the mouse; scrolling steps to a
// bigger or smaller one; a click picks it; a drag draws a free box whose edges snap to window and panel
// edges (hold Alt to stop snapping). The Record button shows the exact pixel size that will be recorded,
// worked out by the same code the main process uses (geometry.js).
const $ = (id) => document.getElementById(id);
const box = $('box'), tag = $('tag'), bar = $('bar'), hint = $('hint'), help = $('help'), go = $('go'), goKey = $('go-key'), shade = $('shade'), warn = $('warn');
const SNAP = 8, CLICK = 4, MIN_DEFAULT = { w: 160, h: 120 }, FRAME = 0.5;

let D = null;            // what main sent: displayId, w, h, scale, out, rects, settings...
let mode = 'off';        // off | hover | press | drag | sel | move | resize
let chain = [], level = 0, levelBias = 0, chainKey = '';
let sel = null, press = null, grab = null, edges = { xs: [], ys: [] };
let lastPoint = null;
let history = [];        // earlier selections, for Ctrl+Z
let barBottom = false;   // where the toolbar sits; changes only when a selection settles, never while pointing
let shot = null, shotScale = 1, contentCache = new Map(), tightCache = new Map(); // still image of this screen for content snapping

// Rectangles drawn inside a panel or window (comp frame, video, viewer without its tab row), cached per region
function contentIn(region, key) {
  if (!shot || !window.Content) return [];
  if (!contentCache.has(key)) {
    let rects = [];
    try { rects = Content.find(shot, shotScale, region); } catch (e) { console.warn('content', e); }
    contentCache.set(key, rects);
    for (const q of rects) { edges.xs.push(q.x, q.x + q.w); edges.ys.push(q.y, q.y + q.h); } // drag edges snap to them too
  }
  return contentCache.get(key);
}
// A panel without its thin plain border (After Effects' panel gutters), once the screen image is here
function tightened(q) {
  if (!shot || !window.Content) return q;
  if (!tightCache.has(q.id)) {
    let t = q;
    try { t = { ...q, ...Content.tighten(shot, shotScale, q) }; } catch (e) { console.warn('tighten', e); }
    tightCache.set(q.id, t);
    if (t !== q) { edges.xs.push(t.x, t.x + t.w); edges.ys.push(t.y, t.y + t.h); }
  }
  return tightCache.get(q.id);
}

const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
const phys = (r) => (D && D.out && r ? Geometry.toRecordRect(r, D.scale, D.out) : null);
const sizeText = (p) => (p ? `${p.w} × ${p.h}` : '');
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

// ---------- what is under the mouse ----------
function chainAt(p) {
  const out = [], seen = new Set();
  const add = (r) => { const k = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`; if (!seen.has(k)) { seen.add(k); out.push(r); } };
  const top = D.rects.find((r) => inside(p, r)); // topmost first
  if (top) {
    const parts = top.parts.filter((q) => inside(p, q)).map(tightened).sort((a, b) => a.w * a.h - b.w * b.h);
    const inner = parts[0] || top; // the smallest panel (or the window) under the mouse
    const list = contentIn(inner, inner.id).filter((q) => inside(p, q)).map((q, i) => ({ ...q, kind: q.frame >= FRAME ? 'frame' : 'area', title: top.title, key: `${inner.id}:a${i}` }));
    for (const q of parts) list.push({ x: q.x, y: q.y, w: q.w, h: q.h, kind: 'panel', title: top.title, key: q.id });
    list.sort((a, b) => a.w * a.h - b.w * b.h).forEach(add);
    add({ x: top.x, y: top.y, w: top.w, h: top.h, kind: 'window', title: top.title, key: top.id });
  }
  add({ x: 0, y: 0, w: D.w, h: D.h, kind: 'screen', title: 'Whole screen', key: 'screen' });
  return out;
}
// The default is the frame an app draws on a plain background (the comp on AE's pasteboard, a video on its
// letterbox) when the mouse is over one, the best-scoring such; otherwise the smallest area that is big enough.
function defaultLevel(c) {
  let f = -1; // the best frame score; on a tie the smaller one (sorted small to large, so the first)
  c.forEach((r, i) => { if (r.kind === 'frame' && r.w >= MIN_DEFAULT.w && r.h >= MIN_DEFAULT.h && (f < 0 || r.frame > c[f].frame)) f = i; });
  if (f >= 0) return f;
  const i = c.findIndex((r) => r.w >= MIN_DEFAULT.w && r.h >= MIN_DEFAULT.h);
  return i < 0 ? c.length - 1 : i;
}
function updateHover(p) {
  const c = chainAt(p);
  const key = c.map((r) => r.key).join('|');
  if (key !== chainKey) {
    const win = (x) => (x.find((r) => r.kind === 'window') || {}).key;
    if (win(c) !== win(chain)) levelBias = 0; // a new window starts at its default size; panels of the same window keep the step
    chain = c; chainKey = key;
  }
  level = Math.max(0, Math.min(chain.length - 1, defaultLevel(chain) + levelBias));
  render();
}

// ---------- snapping ----------
function buildEdges() {
  const xs = [0, D.w], ys = [0, D.h];
  for (const r of D.rects) { xs.push(r.x, r.x + r.w); ys.push(r.y, r.y + r.h); for (const q of r.parts) { xs.push(q.x, q.x + q.w); ys.push(q.y, q.y + q.h); } }
  edges = { xs: [...new Set(xs)], ys: [...new Set(ys)] };
}
function snap(v, list, on) {
  if (!on) return v;
  let best = v, d = SNAP + 1;
  for (const e of list) { const dd = Math.abs(e - v); if (dd < d) { d = dd; best = e; } }
  return d <= SNAP ? best : v;
}
const clampX = (v) => Math.max(0, Math.min(D.w, v)), clampY = (v) => Math.max(0, Math.min(D.h, v));

// ---------- drawing ----------
function place(el, r) { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; }
function render() {
  if (!D) return;
  const showSel = sel && (mode === 'sel' || mode === 'drag' || mode === 'move' || mode === 'resize');
  const cand = mode === 'hover' && chain[level];
  if (showSel) {
    box.style.display = 'block'; box.className = mode === 'drag' ? 'hover' : 'sel'; place(box, sel); shade.className = 'cut';
    const p = phys(sel);
    tagAt(sel, `<span class="px">${p ? sizeText(p) : 'too small'}</span>`);
  } else if (cand) {
    box.style.display = 'block'; box.className = 'hover'; place(box, cand); shade.className = 'cut';
    const p = phys(cand);
    const kind = cand.kind;
    tagAt(cand, `<b>${esc(cand.title || 'Untitled window')}</b><span class="k">${kind}${chain.length > 1 ? ` ${level + 1}/${chain.length}` : ''}</span><span class="px">${p ? sizeText(p) : ''}</span>`);
  } else { box.style.display = 'none'; tag.style.display = 'none'; shade.className = ''; }
  // Toolbar
  const target = showSel ? sel : null;
  const p = phys(target);
  let blocked = '';
  if (D.screenBlocked) blocked = D.screenBlocked;
  else if (!D.out) blocked = D.platform === 'darwin' ? "This screen wasn't found in macOS's display list, so it can't be recorded." : "This monitor wasn't found in the graphics driver's list, so it can't be recorded.";
  else if (D.free != null && D.free < 200 * 1024 * 1024) blocked = `Only ${fmtBytes(D.free)} free where snips are saved.`;
  go.disabled = !p || !!blocked;
  go.textContent = p ? `Record ${sizeText(p)}` : 'Pick an area';
  goKey.disabled = go.disabled || !D.canKey;
  goKey.title = D.canKey ? 'This snip waits until you tap Space in your app (After Effects plays the preview) and ends at the next tap. Shift+Enter' : 'Windows only for now: on a Mac, watching the Space key needs Accessibility permission, which Snipzo does not ask for yet.';
  warn.classList.toggle('link', !!D.screenBlocked); warn.title = D.screenBlocked ? 'Open System Settings' : '';
  warn.hidden = !(blocked || (D.free != null && D.free < 2e9));
  warn.textContent = blocked || (D.free != null ? `${fmtBytes(D.free)} free` : '');
  hint.innerHTML = showSel ? 'Adjust it, then <b>Enter</b> to record' : 'Click a window or panel, or <b>drag</b> a box';
  help.textContent = showSel
    ? 'Drag an edge or corner to resize · drag inside to move · arrows nudge (Shift ×10, Ctrl resizes) · Ctrl+Z undo · click elsewhere to pick again · Esc cancels'
    : 'Scroll to step to a bigger or smaller area · hold Alt while dragging to stop snapping · Esc cancels';
  bar.classList.toggle('bottom', barBottom);
}
// The toolbar starts at the top and stays put while you point (it used to jump away from the mouse whenever the
// highlighted window reached the top of the screen, so it could never be clicked). It moves to the bottom only
// when a settled selection's top edge would sit under it and the bottom is free.
function placeBar() {
  if (!sel || mode !== 'sel') { barBottom = false; return; }
  const zone = 74, bw = bar.offsetWidth, bl = (D.w - bw) / 2;
  const underTop = sel.y < zone && sel.x < bl + bw && sel.x + sel.w > bl;
  const freeBottom = sel.y + sel.h < D.h - zone;
  barBottom = underTop && freeBottom;
}
function tagAt(r, html) {
  tag.innerHTML = html; tag.style.display = 'block';
  const th = 26, x = Math.max(6, Math.min(r.x, D.w - tag.offsetWidth - 6));
  let y = r.y - th - 6; if (y < 6) y = r.y + 6; if (y + th > D.h) y = D.h - th - 6;
  tag.style.left = x + 'px'; tag.style.top = y + 'px';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- mouse ----------
// A settled selection can be changed instead of redone: drag any edge or corner (an 8 px band, the cursor
// shows it), drag inside to move it, arrow keys to nudge, Ctrl+Z to go back. Edges still snap (Alt: off).
const pt = (e) => ({ x: e.clientX, y: e.clientY });
const inBar = (e) => !!(e.target && e.target.closest && e.target.closest('#bar'));
const EDGE = 8;
function hitAt(p) {
  if (mode !== 'sel' || !sel) return null;
  const l = sel.x, t = sel.y, r = sel.x + sel.w, b = sel.y + sel.h;
  if (p.x < l - EDGE || p.x > r + EDGE || p.y < t - EDGE || p.y > b + EDGE) return null;
  const dl = Math.abs(p.x - l), dr = Math.abs(p.x - r), dt = Math.abs(p.y - t), db = Math.abs(p.y - b);
  const v = dt <= EDGE || db <= EDGE ? (dt <= db ? 'n' : 's') : '';
  const hz = dl <= EDGE || dr <= EDGE ? (dl <= dr ? 'w' : 'e') : '';
  if (v || hz) return v + hz;
  return inside(p, sel) ? 'move' : null;
}
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move' };
function setCursor(h) { document.body.style.cursor = (h && CURSOR[h]) || ''; }
function remember() { if (sel) { history.push({ ...sel }); if (history.length > 30) history.shift(); } }
function settle() { mode = 'sel'; placeBar(); render(); snz.send('snz:selecting'); }
let pressFrom = 'hover';
document.addEventListener('mousedown', (e) => {
  if (!D || inBar(e)) return;
  if (e.button === 2) { if (sel) { remember(); sel = null; mode = 'hover'; barBottom = false; setCursor(null); updateHover(pt(e)); } return; }
  if (e.button !== 0) return;
  const p = pt(e), h = hitAt(p);
  if (h === 'move') { mode = 'move'; grab = { start: p, orig: { ...sel } }; return; }
  if (h) { mode = 'resize'; grab = { h, start: p, orig: { ...sel } }; return; }
  pressFrom = mode === 'sel' ? 'sel' : 'hover';
  press = p; mode = 'press';
});
document.addEventListener('mousemove', (e) => {
  if (!D) return;
  const p = pt(e); lastPoint = p;
  const snapOn = !e.altKey;
  if (mode === 'sel') { setCursor(inBar(e) ? null : hitAt(p)); return; }
  if (mode === 'hover' || mode === 'off') { if (mode === 'off') mode = 'hover'; if (!inBar(e)) updateHover(p); return; }
  if (mode === 'press' && Math.hypot(p.x - press.x, p.y - press.y) > CLICK) { mode = 'drag'; grab = { orig: sel ? { ...sel } : null }; press = { x: snap(press.x, edges.xs, snapOn), y: snap(press.y, edges.ys, snapOn) }; snz.send('snz:selecting'); }
  if (mode === 'drag') { sel = norm(press, { x: clampX(snap(p.x, edges.xs, snapOn)), y: clampY(snap(p.y, edges.ys, snapOn)) }); render(); return; }
  if (mode === 'move') {
    const o = grab.orig; let x = o.x + p.x - grab.start.x, y = o.y + p.y - grab.start.y;
    x = Math.max(0, Math.min(D.w - o.w, x)); y = Math.max(0, Math.min(D.h - o.h, y));
    if (snapOn) { const sx = snap(x, edges.xs, true), sr = snap(x + o.w, edges.xs, true); x = sx !== x ? sx : sr !== x + o.w ? sr - o.w : x; const sy = snap(y, edges.ys, true), sb = snap(y + o.h, edges.ys, true); y = sy !== y ? sy : sb !== y + o.h ? sb - o.h : y; }
    sel = { x, y, w: o.w, h: o.h }; render(); return;
  }
  if (mode === 'resize') {
    const o = grab.orig, h = grab.h; let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
    const nx = clampX(snap(o.x + (h.includes('w') ? 0 : o.w) + p.x - grab.start.x, edges.xs, snapOn));
    const ny = clampY(snap(o.y + (h.includes('n') ? 0 : o.h) + p.y - grab.start.y, edges.ys, snapOn));
    if (h.includes('w')) l = nx; if (h.includes('e')) r = nx; if (h.includes('n')) t = ny; if (h.includes('s')) b = ny;
    sel = norm({ x: l, y: t }, { x: r, y: b }); render();
  }
});
document.addEventListener('mouseup', (e) => {
  if (!D || e.button !== 0) return;
  if (mode === 'press') {
    if (pressFrom === 'sel') { chain = []; chainKey = ''; levelBias = 0; updateHover(press); } // clicked outside the selection: pick what's there
    const c = chain[level];
    if (c) { remember(); sel = { x: c.x, y: c.y, w: c.w, h: c.h }; settle(); } else { mode = sel ? 'sel' : 'hover'; render(); }
    return;
  }
  if (mode === 'drag' || mode === 'move' || mode === 'resize') {
    // too small: go back to what was there, never throw the selection away
    if (!phys(sel)) { sel = grab && grab.orig ? grab.orig : null; if (!sel) { mode = 'hover'; if (lastPoint) updateHover(lastPoint); return; } settle(); return; }
    if (grab && grab.orig) history.push({ ...grab.orig });
    settle(); setCursor(hitAt(pt(e)));
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if (!D || mode !== 'hover' || chain.length < 2) return;
  levelBias += e.deltaY < 0 ? 1 : -1; // up = bigger
  const d = defaultLevel(chain); levelBias = Math.max(-d, Math.min(chain.length - 1 - d, levelBias));
  level = d + levelBias; render();
}, { passive: true });
document.addEventListener('keydown', (e) => {
  if (!D) return;
  if (e.key === 'Escape') { snz.send('snz:cancel'); return; }
  if (e.key === 'Enter' && !go.disabled) { record(e.shiftKey); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { // back to the previous selection
    if (history.length) { sel = history.pop(); settle(); } else if (sel) { sel = null; mode = 'hover'; barBottom = false; render(); }
    e.preventDefault(); return;
  }
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (dir && sel && mode === 'sel') { // nudge by real pixels: 1 (Shift: 10); Ctrl moves the right/bottom edge instead
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) / (D.scale || 1), before = { ...sel };
    let n = e.ctrlKey ? { ...sel, w: sel.w + dir[0] * step, h: sel.h + dir[1] * step } : { ...sel, x: sel.x + dir[0] * step, y: sel.y + dir[1] * step };
    n.x = Math.max(0, Math.min(D.w - n.w, n.x)); n.y = Math.max(0, Math.min(D.h - n.h, n.y)); n.w = Math.min(n.w, D.w - n.x); n.h = Math.min(n.h, D.h - n.y);
    if (phys(n)) { if (!e.repeat) history.push(before); sel = n; settle(); }
  }
});

// ---------- toolbar ----------
$('cancel').onclick = () => snz.send('snz:cancel');
warn.onclick = () => { if (D && D.screenBlocked) snz.send('snz:screen-settings'); };
$('full').onclick = () => { remember(); sel = { x: 0, y: 0, w: D.w, h: D.h }; settle(); };
go.onclick = () => record(false);
goKey.onclick = () => record(true);
// onKey: this one snip waits for a Space tap in the app (After Effects preview) and ends at the next tap
function record(onKey) { if (!sel || !phys(sel) || go.disabled || (onKey && !D.canKey)) return; snz.send('snz:record', { displayId: D.displayId, rel: { ...sel }, onKey: !!onKey }); }
function setTog(id, on) { $(id).setAttribute('aria-pressed', on ? 'true' : 'false'); }
$('t-sys').onclick = () => { D.system = !D.system; setTog('t-sys', D.system); snz.send('snz:set', { system: D.system }); };
$('t-mic').onclick = () => { D.mic = !D.mic; setTog('t-mic', D.mic); snz.send('snz:set', { mic: D.mic }); };
function applySettings(s) { D.system = s.system; D.mic = s.mic; setTog('t-sys', s.system); setTog('t-mic', s.mic); $('mic-name').textContent = s.micLabel ? `Mic · ${shortMic(s.micLabel)}` : 'Mic'; }
// "Default - Microphone (NVIDIA Broadcast) (1234:abcd)" -> "NVIDIA Broadcast"
const shortMic = (l) => { let s = String(l).replace(/^(Default - |Communications - )/, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, ''); const m = /^(?:Microphone|Mic|Headset Microphone|Line In)\s*\((.+)\)$/i.exec(s); if (m) s = m[1]; return s.length > 26 ? s.slice(0, 25) + '…' : s; };

// ---------- from main ----------
snz.on('snz:screen', (m) => {
  if (!D || m.displayId !== D.displayId) return;
  shot = { w: m.w, h: m.h, data: new Uint8Array(m.data) }; shotScale = m.w / D.w; contentCache = new Map(); tightCache = new Map();
  chainKey = ''; if (mode === 'hover' && lastPoint) updateHover(lastPoint);
});
snz.on('snz:overlay-init', (d) => {
  D = d; sel = null; chain = []; chainKey = ''; levelBias = 0; mode = 'off'; history = []; barBottom = false; setCursor(null); shot = null; contentCache = new Map(); tightCache = new Map();
  buildEdges(); applySettings(d);
  bar.hidden = false; help.hidden = false;
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => snz.send('snz:overlay-ready')));
});
snz.on('snz:overlay-reset', () => { shot = null; contentCache = new Map(); tightCache = new Map(); D = null; sel = null; mode = 'off'; box.style.display = 'none'; tag.style.display = 'none'; bar.hidden = true; help.hidden = true; shade.className = ''; });
snz.on('snz:clear', () => { if (!D) return; sel = null; mode = 'hover'; chain = []; chainKey = ''; barBottom = false; setCursor(null); render(); });
snz.on('snz:settings', (s) => { if (D) applySettings({ ...D, ...s }); });
snz.on('snz:enter', (m) => { if (D && !go.disabled) record(!!(m && m.onKey)); });
