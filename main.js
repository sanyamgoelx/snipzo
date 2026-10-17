'use strict';
// Snipzo: press the shortcut, click a window or panel (or drag a box), record it with sound,
// get an MP4 in Videos that is already on the clipboard.
//
// Start on Space (v0.2): "Arm" instead of "Record". The picture and sound start straight away (so ffmpeg's warm-up
//           never eats the first frames), the picked app gets the keyboard back, and the snip is cut to start at
//           the moment Space (or Numpad 0) is tapped in that app (After Effects starts its preview) and end at the
//           next tap. The key always reaches the app; Snipzo only watches it, and only while armed or recording.
// Windows:  overlay (one per monitor, made ahead of time) -> border + recording bar (both outside the area;
//           the bar is hidden from capture only when it has to sit over the area) -> done card. Settings from the tray. A hidden "audio" window captures sound.
// Honesty rules (Crofty's, for every tool): the Record button shows the exact size ffmpeg is given;
// the size while recording is read from disk; "Copied" only after the clipboard is read back;
// encoders are checked live when settings open; Discard goes to the Holding Area, never a hard delete.
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, nativeImage, shell, dialog, session, desktopCapturer, systemPreferences } = require('electron');
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os');
const { performance } = require('perf_hooks');
const { spawn } = require('child_process');

app.setAppUserModelId('in.crofty.snipzo');
// One copy at a time. A copy started from source (run.vbs) asks an older idle copy to step aside, so
// testing a change never needs the tray. A copy that is recording never steps aside.
const FROM_SOURCE = !app.isPackaged;
let gotLock = app.requestSingleInstanceLock({ replace: FROM_SOURCE });
if (!gotLock && !FROM_SOURCE) { app.quit(); process.exit(0); }

const W32 = require('./win32');
const M = require('./mac');
const G = require('./geometry');
const R = require('./recorder');
const H = require('./holding');

const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const DEV = process.platform === 'linux' && !!process.env.DISPLAY; // Linux testing: x11grab instead of ddagrab
// The same few calls on both systems (win32.js / mac.js)
const PL = {
  windows: (o) => (IS_MAC ? M.windows(o) : W32.windows(o)),
  outputs: () => (IS_MAC ? M.displays() : W32.outputs()),
  copyFile: (f) => (IS_MAC ? M.copyFile(f) : W32.copyFile(f)),
  clipboardFile: () => (IS_MAC ? M.clipboardFile() : W32.clipboardFile()),
  canCopy: IS_WIN || IS_MAC,
  canKey: IS_WIN || DEV, // Start on Space watches keys: Windows only for now (macOS needs Accessibility permission)
};
const SYS = IS_MAC ? 'macOS' : 'Windows';
const VERSION = app.getVersion();
const PRELOAD = path.join(__dirname, 'preload.js');
const page = (n) => path.join(__dirname, 'ui', n);

// ---------- log ----------
let logFile = null;
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try {
    if (!logFile) { const d = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(d, { recursive: true }); logFile = path.join(d, 'snipzo.log'); if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old'); }
    fs.appendFileSync(logFile, line);
  } catch { /* logging never breaks recording */ }
  if (process.env.SNIPZO_VERBOSE) process.stdout.write(line);
}
process.on('uncaughtException', (e) => log('uncaught', e && e.stack || String(e)));

// ---------- settings ----------
const DEFAULTS = {
  hotkey: IS_MAC ? 'Alt+Shift+R' : 'Super+Shift+R', saveDir: '', fps: 60, quality: 'high', cursor: true,
  system: !IS_MAC, // macOS doesn't hand system sound to apps like this one; the mic works
  mic: true, micId: 'default', micLabel: '', copy: true, countdown: 0, openAtLogin: false,
  syncMs: 0, syncChecked: 0, // measured by Check sound sync: how late the sound was, removed from every recording
};
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; }
  delete settings.startOn; // 0.2.0 kept "Start on Space" on for every snip; it is a per-snip choice now (On Space button)
  if (!settings.saveDir) settings.saveDir = app.getPath('videos');
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile() + '.tmp', JSON.stringify(settings, null, 1)); fs.renameSync(settingsFile() + '.tmp', settingsFile()); } catch (e) { log('settings save failed', e.message); }
}
function hotkeyLabel(acc = settings.hotkey) {
  const names = IS_MAC ? { Super: 'Cmd', Meta: 'Cmd', Command: 'Cmd', CommandOrControl: 'Cmd', CmdOrCtrl: 'Cmd', Control: 'Ctrl', Alt: 'Option' } : { Super: 'Win', Meta: 'Win', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl' };
  return String(acc).split('+').map((p) => names[p] || p).join(' + ');
}

// ---------- the shortcut ----------
let hotkey = { ok: false, how: '', why: '' };
function applyHotkey() {
  globalShortcut.unregisterAll(); W32.keyHook.stop();
  const acc = settings.hotkey, parsed = W32.parseAccelerator(acc);
  if (!parsed) { hotkey = { ok: false, how: '', why: 'This shortcut needs a letter, number or F-key.' }; return hotkey; }
  // Windows keeps Win-key shortcuts for itself (Win+Shift+R opens Snipping Tool's recorder), so those
  // are caught with a keyboard hook before Windows sees them. Everything else is a normal global shortcut.
  if (W32.supported() && parsed.win) {
    const ok = W32.keyHook.start(acc, onHotkey);
    hotkey = ok ? { ok, how: 'hook', why: '' } : { ok, how: 'hook', why: 'Windows did not accept the keyboard hook.' };
  } else {
    let ok = false; try { ok = globalShortcut.register(acc, onHotkey); } catch (e) { log('register failed', e.message); }
    if (!ok && W32.supported()) {
      const hooked = W32.keyHook.start(acc, onHotkey);
      hotkey = hooked ? { ok: true, how: 'hook', why: '' } : { ok: false, how: '', why: 'Another app already uses this shortcut.' };
    } else hotkey = ok ? { ok, how: 'global', why: '' } : { ok, how: '', why: 'Another app already uses this shortcut.' };
  }
  log('shortcut', acc, hotkey);
  refreshTray();
  return hotkey;
}

// ---------- state ----------
let state = 'idle'; // idle | picking | countdown | recording | saving
let tray = null, audioWin = null, settingsWin = null, doneWin = null, borderWin = null, barWin = null;
let overlays = new Map(); // display id -> { win, display, ready }
let encoders = null; // last live check
let rec = null, recCtx = null;

function onHotkey() {
  log('shortcut pressed in state', state);
  if (state === 'idle') startPick();
  else if (state === 'picking') cancelPick();
  else if (state === 'countdown') cancelCountdown();
  else if (state === 'recording') { if (recCtx && recCtx.waitKey && !recCtx.keyStart) cancelArmed('shortcut'); else stopRecording('stopped'); }
}

// ---------- icons ----------
function icon(name) { return nativeImage.createFromPath(path.join(__dirname, 'assets', name)); }
function refreshTray() {
  if (!tray) return;
  const rec = state === 'recording' || state === 'countdown';
  const armed = state === 'recording' && recCtx && recCtx.waitKey && !recCtx.keyStart;
  tray.setImage(icon(rec ? 'tray-rec.png' : 'tray.png'));
  tray.setToolTip(armed ? 'Snipzo: waiting for Space' : rec ? 'Snipzo: recording' : state === 'saving' ? 'Snipzo: saving' : `Snipzo: ${hotkeyLabel()} to record`);
  const items = [];
  if (state === 'recording' && recCtx && recCtx.waitKey && !recCtx.keyStart) items.push({ label: 'Cancel (waiting for Space)', click: () => cancelArmed('tray') });
  else if (state === 'recording') items.push({ label: 'Stop recording', click: () => stopRecording('stopped') });
  else items.push({ label: `Record an area${hotkey.ok ? '\t' + hotkeyLabel() : ''}`, enabled: state === 'idle', click: () => startPick() });
  items.push({ label: 'Open snips folder', click: () => shell.openPath(settings.saveDir) });
  items.push({ type: 'separator' }, { label: 'Settings', click: () => openSettings() }, { label: 'Quit Snipzo', click: () => quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- monitors ----------
// The DXGI output (what ddagrab records) for an Electron display, matched by its rectangle in physical pixels.
function outputFor(display, outs) {
  // Mac: avfoundation records the whole screen at its real pixels; the screen is found by its display id
  if (IS_MAC) { const o = outs.find((x) => x.id === display.id); return o ? { mac: true, screen: o.index, w: Math.round(display.bounds.width * display.scaleFactor), h: Math.round(display.bounds.height * display.scaleFactor) } : null; }
  if (DEV) return { adapter: 0, output: 0, x: 0, y: 0, w: Math.round(display.bounds.width * display.scaleFactor), h: Math.round(display.bounds.height * display.scaleFactor), dev: true };
  const phys = screen.dipToScreenRect(null, display.bounds);
  let best = null, bestD = Infinity;
  for (const o of outs) {
    const d = Math.abs(o.x - phys.x) + Math.abs(o.y - phys.y) + Math.abs(o.w - phys.width) + Math.abs(o.h - phys.height);
    if (d < bestD) { best = o; bestD = d; }
  }
  return best && bestD <= 8 ? best : null;
}
function toDisplayDip(display, physRect) {
  const r = IS_WIN ? screen.screenToDipRect(null, { x: physRect.x, y: physRect.y, width: physRect.w, height: physRect.h }) : { x: physRect.x, y: physRect.y, width: physRect.w, height: physRect.h };
  return { x: r.x - display.bounds.x, y: r.y - display.bounds.y, w: r.width, h: r.height };
}
function clipTo(r, w, h) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y), rr = Math.min(w, r.x + r.w), b = Math.min(h, r.y + r.h);
  return rr - x >= 8 && b - y >= 8 ? { x, y, w: rr - x, h: b - y } : null;
}

// Windows and their panels on one display, in DIPs relative to the display (what the overlay snaps to)
function displayRects(d, wins) {
  const rects = [];
  for (const w of wins) {
    const top = clipTo(toDisplayDip(d, w), d.bounds.width, d.bounds.height);
    if (!top) continue;
    rects.push({
      id: w.id, title: w.title || w.cls, cls: w.cls, z: w.z, ...top,
      parts: w.parts.map((p) => { const r = clipTo(toDisplayDip(d, p), d.bounds.width, d.bounds.height); return r ? { id: p.id, depth: p.depth, cls: p.cls, ...r } : null; }).filter(Boolean),
    });
  }
  return rects;
}

// ---------- pick overlay ----------
function makeOverlay(display) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, enableLargerThanScreen: true, thickFrame: false, roundedCorners: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // over full-screen apps and every Space
  win.setMenu(null);
  const o = { win, display, ready: false };
  win.webContents.on('did-finish-load', () => { o.ready = true; });
  win.loadFile(page('overlay.html'));
  win.on('closed', () => { if (overlays.get(display.id) === o) overlays.delete(display.id); });
  return o;
}
function rebuildOverlays() {
  if (state === 'picking') cancelPick();
  for (const o of overlays.values()) { try { o.win.destroy(); } catch { /* gone */ } }
  overlays = new Map();
  for (const d of screen.getAllDisplays()) overlays.set(d.id, makeOverlay(d));
}

async function startPick() {
  if (state !== 'idle') return;
  state = 'picking'; refreshTray();
  if (doneWin && !doneWin.isDestroyed() && doneWin.isVisible()) { doneWin.hide(); await sleep(60); } // out of the still image
  const t0 = performance.now();
  // Read every window before our overlays cover them
  let wins = [], outs = [];
  try { wins = PL.windows(); } catch (e) { log('windows() failed', e.message); }
  if (DEV && process.env.SNIPZO_FAKE_WINDOWS) wins = JSON.parse(fs.readFileSync(process.env.SNIPZO_FAKE_WINDOWS, 'utf8')).map((w) => ({ ...w, parts: w.parts.filter((p) => !p.drawOnly) })); // Linux testing
  try { outs = PL.outputs(); } catch (e) { log('outputs() failed', e.message); }
  // Mac: without Screen Recording permission the screen grab is black, so Record is blocked until it's allowed
  let screenBlocked = '';
  if (IS_MAC) {
    const st = M.screenAccess();
    if (st !== 'granted') {
      if (st === 'not-determined') M.requestScreenAccess(); // macOS shows its own prompt the first time
      screenBlocked = 'Allow Snipzo in System Settings > Privacy & Security > Screen Recording, then quit and reopen Snipzo.';
      log('screen recording permission:', st);
    }
  }
  const free = await R.freeBytes(settings.saveDir);
  let preShot = null;
  // The still image for content snapping is taken before our overlays appear, so they never need hiding from
  // capture (that flag switches ShadowPlay off and can black out a Discord screen share)
  try { preShot = await captureScreens(); } catch (e) { log('screen image failed', e.message); }
  const cursor = screen.getCursorScreenPoint();
  const under = screen.getDisplayNearestPoint(cursor);
  for (const d of screen.getAllDisplays()) {
    let o = overlays.get(d.id);
    if (!o || o.win.isDestroyed() || JSON.stringify(o.display.bounds) !== JSON.stringify(d.bounds) || o.display.scaleFactor !== d.scaleFactor) {
      if (o) try { o.win.destroy(); } catch { /* gone */ }
      o = makeOverlay(d); overlays.set(d.id, o);
    }
    const out = outputFor(d, outs);
    const rects = displayRects(d, wins);
    const payload = {
      displayId: d.id, w: d.bounds.width, h: d.bounds.height, scale: d.scaleFactor,
      out: out ? { w: out.w, h: out.h } : null, rects, primary: d.id === under.id,
      system: settings.system, mic: settings.mic, micLabel: settings.micLabel || 'Default mic',
      free, saveDir: settings.saveDir, hotkey: hotkeyLabel(), screenBlocked, canKey: PL.canKey, platform: process.platform,
    };
    const show = () => {
      if (state !== 'picking') return;
      o.win.setBounds(d.bounds); // Windows can place a transparent window off by the DPI difference the first time
      o.win.webContents.send('snz:overlay-init', payload);
    };
    if (o.ready) show(); else o.win.webContents.once('did-finish-load', show);
  }
  pickKeys(true);
  log(`pick opened in ${Math.round(performance.now() - t0)} ms, ${wins.length} windows, ${outs.length} outputs`);
  // The still image was taken before the overlays appeared; hand it over once they're up.
  setTimeout(() => sendScreens(preShot).catch((e) => log('screen image failed', e.message)), preShot ? 400 : 0);
}
// One still image per screen, at the display's DIP size, for content snapping in the overlay. Taken while our
// overlays are still hidden.
async function captureScreens() {
  const ds = screen.getAllDisplays();
  // At the monitor's real pixels (not DIPs): content snapping then lands on the exact pixel at 125% / 150%
  const maxW = Math.max(...ds.map((d) => Math.round(d.bounds.width * d.scaleFactor))), maxH = Math.max(...ds.map((d) => Math.round(d.bounds.height * d.scaleFactor)));
  let timer;
  const limit = new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`${SYS} did not hand over a screen image within 5 s`)), 5000); });
  try { return await Promise.race([desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } }), limit]); }
  finally { clearTimeout(timer); }
}
async function sendScreens(pre) {
  const ds = screen.getAllDisplays();
  const t0 = performance.now();
  const sources = pre || await captureScreens();
  if (state !== 'picking') return;
  for (const src of sources) {
    const d = ds.find((x) => String(x.id) === String(src.display_id)) || (ds.length === 1 ? ds[0] : null);
    const o = d && overlays.get(d.id);
    if (!o || o.win.isDestroyed()) continue;
    const img = physImage(src, d);
    const size = img.getSize();
    o.win.webContents.send('snz:screen', { displayId: d.id, w: size.width, h: size.height, data: img.toBitmap() });
  }
  log(`screen images in ${Math.round(performance.now() - t0)} ms`);
}
// The screen image at the display's physical size (Windows hands it over at that size; resize only if it didn't)
function physImage(src, d) {
  const w = Math.round(d.bounds.width * d.scaleFactor), h = Math.round(d.bounds.height * d.scaleFactor);
  const s = src.thumbnail.getSize();
  return s.width === w && s.height === h ? src.thumbnail : src.thumbnail.resize({ width: w, height: h, quality: 'best' });
}
ipcMain.on('snz:overlay-ready', (e) => {
  if (state !== 'picking') return;
  const o = [...overlays.values()].find((x) => x.win.webContents === e.sender); if (!o) return;
  o.win.show(); o.win.setAlwaysOnTop(true, 'screen-saver');
  const cursor = screen.getCursorScreenPoint();
  if (screen.getDisplayNearestPoint(cursor).id === o.display.id) { o.win.focus(); o.win.webContents.focus(); }
});
// Windows may not hand keyboard focus to the overlay while another app is in front, so Esc and Enter are
// caught as global keys while picking (and only then)
function pickKeys(on) {
  for (const k of ['Escape', 'Return', 'Shift+Return']) { try { if (globalShortcut.isRegistered(k)) globalShortcut.unregister(k); } catch { /* fine */ } }
  if (!on) return;
  try { globalShortcut.register('Escape', () => cancelPick()); } catch { /* the overlay still handles it when focused */ }
  try { globalShortcut.register('Return', () => { for (const o of overlays.values()) if (!o.win.isDestroyed()) o.win.webContents.send('snz:enter', { onKey: false }); }); } catch { /* same */ }
  try { globalShortcut.register('Shift+Return', () => { for (const o of overlays.values()) if (!o.win.isDestroyed()) o.win.webContents.send('snz:enter', { onKey: true }); }); } catch { /* same */ }
}
function hideOverlays() {
  pickKeys(false); for (const o of overlays.values()) { try { if (!o.win.isDestroyed()) { o.win.webContents.send('snz:overlay-reset'); o.win.hide(); } } catch { /* gone */ } } }
function cancelPick() { if (state !== 'picking') return; hideOverlays(); state = 'idle'; refreshTray(); }
ipcMain.on('snz:cancel', () => cancelPick());
ipcMain.on('snz:screen-settings', () => { if (IS_MAC) { cancelPick(); M.openScreenSettings(); } });
ipcMain.on('snz:selecting', (e) => { for (const o of overlays.values()) if (o.win.webContents !== e.sender && !o.win.isDestroyed()) o.win.webContents.send('snz:clear'); });
ipcMain.on('snz:set', (_e, patch) => {
  for (const k of ['system', 'mic', 'cursor', 'copy', 'fps', 'quality', 'countdown', 'micId', 'micLabel']) if (k in patch) settings[k] = patch[k];
  saveSettings();
  for (const o of overlays.values()) if (!o.win.isDestroyed()) o.win.webContents.send('snz:settings', { system: settings.system, mic: settings.mic, micLabel: settings.micLabel || 'Default mic' });
});

// ---------- recording ----------
function placeBar(display, regionDip, barW, barH) {
  const b = display.bounds, gap = 8;
  const x = Math.round(Math.min(Math.max(b.x + regionDip.x, b.x + 8), b.x + b.width - barW - 8));
  const below = b.y + regionDip.y + regionDip.h + gap;
  if (below + barH <= b.y + b.height - 4) return { x, y: Math.round(below), inside: false };
  const above = b.y + regionDip.y - gap - barH;
  if (above >= b.y + 4) return { x, y: Math.round(above), inside: false };
  return { x: Math.round(b.x + regionDip.x + (regionDip.w - barW) / 2), y: Math.round(b.y + regionDip.y + regionDip.h - barH - 24), inside: true };
}
function smallWindow(opts) {
  const win = new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    focusable: opts.focusable !== false, thickFrame: false, roundedCorners: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false }, ...opts,
  });
  win.setAlwaysOnTop(true, 'screen-saver'); win.setMenu(null);
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return win;
}
function barSend(msg) { if (barWin && !barWin.isDestroyed()) barWin.webContents.send('snz:bar', msg); }
// Amber while waiting for Space, red once it is really recording
function borderSend() { if (borderWin && !borderWin.isDestroyed()) borderWin.webContents.send('snz:border', { armed: !!(recCtx && recCtx.waitKey && !recCtx.keyStart) }); }

ipcMain.on('snz:record', async (_e, { displayId, rel, onKey }) => {
  if (state !== 'picking') return;
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  let outs = []; try { outs = PL.outputs(); } catch { /* none */ }
  const out = display && outputFor(display, outs);
  const phys = out && G.toRecordRect(rel, display.scaleFactor, out);
  if (!phys) { log('record refused', { displayId, rel, out }); return; }
  const target = IS_WIN ? windowAt(display, rel) : null; // read while our overlay still has the keyboard
  hideOverlays();
  // Hand the keyboard straight back to the picked app, so Space (After Effects preview) works without a click
  if (target) { const ok = W32.focusWindow(target.hwnd); log('keyboard back to', target.title || target.cls, ok ? 'ok' : 'refused by Windows'); }
  startRecording(display, out, phys, target, !!onKey).catch((e) => { log('start failed', e.stack); finishFailed({ why: 'Could not start: ' + e.message }); });
});

// The topmost window under the middle of the picked area (ours are skipped by windows())
function windowAt(display, rel) {
  try {
    const c = screen.dipToScreenPoint({ x: Math.round(display.bounds.x + rel.x + rel.w / 2), y: Math.round(display.bounds.y + rel.y + rel.h / 2) });
    return PL.windows({ maxParts: 0 }).find((w) => c.x >= w.x && c.y >= w.y && c.x < w.x + w.w && c.y < w.y + w.h) || null;
  } catch (e) { log('windowAt failed', e.message); return null; }
}

// Mac: which avfoundation device is that screen ("Capture screen N" comes after the cameras)
async function macDevice(out) {
  if (!out || !out.mac || out.device != null) return out;
  const list = await R.macScreens();
  const m = list.find((x) => x.screen === out.screen);
  if (!m) throw new Error(`ffmpeg didn't list screen ${out.screen} (it listed ${list.length} screens)`);
  return { ...out, device: m.device };
}
const capTarget = (out) => (out.mac ? { mac: { device: out.device } } : { adapter: out.adapter, output: out.output });

async function startRecording(display, out, phys, target = null, waitKey = false) {
  out = await macDevice(out);
  waitKey = waitKey && PL.canKey;
  const regionDip = G.toDip(phys, display.scaleFactor);
  recCtx = { display, out, phys, regionDip, notes: [], micMuted: false, startedAt: null, audio: null, waitKey, keyStart: null, keyStop: null, target };
  state = settings.countdown && !waitKey ? 'countdown' : 'recording'; refreshTray();
  log('record', { display: display.id, out, phys, fps: settings.fps, startOn: waitKey ? 'space' : 'now' });

  // Border: a dashed frame just outside the area, click-through. Its line is drawn in the outer 2 px of a window
  // 4 px bigger than the area on each side (rounded outwards), so it never lands inside the recording and
  // needs no hiding from capture.
  const L = Math.floor(display.bounds.x + regionDip.x) - 4, T = Math.floor(display.bounds.y + regionDip.y) - 4;
  const R2 = Math.ceil(display.bounds.x + regionDip.x + regionDip.w) + 4, B2 = Math.ceil(display.bounds.y + regionDip.y + regionDip.h) + 4;
  const bd = { x: L, y: T, width: R2 - L, height: B2 - T };
  borderWin = smallWindow({ ...bd, focusable: false });
  borderWin.setIgnoreMouseEvents(true);
  borderWin.loadFile(page('border.html'));
  borderWin.webContents.on('did-finish-load', () => borderSend());
  borderWin.once('ready-to-show', () => borderWin && !borderWin.isDestroyed() && borderWin.showInactive());

  // Recording bar
  const BW = 380, BH = 48;
  const pos = placeBar(display, regionDip, BW, BH);
  barWin = smallWindow({ x: pos.x, y: pos.y, width: BW, height: BH });
  barWin.loadFile(page('bar.html'));
  // Only when there's no room outside the area does the bar sit over it; only then is it hidden from capture
  // (and the done card says so, since ShadowPlay and screen sharing react to that while it's up)
  if (pos.inside && !DEV) {
    let barHidden = false;
    if (IS_MAC) { try { barWin.setContentProtection(true); barHidden = true; } catch { /* shows */ } } else barHidden = W32.setCaptureHidden(barWin, true);
    recCtx.notes.push(barHidden
      ? (IS_MAC ? 'The recording bar had to sit over the area, so it was hidden from screen capture while recording (screen sharing may show a gap there).' : 'The recording bar had to sit over the area, so it was hidden from screen capture while recording. ShadowPlay and screen sharing may have paused for that time.')
      : 'The recording bar may show in the video.');
  }
  barWin.once('ready-to-show', () => { if (barWin && !barWin.isDestroyed()) { barWin.showInactive(); pushBar(); } });

  if (settings.countdown && !waitKey) {
    for (let n = settings.countdown; n > 0; n--) {
      if (state !== 'countdown') return;
      barSend({ phase: 'countdown', n });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (state !== 'countdown') return;
    state = 'recording'; refreshTray();
  }
  await beginCapture();
}

function cancelCountdown() {
  if (state !== 'countdown') return;
  W32.keyWatch.stop();
  closeRecWindows(); state = 'idle'; refreshTray(); recCtx = null;
}

let audioWaiter = null;
function audioCall(type, data, timeout = 5000) {
  return new Promise((resolve) => {
    if (!audioWin || audioWin.isDestroyed()) return resolve(null);
    const t = setTimeout(() => { audioWaiter = null; resolve(null); }, timeout);
    audioWaiter = { type, done: (d) => { clearTimeout(t); audioWaiter = null; resolve(d); } };
    audioWin.webContents.send('snz:audio', { type, ...data });
  });
}
ipcMain.on('snz:audio-reply', (_e, d) => { if (audioWaiter && d && d.type === audioWaiter.type) audioWaiter.done(d); });
let lastMeter = 0;
ipcMain.on('snz:audio-chunk', (_e, d) => {
  const now = performance.now();
  if (rec && d && d.pcm) rec.audioChunk(Buffer.from(d.pcm), d.frames, now);
  if (now - lastMeter > 90) { lastMeter = now; barSend({ meter: d.peak || 0 }); }
});

async function pickEncoder() {
  if (DEV) return { id: 'libx264', name: 'CPU (x264)' };
  if (!encoders) encoders = await R.checkEncoders();
  return encoders.find((e) => e.ok) || null;
}

async function beginCapture(retryFrom) {
  const ctx = recCtx; if (!ctx) return;
  const enc = retryFrom ? (encoders || []).find((e) => e.ok && R.ENCODERS.findIndex((x) => x.id === e.id) > R.ENCODERS.findIndex((x) => x.id === retryFrom)) : await pickEncoder();
  if (!enc) return finishFailed({ why: retryFrom ? 'No other video encoder worked.' : 'No video encoder works on this PC.' });
  ctx.encoder = enc;

  // Sound first, so it is already flowing when the picture starts
  let sound = { system: null, mic: null };
  if (DEV && process.env.SNIPZO_FAKE_AUDIO) { sound = { system: { ok: true }, mic: null }; ctx.audio = sound; } // Linux testing: the test feeds sound itself
  else if (!retryFrom && (settings.system || settings.mic)) {
    if (IS_MAC && settings.mic) { try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* the note below says what happened */ } }
    const r = await audioCall('start', { system: settings.system, mic: settings.mic, micId: settings.micId });
    if (!r) { sound = { system: settings.system ? { ok: false, why: 'the sound recorder did not answer' } : null, mic: settings.mic ? { ok: false, why: 'the sound recorder did not answer' } : null }; }
    else sound = { system: r.system, mic: r.mic };
    if (sound.system && !sound.system.ok) ctx.notes.push(`System sound wasn't recorded: ${sound.system.why}`);
    if (sound.mic && !sound.mic.ok) ctx.notes.push(`Mic wasn't recorded: ${sound.mic.why}`);
    ctx.audio = sound;
  } else if (retryFrom) sound = ctx.audio || sound;
  const withSound = !!((sound.system && sound.system.ok) || (sound.mic && sound.mic.ok));
  if (!withSound && ctx.audio && audioWin) audioCall('stop', {}, 1500);

  const dev = DEV ? { display: process.env.DISPLAY, x: Math.round(ctx.display.bounds.x * ctx.display.scaleFactor), y: Math.round(ctx.display.bounds.y * ctx.display.scaleFactor) } : null;
  rec = new R.Recording({
    ...capTarget(ctx.out), rect: ctx.phys, fps: settings.fps, cursor: settings.cursor,
    quality: settings.quality, encoder: enc.id, audio: withSound, syncMs: settings.syncMs || 0, log: (s) => log(s), dev,
  });
  const mine = rec;
  rec.on('started', () => {
    if (rec !== mine) return;
    if (!ctx.waitKey) ctx.startedAt = Date.now();
    log('picture started with', enc.id, ctx.waitKey ? '(armed: waiting for Space)' : '');
    pushBar(); refreshTray();
  });
  if (ctx.waitKey && !retryFrom) armKeys(ctx);
  rec.on('died', async ({ why }) => {
    if (rec !== mine || state !== 'recording') return;
    if (ctx.startedAt == null && enc.gpu !== undefined && !DEV) {
      // The encoder failed before the first frame: try the next one that passed the live check
      log(`${enc.id} failed before starting: ${why}`);
      await mine.stop(); await mine.discardTemp();
      encoders = (encoders || []).map((e) => (e.id === enc.id ? { ...e, ok: false, why } : e));
      ctx.notes.push(`${enc.name} failed, so this was recorded with the next encoder.`);
      rec = null; return beginCapture(enc.id);
    }
    stopRecording('died', why);
  });
  rec.start();
  pushBar();
  ctx.ticker = setInterval(async () => {
    if (rec !== mine) return;
    barSend({ bytes: mine.bytesSoFar() });
    const now = Date.now();
    if (!ctx.lastFree || now - ctx.lastFree > 5000) {
      ctx.lastFree = now;
      const free = await R.freeBytes(settings.saveDir);
      if (free != null && free < 150 * 1024 * 1024 && state === 'recording') { ctx.notes.push('Stopped early: the drive was nearly full.'); stopRecording('disk'); }
    }
  }, 500);
}

function pushBar() {
  const ctx = recCtx; if (!ctx) return;
  const ready = !!(rec && rec.videoStart != null);
  barSend({
    phase: state === 'saving' ? 'saving' : ctx.waitKey && !ctx.keyStart ? (ready ? 'armed' : 'starting') : ctx.startedAt ? 'recording' : 'starting', startedAt: ctx.startedAt,
    waitKey: ctx.waitKey, keyName: ctx.keyName || 'Space',
    hotkey: hotkey.ok ? hotkeyLabel() : '',
    mic: ctx.audio && ctx.audio.mic && ctx.audio.mic.ok ? { muted: ctx.micMuted } : null,
    sound: !!(ctx.audio && ((ctx.audio.system && ctx.audio.system.ok) || (ctx.audio.mic && ctx.audio.mic.ok))),
  });
}
ipcMain.on('snz:stop', () => {
  if (state === 'recording' && recCtx && recCtx.waitKey && !recCtx.keyStart) cancelArmed('bar');
  else if (state === 'recording') stopRecording('stopped');
  else if (state === 'countdown') cancelCountdown();
});

// ---------- Start on Space ----------
// Watches Space and Numpad 0 (both start After Effects' preview) without taking them from the app. The first tap
// marks the start, the next tap the end; the recording itself has been running since the snip was armed, and is
// cut to exactly those moments when it is saved.
function armKeys(ctx) {
  const name = (vk) => (vk === W32.VK_NUMPAD0 ? 'Numpad 0' : 'Space');
  const ok = W32.keyWatch.start([W32.VK_SPACE, W32.VK_NUMPAD0], ({ vk, downAt }) => onStartKey(ctx, downAt, name(vk)));
  log('watching Space / Numpad 0:', ok ? 'yes' : 'no');
  if (!ok && !DEV) { ctx.notes.push("Snipzo couldn't watch the Space key, so this was recorded from when you pressed Start on Space."); ctx.waitKey = false; ctx.startedAt = Date.now(); pushBar(); borderSend(); refreshTray(); }
}
function onStartKey(ctx, at, keyName) {
  if (recCtx !== ctx || state !== 'recording') return;
  if (!ctx.keyStart) {
    ctx.keyStart = at; ctx.keyName = keyName;
    ctx.startedAt = Date.now() - Math.max(0, performance.now() - at); // the bar's clock counts from the tap
    log(`${keyName} tapped: start (${rec && rec.videoStart != null ? (rec.pictureTime(at)).toFixed(3) + ' s into the picture' : 'before the picture started'})`);
    pushBar(); borderSend(); refreshTray();
  } else if (!ctx.keyStop) {
    ctx.keyStop = at;
    log(`${keyName} tapped again: stop`);
    stopRecording('key');
  }
}
function cancelArmed(how) {
  const ctx = recCtx; if (!ctx || state !== 'recording') return;
  log('armed snip cancelled before Space:', how);
  W32.keyWatch.stop();
  clearInterval(ctx.ticker);
  const r = rec; rec = null;
  (async () => {
    if (r) { await r.stop(); await r.discardTemp(); } // only our own temporary files from this run
    if (ctx.audio) await audioCall('stop', {}, 2000);
  })().catch((e) => log('cancel cleanup', e.message));
  closeRecWindows(); recCtx = null; state = 'idle'; refreshTray();
  showDone({ ok: false, stopped: true, why: 'Stopped before Space was pressed, so nothing was saved.', notes: [], display: ctx.display });
}
ipcMain.on('snz:mute-mic', async (_e, muted) => {
  if (!recCtx || !(recCtx.audio && recCtx.audio.mic && recCtx.audio.mic.ok)) return;
  const r = await audioCall('mute', { muted: !!muted }, 1500);
  if (r && r.ok) { recCtx.micMuted = !!muted; if (muted) recCtx.mutedOnce = true; }
  pushBar();
});
ipcMain.on('snz:bar-size', (_e, { w }) => { if (barWin && !barWin.isDestroyed() && w > 0) { const b = barWin.getBounds(); barWin.setBounds({ ...b, width: Math.ceil(w) }); } });

function closeRecWindows() {
  for (const w of [borderWin, barWin]) { try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* gone */ } }
  borderWin = barWin = null;
}

async function stopRecording(reason, why) {
  if (state !== 'recording' || !recCtx) return;
  const ctx = recCtx, r = rec;
  const stopAt = performance.now();
  state = 'saving'; refreshTray(); pushBar();
  W32.keyWatch.stop();
  clearInterval(ctx.ticker);
  log('stopping:', reason, why || '');
  if (r) await r.stop();
  if (ctx.audio) await audioCall('stop', {}, 2000);
  if (borderWin && !borderWin.isDestroyed()) borderWin.destroy(); borderWin = null;
  if (!r) return finishFailed({ why: why || 'Nothing was recorded.' });
  if (ctx.waitKey && ctx.keyStart == null && reason !== 'died' && reason !== 'disk') { // stopped while still waiting: same as Cancel
    await r.discardTemp(); closeRecWindows(); rec = null; recCtx = null; state = 'idle'; refreshTray();
    return showDone({ ok: false, stopped: true, why: 'Stopped before Space was pressed, so nothing was saved.', notes: [], display: ctx.display });
  }
  // Start on Space: keep only what's between the taps (the end is the second tap, or when Stop was pressed)
  let cut = null;
  if (ctx.waitKey && ctx.keyStart != null && r.videoStart != null) {
    const from = r.pictureTime(ctx.keyStart), to = r.pictureTime(ctx.keyStop != null ? ctx.keyStop : stopAt);
    cut = { from: Math.max(0, from), to: Math.max(Math.max(0, from) + 0.1, to) };
    if (from < 0) ctx.notes.push(`${ctx.keyName} was pressed ${(-from).toFixed(1)} s before Snipzo was ready, so the start of the preview is missing. Wait for "Ready" on the bar next time.`);
    else ctx.notes.push(`Starts at your ${ctx.keyName} tap${ctx.keyStop != null ? ' and ends at the next one' : ''} (${from.toFixed(1)} s of waiting cut off).`);
    log('cut', cut);
  } else if (ctx.waitKey && ctx.keyStart == null) ctx.notes.push('Space was never pressed, so this is everything from when you pressed Start on Space.');
  const res = await r.finish(settings.saveDir, cut);
  if (r.secondPass) ctx.notes.push(`The cut was encoded again on the ${r.secondPass} because ${ctx.encoder && ctx.encoder.name} refused.`);
  if (!res.ok) return finishFailed({ why: why ? `${why}` : res.why, kept: res.kept, file: res.file });
  if (reason === 'died') ctx.notes.push(`The recording stopped by itself: ${why}`);
  let copy = null;
  if (settings.copy) {
    if (!PL.canCopy) copy = { ok: false, why: 'copying files works on Windows and macOS only' };
    else {
      const c = await PL.copyFile(res.file);
      const back = c.ok ? await PL.clipboardFile() : null;
      copy = c.ok && back && path.resolve(back).toLowerCase() === path.resolve(res.file).toLowerCase() ? { ok: true } : { ok: false, why: c.why || 'the clipboard did not keep the file' };
    }
  }
  if (ctx.mutedOnce) ctx.notes.push('The mic was muted for part of it.');
  const pix = res.info.video && res.info.video.pix;
  if (pix && !/420|nv12/.test(pix)) ctx.notes.push(`The picture was saved as ${pix}, which some apps (Discord, WhatsApp) can't play.`);
  log('saved', res.file, { ...res.info, file: undefined }, 'clipboard:', copy);
  const thumb = await R.thumbnail(res.file, res.info.duration);
  closeRecWindows();
  rec = null; recCtx = null; state = 'idle'; refreshTray();
  showDone({ ok: true, file: res.file, info: res.info, thumb, copy, notes: ctx.notes, encoder: ctx.encoder && ctx.encoder.name, display: ctx.display });
}

function hasFiles(dir) { try { return fs.readdirSync(dir).some((n) => fs.statSync(path.join(dir, n)).size > 0); } catch { return false; } }
function finishFailed({ why, kept, file }) {
  const ctx = recCtx;
  W32.keyWatch.stop();
  if (ctx && ctx.audio) audioCall('stop', {}, 2000); // never leave the mic or system sound open after a failure
  if (kept && !hasFiles(kept)) { try { fs.rmSync(kept, { recursive: true, force: true }); } catch { /* ours, empty */ } kept = null; }
  closeRecWindows();
  if (ctx && ctx.ticker) clearInterval(ctx.ticker);
  if (rec) { rec.stop().catch(() => {}); }
  rec = null; recCtx = null; state = 'idle'; refreshTray();
  log('failed:', why, kept || '');
  showDone({ ok: false, why, kept, file, notes: ctx ? ctx.notes : [], display: ctx ? ctx.display : screen.getPrimaryDisplay() });
}

// ---------- done card ----------
let doneTimer = null, doneData = null;
function showDone(data) {
  doneData = data;
  const d = data.display || screen.getPrimaryDisplay();
  const W = 360, Hh = data.ok ? 340 : 230;
  const wa = d.workArea;
  if (!doneWin || doneWin.isDestroyed()) {
    doneWin = smallWindow({ width: W, height: Hh, focusable: true });
    doneWin.loadFile(page('done.html'));
    doneWin.webContents.on('did-finish-load', () => sendDone());
  } else sendDone();
  doneWin.setBounds({ x: wa.x + wa.width - W - 16, y: wa.y + wa.height - Hh - 16, width: W, height: Hh });
  doneWin.showInactive();
  armDoneTimer();
}
function sendDone() {
  if (!doneWin || doneWin.isDestroyed() || !doneData) return;
  const { display, ...rest } = doneData;
  doneWin.webContents.send('snz:done', { ...rest, saveDir: settings.saveDir });
}
function armDoneTimer(ms = 9000) { clearTimeout(doneTimer); doneTimer = setTimeout(() => { if (doneWin && !doneWin.isDestroyed()) doneWin.hide(); }, ms); }
ipcMain.on('snz:done-hover', (_e, on) => { if (on) clearTimeout(doneTimer); else armDoneTimer(4000); });
ipcMain.on('snz:done-size', (_e, { h }) => { if (doneWin && !doneWin.isDestroyed() && h > 0) { const b = doneWin.getBounds(); const nh = Math.ceil(h); doneWin.setBounds({ x: b.x, y: b.y + b.height - nh, width: b.width, height: nh }); } });
ipcMain.on('snz:done-close', () => { clearTimeout(doneTimer); if (doneWin && !doneWin.isDestroyed()) doneWin.hide(); });
ipcMain.handle('snz:open', async (_e, file) => { if (doneData && file === doneData.file && fs.existsSync(file)) { const err = await shell.openPath(file); return { ok: !err, why: err }; } return { ok: false, why: 'The file is not there any more.' }; });
ipcMain.handle('snz:show', async (_e, file) => {
  if (!file || !fs.existsSync(file)) return { ok: false, why: 'The file is not there any more.' };
  if (IS_WIN) spawn('explorer.exe', [`/select,"${file}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  else shell.showItemInFolder(file);
  return { ok: true };
});
ipcMain.handle('snz:show-dir', async (_e, dir) => { if (dir && fs.existsSync(dir)) { await shell.openPath(dir); return { ok: true }; } return { ok: false, why: 'That folder is not there any more.' }; });
ipcMain.handle('snz:discard', async (_e, file) => {
  if (!doneData || file !== doneData.file || !fs.existsSync(file)) return { ok: false, why: 'The file is not there any more.' };
  try {
    const held = await H.hold(file, { batch: H.batchName(), label: 'Discarded in Snipzo' });
    doneData.held = held;
    let clipStale = false;
    if (PL.canCopy) { const back = await PL.clipboardFile(); clipStale = !!(back && path.resolve(back).toLowerCase() === path.resolve(file).toLowerCase()); }
    log('discarded to', held);
    return { ok: true, held, clipStale };
  } catch (e) { log('discard failed', e.message); return { ok: false, why: e.message }; }
});
ipcMain.handle('snz:undo-discard', async (_e, file) => {
  if (!doneData || doneData.file !== file || !doneData.held) return { ok: false, why: 'Nothing to put back.' };
  try {
    if (fs.existsSync(file)) return { ok: false, why: 'A file with that name is back in the folder already.' };
    await fsp.rename(doneData.held, file).catch(async () => { await fsp.copyFile(doneData.held, file); await fsp.unlink(doneData.held); });
    await H.forget(doneData.held); doneData.held = null;
    return { ok: true };
  } catch (e) { return { ok: false, why: e.message }; }
});
ipcMain.handle('snz:copy-again', async (_e, file) => {
  if (!PL.canCopy) return { ok: false, why: 'copying files works on Windows and macOS only' };
  if (!file || !fs.existsSync(file)) return { ok: false, why: 'The file is not there any more.' };
  const c = await PL.copyFile(file); const back = c.ok ? await PL.clipboardFile() : null;
  return c.ok && back && path.resolve(back).toLowerCase() === path.resolve(file).toLowerCase() ? { ok: true } : { ok: false, why: c.why || 'the clipboard did not keep the file' };
});
ipcMain.handle('snz:log-text', async () => { try { return fs.readFileSync(logFile, 'utf8').slice(-6000); } catch { return ''; } });

// ---------- settings window ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 480, height: 720, minWidth: 420, minHeight: 500, title: 'Snipzo settings', backgroundColor: '#0D0F14', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'), show: false, webPreferences: { preload: PRELOAD },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(page('settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}
function settingsView() {
  return {
    settings, version: VERSION, hotkey: { ...hotkey, label: hotkeyLabel() }, platformWin: IS_WIN, platform: process.platform, canKey: PL.canKey,
    logDir: logFile ? path.dirname(logFile) : '', startPath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
  };
}
ipcMain.handle('snz:settings-get', () => settingsView());
ipcMain.handle('snz:encoders', async () => { encoders = DEV ? [{ id: 'libx264', name: 'CPU (x264)', ok: true, why: '' }] : await R.checkEncoders(); return encoders; });
ipcMain.handle('snz:settings-set', async (_e, patch) => {
  const allowed = ['fps', 'quality', 'cursor', 'system', 'mic', 'micId', 'micLabel', 'copy', 'countdown', 'syncMs', 'syncChecked'];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  if ('openAtLogin' in patch) {
    settings.openAtLogin = !!patch.openAtLogin;
    try { app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath }); } catch (e) { log('login item', e.message); }
    settings.openAtLogin = !!app.getLoginItemSettings({ path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath }).openAtLogin;
  }
  if ('hotkey' in patch && patch.hotkey && patch.hotkey !== settings.hotkey) {
    const prev = settings.hotkey; settings.hotkey = patch.hotkey;
    const h = applyHotkey();
    if (!h.ok) { const failed = { ...h, label: hotkeyLabel() }; settings.hotkey = prev; applyHotkey(); saveSettings(); return { ...settingsView(), hotkeyError: `${failed.label}: ${failed.why}` }; }
  }
  saveSettings();
  return settingsView();
});
ipcMain.handle('snz:pick-folder', async () => {
  const r = await dialog.showOpenDialog(settingsWin, { title: 'Save snips to', defaultPath: settings.saveDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return settingsView();
  settings.saveDir = r.filePaths[0]; saveSettings(); return settingsView();
});
ipcMain.handle('snz:pause-hotkey', (_e, on) => { // while the settings window records a new shortcut
  if (on) { globalShortcut.unregisterAll(); W32.keyHook.stop(); } else applyHotkey();
  return true;
});

// ---------- sound sync check ----------
// Records a small test window that flashes and beeps together three times, measures how far apart they land,
// and saves that as the correction for every recording. Uses the same capture path as a real snip.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ipcMain.handle('snz:sync-check', () => syncCheck());
async function syncCheck() {
  if (state !== 'idle') return { ok: false, why: 'Finish the current recording first.' };
  state = 'syncing'; refreshTray();
  let win = null, r = null, tmp = null;
  try {
    const d = screen.getPrimaryDisplay(), W = 480, Hh = 270;
    const x = Math.round(d.workArea.x + (d.workArea.width - W) / 2), y = Math.round(d.workArea.y + (d.workArea.height - Hh) / 2);
    win = new BrowserWindow({ x, y, width: W, height: Hh, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, backgroundColor: '#000000', show: false, webPreferences: { preload: PRELOAD, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    win.setAlwaysOnTop(true, 'screen-saver'); win.setMenu(null);
    await win.loadFile(page('sync.html')); win.showInactive(); await sleep(500);
    let outs = []; try { outs = PL.outputs(); } catch { /* none */ }
    const out = await macDevice(outputFor(d, outs));
    const phys = out && G.toRecordRect({ x: x - d.bounds.x + 24, y: y - d.bounds.y + 24, w: W - 48, h: Hh - 64 }, d.scaleFactor, out);
    if (!phys) return { ok: false, why: "The main monitor wasn't found in the graphics driver's list." };
    const enc = await pickEncoder(); if (!enc) return { ok: false, why: 'No video encoder works on this PC.' };
    const a = DEV && process.env.SNIPZO_FAKE_AUDIO ? { system: { ok: true } } : await audioCall('start', { system: true, mic: false });
    if (!a || !a.system || !a.system.ok) return { ok: false, why: `System sound couldn't be recorded: ${(a && a.system && a.system.why) || 'the sound recorder did not answer'}.` };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snipzo-sync-'));
    const dev = DEV ? { display: process.env.DISPLAY, x: 0, y: 0 } : null;
    r = new R.Recording({ ...capTarget(out), rect: phys, fps: 60, cursor: false, quality: 'high', encoder: enc.id, audio: true, syncMs: 0, log: (m) => log('[sync] ' + m), dev });
    rec = r;
    const started = new Promise((res) => { r.once('started', () => res(true)); r.once('died', () => res(false)); setTimeout(() => res(false), 10000); });
    r.start();
    if (!(await started)) { await r.stop(); return { ok: false, why: 'The screen grab did not start: ' + r.why() }; }
    await sleep(700);
    const done = new Promise((res) => { ipcMain.once('snz:sync-done', () => res()); setTimeout(res, 6000); });
    win.webContents.send('snz:sync-go'); await done; await sleep(500);
    await r.stop(); rec = null;
    if (!DEV || !process.env.SNIPZO_FAKE_AUDIO) await audioCall('stop', {}, 2000);
    const res = await r.finish(tmp);
    if (!res.ok) return { ok: false, why: res.why };
    const m = await R.measureSync(res.file);
    log('sync check', m);
    if (m.why) return { ok: false, why: `Couldn't measure: ${m.why}.` };
    settings.syncMs = m.soundLateMs; settings.syncChecked = Date.now(); saveSettings();
    return { ok: true, soundLateMs: m.soundLateMs, pairs: m.pairs.length, view: settingsView() };
  } catch (e) { log('sync check failed', e.stack); return { ok: false, why: e.message }; }
  finally {
    if (rec === r) rec = null;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* gone */ }
    if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
    state = 'idle'; refreshTray();
  }
}

// ---------- the hidden sound window ----------
function makeAudioWindow() {
  audioWin = new BrowserWindow({ show: false, width: 200, height: 100, skipTaskbar: true, webPreferences: { preload: PRELOAD, backgroundThrottling: false } });
  audioWin.loadFile(page('audio.html'));
  audioWin.on('closed', () => { audioWin = null; });
}

// ---------- tools folder entry (F:\Tool\_shared\TOOLS-CONTRACT.md) ----------
function announce() {
  try {
    const dir = IS_WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'sanyamgoelx', 'tools') : IS_MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'sanyamgoelx', 'tools') : path.join(os.homedir(), '.local', 'share', 'sanyamgoelx', 'tools');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snipzo.json'), JSON.stringify({ id: 'snipzo', name: 'Snipzo', version: VERSION, app: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, cli: null, can: ['record-screen'], repo: 'sanyamgoelx/snipzo', written: Math.floor(Date.now() / 1000) }, null, 1));
  } catch (e) { log('announce failed', e.message); }
}

// ---------- start ----------
function quit() { W32.keyHook.stop(); W32.keyWatch.stop(); W32.quitKeys(); globalShortcut.unregisterAll(); app.exit(0); }
app.on('second-instance', (_e, _argv, _cwd, data) => {
  if (data && data.replace && FROM_SOURCE && state === 'idle') { log('a newer copy started from source: stepping aside'); quit(); return; }
  openSettings();
});
app.on('window-all-closed', (e) => { e.preventDefault && e.preventDefault(); }); // lives in the tray
app.on('will-quit', () => { W32.keyHook.stop(); W32.keyWatch.stop(); W32.quitKeys(); globalShortcut.unregisterAll(); });

// From source only: wait for an older copy to step aside. An older build that doesn't know how is ended
// only when a .force-replace file sits next to main.js (deleted once used).
async function takeOverFromOlder() {
  for (let i = 0; i < 12 && !gotLock; i++) { await new Promise((r) => setTimeout(r, 500)); gotLock = app.requestSingleInstanceLock({ replace: true }); }
  if (gotLock) return true;
  const flag = path.join(__dirname, '.force-replace');
  if (IS_WIN && fs.existsSync(flag)) {
    try { fs.unlinkSync(flag); } catch { /* fine */ }
    const ps = `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -like '*\\snipzo\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    await new Promise((r) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => r()));
    for (let i = 0; i < 10 && !gotLock; i++) { await new Promise((r) => setTimeout(r, 500)); gotLock = app.requestSingleInstanceLock({ replace: true }); }
  }
  return gotLock;
}
// From source only: restart when the code changes and nothing is being recorded
function watchSource() {
  if (!FROM_SOURCE || process.env.SNIPZO_TEST) return;
  let timer = null;
  const restart = () => { clearTimeout(timer); timer = setTimeout(() => { if (state !== 'idle') return restart(); log('source changed: restarting'); W32.keyHook.stop(); W32.quitKeys(); app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--relaunched').concat('--relaunched') }); app.exit(0); }, 1500); };
  for (const d of [__dirname, path.join(__dirname, 'ui')]) {
    try { fs.watch(d, (_ev, name) => { if (name === '.dev-command') devCommand(); else if (name && /\.(js|html|css)$/.test(name)) restart(); }); } catch (e) { log('watch failed', e.message); }
  }
}
// From source only: a ".dev-command" file next to main.js runs one command (for testing without the tray):
// sync-check | settings | pick | snap-report | record x y w h secs | quit. The result goes to the log; the file is deleted.
// From source only: what the picker would snap to right now, without opening it (for testing while
// simulated input is blocked). Writes logs/snap-report.json and one screen image per display.
async function snapReport() {
  const C = require('./ui/content.js').Content;
  const dir = path.join(app.getPath('userData'), 'logs');
  let wins = []; try { wins = PL.windows(); } catch (e) { return { ok: false, why: e.message }; }
  log(`snap-report: ${wins.length} windows, taking screen images`);
  const t0 = performance.now();
  const sources = await captureScreens();
  log(`snap-report: ${sources.length} screen images in ${Math.round(performance.now() - t0)} ms`);
  const out = { at: new Date().toISOString(), displays: [] };
  for (const d of screen.getAllDisplays()) {
    const src = sources.find((x) => String(x.display_id) === String(d.id)) || (sources.length === 1 ? sources[0] : null);
    if (!src) continue;
    const img = physImage(src, d);
    const size = img.getSize();
    const shot = { w: size.width, h: size.height, data: new Uint8Array(img.toBitmap()) }, sx = size.width / d.bounds.width;
    fs.writeFileSync(path.join(dir, `snap-${d.id}.png`), img.toPNG());
    const rects = displayRects(d, wins).map((w) => ({
      ...w, content: C.find(shot, sx, w),
      parts: w.parts.map((p) => { const t = C.tighten(shot, sx, p); return { ...p, tight: t !== p ? t : null, content: C.find(shot, sx, t) }; }),
    }));
    out.displays.push({ id: d.id, bounds: d.bounds, scale: d.scaleFactor, image: `snap-${d.id}.png`, rects });
    log(`snap-report: display ${d.id} done`);
  }
  fs.writeFileSync(path.join(dir, 'snap-report.json'), JSON.stringify(out, null, 1));
  // From source: a copy next to the code too (scratch/ is left out of builds), so it can be read without the AppData folder
  try { const sc = path.join(__dirname, 'scratch'); fs.mkdirSync(sc, { recursive: true }); for (const f of fs.readdirSync(dir).filter((n) => /^snap-/.test(n))) fs.copyFileSync(path.join(dir, f), path.join(sc, f)); } catch (e) { log('snap-report copy', e.message); }
  return { ok: true, displays: out.displays.length, windows: wins.length };
}
let devBusy = false;
async function devCommand() {
  const f = path.join(__dirname, '.dev-command');
  if (devBusy || !fs.existsSync(f)) return;
  devBusy = true;
  try {
    const cmd = fs.readFileSync(f, 'utf8').trim();
    if (!cmd) return; // still being written; the next change event brings the text
    fs.unlinkSync(f);
    log('dev command:', cmd);
    if (cmd === 'sync-check') log('dev sync-check result', await syncCheck());
    else if (cmd === 'settings') openSettings();
    else if (cmd === 'pick') startPick();
    else if (cmd === 'snap-report') log('dev snap-report', await snapReport());
    else if (cmd.startsWith('record ')) { // record <x> <y> <w> <h> <seconds>: DIPs on the main monitor, through the normal flow
      const [x, y, w, h, secs] = cmd.split(/\s+/).slice(1).map(Number);
      if (state !== 'idle') { log('dev record: busy'); return; }
      const d = screen.getPrimaryDisplay();
      let outs = []; try { outs = PL.outputs(); } catch { /* none */ }
      const out = outputFor(d, outs), phys = out && G.toRecordRect({ x, y, w, h }, d.scaleFactor, out);
      if (!phys) { log('dev record: no output for the main monitor'); return; }
      state = 'picking';
      await startRecording(d, out, phys);
      setTimeout(() => { if (state === 'recording') stopRecording('stopped'); }, (secs || 3) * 1000);
    }
    else if (cmd === 'smoke') { const r = await smoke({ exit: false }); const sc = path.join(__dirname, 'scratch'); fs.mkdirSync(sc, { recursive: true }); fs.copyFileSync(r.file, path.join(sc, 'smoke.txt')); }
    else if (cmd === 'log') { const sc = path.join(__dirname, 'scratch'); fs.mkdirSync(sc, { recursive: true }); fs.copyFileSync(logFile, path.join(sc, 'snipzo.log')); }
    else if (cmd === 'quit') quit();
  } catch (e) { log('dev command failed', e.message); }
  finally { devBusy = false; }
}

// CI only (SNIPZO_SMOKE=1, run inside the built app): checks the platform pieces that can't be tried in the
// cloud test, prints PASS/FAIL lines and exits 0 only if every required check passed.
async function smoke({ exit = true } = {}) {
  const file = path.join(os.tmpdir(), 'snipzo-smoke.txt'); try { fs.writeFileSync(file, ''); } catch { /* fine */ }
  const say = (line) => { process.stdout.write(line + '\n'); try { fs.appendFileSync(file, line + '\n'); } catch { /* fine */ } }; // Windows GUI apps have no console: CI reads the file
  const res = [], check = (name, ok, detail = '', required = true) => { res.push({ name, ok, required }); say(`SMOKE ${ok ? 'PASS' : required ? 'FAIL' : 'INFO'} ${name}${detail ? ' — ' + detail : ''}`); };
  say(`SMOKE Snipzo ${VERSION} on ${process.platform} ${process.arch}`);
  if (IS_WIN) {
    for (let i = 0; i < 20 && !W32.hookState().installed; i++) await sleep(150);
    const hs = W32.hookState();
    check('keyboard hook runs on its own thread (packaged)', hs.installed && hs.thread, JSON.stringify(hs));
  }
  const ds = screen.getAllDisplays();
  let outs = []; try { outs = PL.outputs(); } catch (e) { check('display list', false, e.message); }
  check('display list from the system', outs.length > 0, JSON.stringify(outs));
  const out = outputFor(screen.getPrimaryDisplay(), outs);
  check('main screen found for recording', !!out, JSON.stringify(out));
  if (IS_MAC) {
    const list = await R.macScreens();
    check('ffmpeg lists the screens (avfoundation)', list.length >= 1, JSON.stringify(list));
    let dev = null; try { dev = await macDevice(out); } catch (e) { check('screen → ffmpeg device', false, e.message); }
    check('screen → ffmpeg device', !!(dev && dev.device != null), JSON.stringify(dev));
    check('Screen Recording permission (CI machines usually lack it)', M.screenAccess() === 'granted', M.screenAccess(), false);
  }
  let wins = null; try { wins = PL.windows(); } catch (e) { check('window list', false, e.message); }
  check('window list works', Array.isArray(wins), wins ? `${wins.length} windows: ${wins.slice(0, 4).map((w) => `${w.title} ${Math.round(w.w)}×${Math.round(w.h)}`).join(', ')}` : '');
  const enc = await R.checkEncoders();
  check('a video encoder works', enc.some((e) => e.ok), enc.map((e) => `${e.id}:${e.ok ? 'ok' : 'no'}`).join(' '));
  if (PL.canCopy && exit) { // not in a live run on someone's PC: it would replace what they copied
    const f = path.join(os.tmpdir(), 'snipzo smoke.mp4'); fs.writeFileSync(f, 'x');
    const c = await PL.copyFile(f), back = c.ok ? await PL.clipboardFile() : null;
    check('file goes on the clipboard and reads back', !!(back && path.resolve(back) === path.resolve(f)), String(back || c.why));
  }
  check('ffmpeg runs', fs.existsSync(R.ffmpegPath()), R.ffmpegPath());
  // the picker page loads and draws
  const o = [...overlays.values()][0];
  for (let i = 0; i < 40 && o && !o.ready; i++) await sleep(250);
  check('pick overlay loads', !!(o && o.ready));
  // a 2 s recording of the main screen through the real flow, when this machine allows screen capture
  if (IS_MAC && M.screenAccess() === 'granted' && out) {
    const d = screen.getPrimaryDisplay(), phys = G.toRecordRect({ x: 40, y: 60, w: 320, h: 200 }, d.scaleFactor, out);
    state = 'picking'; await startRecording(d, out, phys);
    await sleep(2500); await stopRecording('stopped');
    check('a real 2 s snip was saved', !!(doneData && doneData.ok), doneData ? (doneData.ok ? `${doneData.info.video.width}×${doneData.info.video.height}, ${doneData.info.duration.toFixed(1)} s` : doneData.why) : 'no result', false);
  }
  const failed = res.filter((x) => x.required && !x.ok).length;
  say(`SMOKE ${failed ? 'FAILED' : 'OK'} ${res.filter((x) => x.ok).length}/${res.length}`);
  if (exit) app.exit(failed ? 1 : 0);
  return { failed, file };
}

app.whenReady().then(async () => {
  if (!gotLock && !(await takeOverFromOlder())) { app.quit(); return; }
  watchSource();
  W32.setKeyLog((m) => log(m));
  if (IS_MAC && app.dock) app.dock.hide(); // lives in the menu bar, like it lives in the tray on Windows
  loadSettings(); saveSettings();
  log(`Snipzo ${VERSION} starting (${process.platform}${DEV ? ', dev capture' : ''})`);
  // Microphone and system sound for the hidden sound window; nothing else asks
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'display-capture'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });
  tray = new Tray(icon('tray.png'));
  tray.on('click', () => { if (state === 'idle') startPick(); else if (state === 'recording') stopRecording('stopped'); });
  applyHotkey();
  makeAudioWindow();
  rebuildOverlays();
  screen.on('display-added', rebuildOverlays); screen.on('display-removed', rebuildOverlays); screen.on('display-metrics-changed', () => { if (state === 'idle') rebuildOverlays(); });
  announce();
  const firstRun = !fs.existsSync(path.join(app.getPath('userData'), 'seen-welcome'));
  // Started by hand from source (run.vbs): open Settings so it's clear it is running. Not after a code-change restart.
  if (!firstRun && FROM_SOURCE && !process.argv.includes('--relaunched') && !process.env.SNIPZO_TEST) openSettings();
  if (firstRun && !process.env.SNIPZO_TEST) {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'seen-welcome'), '1'); } catch { /* fine */ }
    openSettings();
  }
  R.checkEncoders().then((e) => { if (!encoders) encoders = e; log('encoders', e.map((x) => `${x.id}:${x.ok ? 'ok' : 'no'}`).join(' ')); }).catch(() => {});
  if (process.env.SNIPZO_SMOKE) smoke().catch((e) => { process.stdout.write('SMOKE FAIL crashed ' + e.stack + '\n'); try { fs.appendFileSync(path.join(os.tmpdir(), 'snipzo-smoke.txt'), 'SMOKE FAIL crashed ' + e.stack + '\n'); } catch { /* fine */ } app.exit(1); });
  if (process.env.SNIPZO_TEST) require('./test/drive.js')({ startPick, onHotkey, stopRecording, openSettings, showDone, get state() { return state; }, overlays, log, feed: (buf, frames) => rec && rec.audioChunk(buf, frames, performance.now()), get bar() { return barWin; }, get border() { return borderWin; }, get done() { return doneWin; }, get settingsWin() { return settingsWin; }, get rec() { return rec; }, startKey: (at) => onStartKey(recCtx, at == null ? performance.now() : at, 'Space') });
});
