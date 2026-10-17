'use strict';
// Snipzo on macOS: the same calls win32.js offers, done the Mac way.
//  - windows(): every normal on-screen window (CGWindowListCopyWindowInfo), top to bottom, in points
//    (= Electron DIPs, global, top-left origin). Mac apps don't make child windows for their panels, so
//    `parts` is empty: After Effects' comp frame is found from the picture (content snapping) instead.
//  - displays(): CGGetActiveDisplayList, the same list and order ffmpeg's avfoundation numbers its
//    "Capture screen N" devices by. An Electron display's id is its CGDirectDisplayID, so the screen to
//    record is the index of display.id in this list.
//  - copyFile(path) / clipboardFile(): the file on the clipboard as a file URL (Finder's Copy), read back.
//  - Screen Recording permission: status + opening the right System Settings page.
// The keyboard hook, Start on Space and handing the keyboard back are Windows-only for now (macOS needs
// Accessibility permission to watch keys); the UI says so instead of pretending.
const IS_MAC = process.platform === 'darwin';
let K = null;

function bind() {
  if (K) return K;
  if (!IS_MAC) return (K = {});
  const koffi = require('koffi');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const CGRect = koffi.struct('SNZ_CGRect', { x: 'double', y: 'double', w: 'double', h: 'double' });
  K = {
    koffi, CGRect,
    CGWindowListCopyWindowInfo: cg.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)'),
    CGRectMakeWithDictionaryRepresentation: cg.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ SNZ_CGRect *rect)'),
    CGGetActiveDisplayList: cg.func('int32_t CGGetActiveDisplayList(uint32_t max, uint32_t *displays, uint32_t *count)'),
    CGDisplayPixelsWide: cg.func('size_t CGDisplayPixelsWide(uint32_t display)'),
    CGDisplayPixelsHigh: cg.func('size_t CGDisplayPixelsHigh(uint32_t display)'),
    CGPreflightScreenCaptureAccess: (() => { try { return cg.func('bool CGPreflightScreenCaptureAccess()'); } catch { return null; } })(),
    CGRequestScreenCaptureAccess: (() => { try { return cg.func('bool CGRequestScreenCaptureAccess()'); } catch { return null; } })(),
    CFArrayGetCount: cf.func('long CFArrayGetCount(void *arr)'),
    CFArrayGetValueAtIndex: cf.func('void *CFArrayGetValueAtIndex(void *arr, long i)'),
    CFDictionaryGetValue: cf.func('void *CFDictionaryGetValue(void *dict, void *key)'),
    CFNumberGetValue: cf.func('bool CFNumberGetValue(void *num, long type, double *out)'),
    CFStringCreateWithCString: cf.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32_t enc)'),
    CFStringGetCString: cf.func('bool CFStringGetCString(void *s, uint8_t *buf, long size, uint32_t enc)'),
    CFRelease: cf.func('void CFRelease(void *ref)'),
  };
  const UTF8 = 0x08000100;
  // The kCGWindow* keys are CFStrings whose text is their own name
  K.key = {};
  for (const n of ['kCGWindowBounds', 'kCGWindowLayer', 'kCGWindowOwnerPID', 'kCGWindowOwnerName', 'kCGWindowName', 'kCGWindowNumber', 'kCGWindowAlpha']) K.key[n] = K.CFStringCreateWithCString(null, n, UTF8);
  K.UTF8 = UTF8;
  return K;
}

const supported = () => IS_MAC;

function cfString(k, ref) {
  if (!ref) return '';
  const buf = Buffer.alloc(1024);
  return k.CFStringGetCString(ref, buf, buf.length, k.UTF8) ? buf.toString('utf8', 0, Math.max(0, buf.indexOf(0))) : '';
}
function cfNumber(k, ref) {
  if (!ref) return null;
  const out = new Float64Array(1); // typed arrays are passed by reference: the call fills them
  return k.CFNumberGetValue(ref, 13 /* kCFNumberDoubleType */, out) ? out[0] : null;
}

// [{ id, hwnd: null, title, cls, pid, z, x, y, w, h, parts: [] }] in points, topmost first
function windows({ skipPid = process.pid } = {}) {
  if (!IS_MAC) return [];
  const k = bind();
  const ON_SCREEN = 1, EXCLUDE_DESKTOP = 16;
  const arr = k.CGWindowListCopyWindowInfo(ON_SCREEN | EXCLUDE_DESKTOP, 0);
  if (!arr) return [];
  const out = [];
  try {
    const n = k.CFArrayGetCount(arr);
    for (let i = 0; i < n; i++) {
      try {
        const d = k.CFArrayGetValueAtIndex(arr, i);
        if (cfNumber(k, k.CFDictionaryGetValue(d, k.key.kCGWindowLayer)) !== 0) continue; // menu bar, Dock, overlays
        const pid = cfNumber(k, k.CFDictionaryGetValue(d, k.key.kCGWindowOwnerPID));
        if (pid === skipPid) continue;
        const alpha = cfNumber(k, k.CFDictionaryGetValue(d, k.key.kCGWindowAlpha));
        if (alpha != null && alpha < 0.05) continue;
        const r = {};
        if (!k.CGRectMakeWithDictionaryRepresentation(k.CFDictionaryGetValue(d, k.key.kCGWindowBounds), r)) continue;
        if (r.w < 20 || r.h < 20) continue;
        const owner = cfString(k, k.CFDictionaryGetValue(d, k.key.kCGWindowOwnerName));
        const name = cfString(k, k.CFDictionaryGetValue(d, k.key.kCGWindowName)); // empty without Screen Recording permission
        const num = cfNumber(k, k.CFDictionaryGetValue(d, k.key.kCGWindowNumber));
        out.push({ id: 'm' + num, hwnd: null, title: name ? `${owner} - ${name}` : owner, cls: owner, pid, z: out.length, x: r.x, y: r.y, w: r.w, h: r.h, parts: [], dip: true });
      } catch { /* one odd window never stops the list */ }
    }
  } finally { k.CFRelease(arr); }
  return out;
}

// [{ id, index, pw, ph }]: active displays in avfoundation's order, with their current pixel size
function displays() {
  if (!IS_MAC) return [];
  const k = bind();
  const ids = new Uint32Array(16), count = new Uint32Array(1);
  if (k.CGGetActiveDisplayList(16, ids, count) !== 0) return [];
  return [...ids.slice(0, count[0])].map((id, index) => ({ id, index, pw: Number(k.CGDisplayPixelsWide(id)), ph: Number(k.CGDisplayPixelsHigh(id)) }));
}

// Screen Recording permission: 'granted' | 'denied' | 'not-determined' (Electron's answer, CG's as a check)
function screenAccess() {
  if (!IS_MAC) return 'granted';
  let st = 'not-determined';
  try { st = require('electron').systemPreferences.getMediaAccessStatus('screen'); } catch { /* older */ }
  try { const k = bind(); if (k.CGPreflightScreenCaptureAccess && k.CGPreflightScreenCaptureAccess()) st = 'granted'; } catch { /* fine */ }
  return st;
}
function requestScreenAccess() { try { const k = bind(); return !!(k.CGRequestScreenCaptureAccess && k.CGRequestScreenCaptureAccess()); } catch { return false; } }
function openScreenSettings() { require('electron').shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); }

// ---------- clipboard: a file, as Finder copies it ----------
async function copyFile(file) {
  if (!IS_MAC) return { ok: false, why: 'only on macOS' };
  try {
    const { clipboard } = require('electron');
    const url = require('url').pathToFileURL(file).href;
    clipboard.clear();
    clipboard.writeBuffer('public.file-url', Buffer.from(url, 'utf8'));
    return { ok: true };
  } catch (e) { return { ok: false, why: e.message }; }
}
async function clipboardFile() {
  if (!IS_MAC) return null;
  try {
    const { clipboard } = require('electron');
    const u = clipboard.readBuffer('public.file-url').toString('utf8').replace(/\0+$/, '');
    return u ? require('url').fileURLToPath(u) : null;
  } catch { return null; }
}

module.exports = { supported, windows, displays, screenAccess, requestScreenAccess, openScreenSettings, copyFile, clipboardFile };
