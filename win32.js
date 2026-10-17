'use strict';
// Snipzo: the Windows calls it needs, through koffi (no native build step).
//  - windows(): every visible window and its inner panels (child windows), top to bottom, in physical pixels.
//    The pick overlay uses this to snap to a window or a panel such as After Effects' viewer.
//  - outputs(): every monitor as DXGI sees it (adapter, output index, desktop rectangle). ffmpeg's ddagrab
//    takes the adapter and output index, so this is how a monitor on screen maps to what ffmpeg records.
//  - copyFile(path) / clipboardFile(): put a file on the clipboard the way Explorer's Ctrl+C does (CF_HDROP),
//    then read it back so the app only says "Copied" when the clipboard really holds the file.
//  - setCaptureHidden(win, on): hide one of our windows from screen capture (WDA_EXCLUDEFROMCAPTURE), or undo it.
//  - keyHook: a low-level keyboard hook for shortcuts Windows keeps for itself (Win+Shift+R belongs to
//    Snipping Tool). It swallows the shortcut so Windows never sees it.
//  - keyWatch: notices taps of a few keys (Space, Numpad 0) while a "Start on Space" snip is armed, and lets
//    every key through untouched, so After Effects still gets its Space and starts the preview.
//  - focusWindow(hwnd): hands the keyboard back to the app that was picked (so its Space works right away).
// On other systems every call returns an empty or "not supported" answer, so the app can be developed on Linux.

const IS_WIN = process.platform === 'win32';
const { performance } = require('perf_hooks');
let K = null; // bound functions, created on first use

function bind() {
  if (K) return K;
  if (!IS_WIN) return (K = {});
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const shell32 = koffi.load('shell32.dll');
  const dxgi = koffi.load('dxgi.dll');

  const RECT = koffi.struct('SNZ_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const OUTPUT_DESC = koffi.struct('SNZ_DXGI_OUTPUT_DESC', {
    DeviceName: koffi.array('char16_t', 32, 'String'),
    DesktopCoordinates: RECT,
    AttachedToDesktop: 'int',
    Rotation: 'int',
    Monitor: 'intptr_t',
  });
  const KBD = koffi.struct('SNZ_KBDLLHOOKSTRUCT', { vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' });
  const EnumProc = koffi.proto('bool __stdcall SnzEnumProc(intptr_t hwnd, intptr_t lp)');
  const HookProc = koffi.proto('intptr_t __stdcall SnzHookProc(int code, uintptr_t wParam, void *lParam)');

  K = {
    koffi, RECT, OUTPUT_DESC, KBD, HookProc,
    EnumWindows: user32.func('bool __stdcall EnumWindows(SnzEnumProc *cb, intptr_t lp)'),
    EnumChildWindows: user32.func('bool __stdcall EnumChildWindows(intptr_t parent, SnzEnumProc *cb, intptr_t lp)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ SNZ_RECT *r)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buf, int n)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, void *buf, int n)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
    GetParent: user32.func('intptr_t __stdcall GetParent(intptr_t hwnd)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
    SetWindowDisplayAffinity: user32.func('bool __stdcall SetWindowDisplayAffinity(intptr_t hwnd, uint32_t affinity)'),
    OpenClipboard: user32.func('bool __stdcall OpenClipboard(intptr_t owner)'),
    CloseClipboard: user32.func('bool __stdcall CloseClipboard()'),
    EmptyClipboard: user32.func('bool __stdcall EmptyClipboard()'),
    SetClipboardData: user32.func('intptr_t __stdcall SetClipboardData(uint32_t format, intptr_t mem)'),
    GetClipboardData: user32.func('intptr_t __stdcall GetClipboardData(uint32_t format)'),
    RegisterClipboardFormatW: user32.func('uint32_t __stdcall RegisterClipboardFormatW(const char16_t *name)'),
    SetWindowsHookExW: user32.func('intptr_t __stdcall SetWindowsHookExW(int id, SnzHookProc *fn, intptr_t mod, uint32_t thread)'),
    UnhookWindowsHookEx: user32.func('bool __stdcall UnhookWindowsHookEx(intptr_t hook)'),
    CallNextHookEx: user32.func('intptr_t __stdcall CallNextHookEx(intptr_t hook, int code, uintptr_t wParam, void *lParam)'),
    GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)'),
    GetTickCount: kernel32.func('uint32_t __stdcall GetTickCount()'),
    SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t n, const void *inputs, int size)'),
    GlobalAlloc: kernel32.func('intptr_t __stdcall GlobalAlloc(uint32_t flags, size_t bytes)'),
    GlobalLock: kernel32.func('intptr_t __stdcall GlobalLock(intptr_t mem)'),
    GlobalUnlock: kernel32.func('bool __stdcall GlobalUnlock(intptr_t mem)'),
    GlobalFree: kernel32.func('intptr_t __stdcall GlobalFree(intptr_t mem)'),
    RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(intptr_t dst, const void *src, size_t n)'),
    GetModuleHandleW: kernel32.func('intptr_t __stdcall GetModuleHandleW(const char16_t *name)'),
    DwmGetWindowAttribute: dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, void *out, uint32_t size)'),
    DragQueryFileW: shell32.func('uint32_t __stdcall DragQueryFileW(intptr_t drop, uint32_t i, void *buf, uint32_t n)'),
    CreateDXGIFactory1: dxgi.func('long __stdcall CreateDXGIFactory1(const void *riid, _Out_ void **factory)'),
    // COM methods are called through the object's vtable
    P_Release: koffi.proto('uint32_t __stdcall SnzRelease(void *self)'),
    P_EnumAdapters1: koffi.proto('long __stdcall SnzEnumAdapters1(void *self, uint32_t i, _Out_ void **out)'),
    P_EnumOutputs: koffi.proto('long __stdcall SnzEnumOutputs(void *self, uint32_t i, _Out_ void **out)'),
    P_OutputGetDesc: koffi.proto('long __stdcall SnzOutputGetDesc(void *self, _Out_ SNZ_DXGI_OUTPUT_DESC *d)'),
  };
  return K;
}

const supported = () => IS_WIN;

function wstr(buf, n) { return buf.toString('utf16le', 0, Math.max(0, n) * 2); }
function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

// ---------- windows and panels ----------
const WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000;
const GWL_EXSTYLE = -20, DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
const SKIP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'NotifyIconOverflowWindow']);
const MIN_PART = 40; // physical px: smaller inner windows are buttons and scrollbars, not useful to record

function frameOf(k, hwnd) {
  const buf = Buffer.alloc(16);
  if (k.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0) {
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4), w: buf.readInt32LE(8) - buf.readInt32LE(0), h: buf.readInt32LE(12) - buf.readInt32LE(4) };
  }
  const r = {}; if (!k.GetWindowRect(hwnd, r)) return null;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}
function clip(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

// [{ id, hwnd, title, cls, z, x, y, w, h, parts: [{ id, hwnd, cls, depth, x, y, w, h }] }], topmost first.
function windows({ skipPid = process.pid, maxParts = 2500 } = {}) {
  if (!IS_WIN) return [];
  const k = bind();
  const tops = [];
  const tbuf = Buffer.alloc(512), cbuf = Buffer.alloc(256), cloak = Buffer.alloc(4);
  k.EnumWindows((hwnd) => {
    try {
      if (!k.IsWindowVisible(hwnd) || k.IsIconic(hwnd)) return true;
      const pid = [0]; k.GetWindowThreadProcessId(hwnd, pid);
      if (pid[0] === skipPid) return true;
      const cls = wstr(cbuf, k.GetClassNameW(hwnd, cbuf, 128));
      if (SKIP_CLASSES.has(cls)) return true;
      const ex = Number(k.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      if (ex & WS_EX_TRANSPARENT) return true; // click-through overlays (game/GPU overlays) cover the screen invisibly
      if (k.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloak, 4) === 0 && cloak.readUInt32LE(0) !== 0) return true;
      const title = wstr(tbuf, k.GetWindowTextW(hwnd, tbuf, 256));
      if (!title && (ex & WS_EX_LAYERED) && (ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE))) return true;
      const f = frameOf(k, hwnd);
      if (!f || f.w < 20 || f.h < 20) return true;
      tops.push({ id: 'w' + hwnd, hwnd, title, cls, z: tops.length, ...f, parts: [] });
    } catch { /* one odd window never stops the list */ }
    return true;
  }, 0);

  let total = 0;
  for (const t of tops) {
    if (total >= maxParts) break;
    const depthOf = new Map([[t.hwnd, 0]]);
    k.EnumChildWindows(t.hwnd, (hwnd) => {
      try {
        if (total >= maxParts) return false;
        if (!k.IsWindowVisible(hwnd)) return true;
        const r = {}; if (!k.GetWindowRect(hwnd, r)) return true;
        const c = clip({ x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }, t);
        if (!c || c.w < MIN_PART || c.h < MIN_PART) return true;
        if (c.w >= t.w - 2 && c.h >= t.h - 2) return true; // a client area the size of the window adds nothing
        const parent = Number(k.GetParent(hwnd));
        const depth = (depthOf.get(parent) ?? 0) + 1; depthOf.set(hwnd, depth);
        const cls = wstr(cbuf, k.GetClassNameW(hwnd, cbuf, 128));
        t.parts.push({ id: 'p' + hwnd, hwnd, cls, depth, ...c }); total++;
      } catch { /* skip */ }
      return true;
    }, 0);
  }
  return tops;
}

// ---------- monitors as DXGI (and so ffmpeg's ddagrab) numbers them ----------
const IID_IDXGIFactory1 = (() => {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x770aae78, 0); b.writeUInt16LE(0xf26f, 4); b.writeUInt16LE(0x4dba, 6);
  Buffer.from([0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]).copy(b, 8);
  return b;
})();
function vcall(k, obj, index, proto, ...args) {
  const vtbl = k.koffi.decode(obj, 'void *');
  const fn = k.koffi.decode(vtbl, index * 8, 'void *');
  return k.koffi.call(fn, proto, obj, ...args);
}
// [{ adapter, output, name, x, y, w, h }] in physical desktop pixels
function outputs() {
  if (!IS_WIN) return [];
  const k = bind();
  const list = [];
  const fac = [null];
  if (k.CreateDXGIFactory1(IID_IDXGIFactory1, fac) < 0 || !fac[0]) return list;
  try {
    for (let a = 0; a < 16; a++) {
      const ad = [null];
      if (vcall(k, fac[0], 12, k.P_EnumAdapters1, a, ad) < 0 || !ad[0]) break; // IDXGIFactory1::EnumAdapters1
      try {
        for (let o = 0; o < 16; o++) {
          const out = [null];
          if (vcall(k, ad[0], 7, k.P_EnumOutputs, o, out) < 0 || !out[0]) break; // IDXGIAdapter::EnumOutputs
          try {
            const d = {};
            if (vcall(k, out[0], 7, k.P_OutputGetDesc, d) >= 0 && d.AttachedToDesktop) { // IDXGIOutput::GetDesc
              const r = d.DesktopCoordinates;
              list.push({ adapter: a, output: o, name: d.DeviceName, x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top, rotation: d.Rotation });
            }
          } finally { vcall(k, out[0], 2, k.P_Release); }
        }
      } finally { vcall(k, ad[0], 2, k.P_Release); }
    }
  } finally { vcall(k, fac[0], 2, k.P_Release); }
  return list;
}

// ---------- hide our own windows from capture ----------
// Only ever used on a window that sits over the area being recorded, and only while it does. ShadowPlay
// switches itself off while any window carries this flag, and Discord's screen share can go black over it,
// so it is never left on a window that is merely kept around.
const WDA_NONE = 0x0, WDA_EXCLUDEFROMCAPTURE = 0x11;
function setCaptureHidden(win, on) {
  if (!IS_WIN) return false;
  try { return !!bind().SetWindowDisplayAffinity(hwndOf(win), on ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE); } catch { return false; }
}

// ---------- clipboard: a file, as Explorer copies it ----------
const CF_HDROP = 15, GMEM_MOVEABLE = 0x2, GMEM_ZEROINIT = 0x40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openClipboard(k) {
  for (let i = 0; i < 20; i++) { if (k.OpenClipboard(0)) return true; await sleep(50); } // another app may hold it briefly
  return false;
}
function globalWith(k, buf) {
  const h = k.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, buf.length);
  if (!h) throw new Error('out of memory');
  const p = k.GlobalLock(h); if (!p) { k.GlobalFree(h); throw new Error('could not lock memory'); }
  k.RtlMoveMemory(p, buf, buf.length); k.GlobalUnlock(h);
  return h;
}
// Returns { ok, why }
async function copyFile(file) {
  if (!IS_WIN) return { ok: false, why: 'only on Windows' };
  const k = bind();
  const head = Buffer.alloc(20); head.writeUInt32LE(20, 0); head.writeUInt32LE(1, 16); // DROPFILES: pFiles=20, fWide=1
  const drop = Buffer.concat([head, Buffer.from(file + '\0\0', 'utf16le')]);
  const effect = Buffer.alloc(4); effect.writeUInt32LE(1, 0); // DROPEFFECT_COPY
  if (!(await openClipboard(k))) return { ok: false, why: 'another app is holding the clipboard' };
  try {
    if (!k.EmptyClipboard()) return { ok: false, why: 'the clipboard could not be cleared' };
    const h = globalWith(k, drop);
    if (!k.SetClipboardData(CF_HDROP, h)) { k.GlobalFree(h); return { ok: false, why: 'Windows refused the file' }; }
    const fmt = k.RegisterClipboardFormatW('Preferred DropEffect');
    if (fmt) { const e = globalWith(k, effect); if (!k.SetClipboardData(fmt, e)) k.GlobalFree(e); }
  } finally { k.CloseClipboard(); }
  return { ok: true };
}
// The first file on the clipboard, or null
async function clipboardFile() {
  if (!IS_WIN) return null;
  const k = bind();
  if (!(await openClipboard(k))) return null;
  try {
    const h = k.GetClipboardData(CF_HDROP); if (!h) return null;
    const buf = Buffer.alloc(2 * 2048);
    const n = k.DragQueryFileW(h, 0, buf, 2048);
    return n ? wstr(buf, n) : null;
  } finally { k.CloseClipboard(); }
}

// ---------- low-level keyboard hook ----------
const WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
const LLKHF_INJECTED = 0x10, MARK = 0x534E5A; // 'SNZ' in dwExtraInfo: our own injected key
const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, LWIN: 0x5B, RWIN: 0x5C, DUMMY: 0xFF };

// "Super+Shift+R" -> { win, ctrl, alt, shift, vk }
function parseAccelerator(acc) {
  const parts = String(acc || '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const want = { win: false, ctrl: false, alt: false, shift: false, vk: 0 };
  for (const p of parts) {
    if (p === 'super' || p === 'meta' || p === 'win' || p === 'cmd' || p === 'command') want.win = true;
    else if (p === 'ctrl' || p === 'control' || p === 'cmdorctrl' || p === 'commandorcontrol') want.ctrl = true;
    else if (p === 'alt' || p === 'option') want.alt = true;
    else if (p === 'shift') want.shift = true;
    else if (/^[a-z0-9]$/.test(p)) want.vk = p.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) want.vk = 0x6F + Number(p.slice(1));
    else if (p === 'printscreen') want.vk = 0x2C;
    else if (p === 'space') want.vk = 0x20;
    else return null;
  }
  return want.vk ? want : null;
}

const mainKeyHook = { // fallback only: used when the hook thread can't start (see keyworker.js)
  handle: 0, cb: null, want: null, onFire: null, swallowUp: false, refresh: null,
  // Install (or re-install) the hook for accelerator `acc`. Returns true when Windows accepted it.
  start(acc, onFire) {
    if (!IS_WIN) return false;
    const k = bind();
    this.stop();
    this.want = parseAccelerator(acc); this.onFire = onFire;
    if (!this.want) return false;
    if (!this.cb) this.cb = k.koffi.register((code, wParam, lParam) => this._proc(code, wParam, lParam), k.koffi.pointer(k.HookProc));
    this.handle = k.SetWindowsHookExW(WH_KEYBOARD_LL, this.cb, k.GetModuleHandleW(null), 0);
    // Windows silently drops a hook that ever answers too slowly; putting it back now and then keeps it alive.
    if (this.handle && !this.refresh) this.refresh = setInterval(() => { if (this.handle && this.want) { const kk = bind(); kk.UnhookWindowsHookEx(this.handle); this.handle = kk.SetWindowsHookExW(WH_KEYBOARD_LL, this.cb, kk.GetModuleHandleW(null), 0); } }, 60000);
    return !!this.handle;
  },
  stop() {
    if (this.refresh) { clearInterval(this.refresh); this.refresh = null; }
    if (this.handle) { bind().UnhookWindowsHookEx(this.handle); this.handle = 0; }
  },
  _down(vk) { return (bind().GetAsyncKeyState(vk) & 0x8000) !== 0; },
  _dummy() { // a key nobody uses, so releasing Win afterwards doesn't open the Start menu
    const k = bind();
    const b = Buffer.alloc(80);
    for (let i = 0; i < 2; i++) { const o = i * 40; b.writeUInt32LE(1, o); b.writeUInt16LE(VK.DUMMY, o + 8); b.writeUInt32LE(i ? 2 : 0, o + 12); b.writeBigUInt64LE(BigInt(MARK), o + 24); }
    k.SendInput(2, b, 40);
  },
  _proc(code, wParam, lParam) {
    const k = bind();
    wParam = Number(wParam);
    try {
      if (code === 0 && this.want) {
        const ev = k.koffi.decode(lParam, k.KBD);
        const injected = (ev.flags & LLKHF_INJECTED) && Number(ev.dwExtraInfo) === MARK;
        if (!injected && ev.vkCode === this.want.vk) {
          const isDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN;
          const isUp = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;
          if (isUp && this.swallowUp) { this.swallowUp = false; return 1; }
          if (isDown) {
            const w = this.want;
            const win = this._down(VK.LWIN) || this._down(VK.RWIN);
            if (win === w.win && this._down(VK.CONTROL) === w.ctrl && this._down(VK.MENU) === w.alt && this._down(VK.SHIFT) === w.shift) {
              if (!this.swallowUp) { // first press, not a key repeat
                if (w.win || w.alt) this._dummy();
                setImmediate(() => { try { this.onFire && this.onFire(); } catch { /* ignore */ } });
              }
              this.swallowUp = true;
              return 1; // Windows (and Snipping Tool) never see it
            }
          }
        }
      }
    } catch { /* never break the keyboard */ }
    return k.CallNextHookEx(0, code, wParam, lParam);
  },
};

// ---------- watching for a key tap, without taking it ----------
// start(vks, onTap): onTap({ vk, downAt, upAt }) after a key in `vks` is pressed and let go within `tapMs`
// (holding Space is After Effects' hand tool, so a long hold is not a tap). downAt/upAt are performance.now()
// times of the real key events (from the event's own timestamp, not from when Node got round to it).
// Every key always goes on to the app; nothing is swallowed. Installed only while a snip is armed or recording.
const mainKeyWatch = { // fallback only, like mainKeyHook
  handle: 0, cb: null, vks: null, onTap: null, down: new Map(), tapMs: 500, refresh: null,
  start(vks, onTap, { tapMs = 500 } = {}) {
    if (!IS_WIN) return false;
    const k = bind();
    this.stop();
    this.vks = new Set(vks); this.onTap = onTap; this.tapMs = tapMs; this.down = new Map();
    if (!this.cb) this.cb = k.koffi.register((code, wParam, lParam) => this._proc(code, wParam, lParam), k.koffi.pointer(k.HookProc));
    this.handle = k.SetWindowsHookExW(WH_KEYBOARD_LL, this.cb, k.GetModuleHandleW(null), 0);
    if (this.handle && !this.refresh) this.refresh = setInterval(() => { if (this.handle) { const kk = bind(); kk.UnhookWindowsHookEx(this.handle); this.handle = kk.SetWindowsHookExW(WH_KEYBOARD_LL, this.cb, kk.GetModuleHandleW(null), 0); } }, 60000);
    return !!this.handle;
  },
  stop() {
    if (this.refresh) { clearInterval(this.refresh); this.refresh = null; }
    if (this.handle) { bind().UnhookWindowsHookEx(this.handle); this.handle = 0; }
    this.vks = null; this.onTap = null; this.down = new Map();
  },
  _proc(code, wParam, lParam) {
    const k = bind();
    wParam = Number(wParam);
    try {
      if (code === 0 && this.vks) {
        const ev = k.koffi.decode(lParam, k.KBD);
        const injected = (ev.flags & LLKHF_INJECTED) && Number(ev.dwExtraInfo) === MARK;
        if (!injected && this.vks.has(ev.vkCode)) {
          const lag = (k.GetTickCount() - ev.time) >>> 0; // how long ago the key really moved
          const at = performance.now() - (lag < 2000 ? lag : 0);
          const isDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN, isUp = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;
          if (isDown && !this.down.has(ev.vkCode)) this.down.set(ev.vkCode, at); // the first down, not the key repeats
          else if (isUp && this.down.has(ev.vkCode)) {
            const downAt = this.down.get(ev.vkCode); this.down.delete(ev.vkCode);
            if (at - downAt <= this.tapMs) { const vk = ev.vkCode, cb = this.onTap; setImmediate(() => { try { cb && cb({ vk, downAt, upAt: at }); } catch { /* ignore */ } }); }
          }
        }
      }
    } catch { /* never break the keyboard */ }
    return k.CallNextHookEx(0, code, wParam, lParam); // always passed on
  },
};
const VK_SPACE = 0x20, VK_NUMPAD0 = 0x60;

// ---------- give the keyboard back to a window ----------
// Called right after our pick overlay (which had the keyboard) goes away, so Windows lets us do it.
function focusWindow(hwnd) {
  if (!IS_WIN || !hwnd) return false;
  try {
    const k = bind();
    const root = Number(k.GetAncestor(hwnd, 2)) || hwnd; // GA_ROOT
    if (Number(k.GetForegroundWindow()) === root) return true;
    return !!k.SetForegroundWindow(root) && Number(k.GetForegroundWindow()) === root;
  } catch { return false; }
}

// ---------- the hook thread (keyworker.js) ----------
// The shortcut and the Space watcher run in one hook on their own thread, so a busy main thread can never make
// Windows drop the hook. If that thread can't start, the old main-thread hooks above take over.
const CTL = { GEN: 0, QUIT: 1, HOOK: 2, VK: 3, MODS: 4, WATCH: 5, WVK1: 6, WVK2: 7, TAPMS: 8 };
const HK = {
  worker: null, ctl: null, failed: false, onFire: null, onTap: null, installed: false, why: '', log: () => {},
  ensure() {
    if (this.worker) return true;
    if (this.failed || !IS_WIN) return false;
    try {
      const { Worker } = require('worker_threads');
      const path = require('path');
      const file = path.join(__dirname, 'keyworker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      this.ctl = new Int32Array(new SharedArrayBuffer(16 * 4));
      this.worker = new Worker(file, { workerData: { sab: this.ctl.buffer } });
      this.worker.on('message', (m) => this._msg(m));
      this.worker.on('error', (e) => this._fail('hook thread error: ' + (e && e.message)));
      this.worker.on('exit', (code) => { if (this.worker && !this.quitting) this._fail('hook thread ended (' + code + ')'); });
      return true;
    } catch (e) { this._fail('hook thread could not start: ' + e.message); return false; }
  },
  _msg(m) {
    if (!m) return;
    if (m.t === 'fire') { try { this.onFire && this.onFire(); } catch { /* ignore */ } }
    else if (m.t === 'tap') { const t0 = performance.timeOrigin; try { this.onTap && this.onTap({ vk: m.vk, downAt: m.downAt - t0, upAt: m.upAt - t0 }); } catch { /* ignore */ } }
    else if (m.t === 'state') {
      if (m.fatal) return this._fail(m.why);
      if (!m.ready) {
        this.installed = !!m.installed; this.why = m.why || '';
        this.log(`hook thread: ${m.installed ? 'hook installed' : 'no hook'}${m.why ? ' (' + m.why + ')' : ''}`);
        if (!m.installed && m.why) this._fail('hook thread: ' + m.why); // Windows refused it there: try on the main thread
      }
    }
  },
  _fail(why) {
    this.log(why + '; using the main-thread hook instead');
    const w = this.worker; this.worker = null; this.failed = true;
    try { w && w.terminate(); } catch { /* gone */ }
    // carry on with the fallback, same settings
    if (this.acc) mainKeyHook.start(this.acc, this.onFire);
    if (this.vks) mainKeyWatch.start(this.vks, this.onTap, { tapMs: this.tapMs });
  },
  push() { Atomics.add(this.ctl, CTL.GEN, 1); },
};
const keyHook = {
  // Returns true when the hook is (being) put in place. A failure on the thread falls back by itself.
  start(acc, onFire) {
    if (!IS_WIN) return false;
    const want = parseAccelerator(acc); if (!want) return false;
    HK.acc = acc; HK.onFire = onFire;
    if (!HK.ensure()) return mainKeyHook.start(acc, onFire);
    const c = HK.ctl;
    c[CTL.VK] = want.vk; c[CTL.MODS] = (want.win ? 1 : 0) | (want.ctrl ? 2 : 0) | (want.alt ? 4 : 0) | (want.shift ? 8 : 0); c[CTL.HOOK] = 1;
    HK.push();
    return true;
  },
  stop() {
    HK.acc = null;
    if (HK.worker) { HK.ctl[CTL.HOOK] = 0; HK.push(); }
    mainKeyHook.stop();
  },
};
const keyWatch = {
  start(vks, onTap, { tapMs = 500 } = {}) {
    if (!IS_WIN) return false;
    HK.vks = vks; HK.onTap = onTap; HK.tapMs = tapMs;
    if (!HK.ensure()) return mainKeyWatch.start(vks, onTap, { tapMs });
    const c = HK.ctl;
    c[CTL.WVK1] = vks[0] || 0; c[CTL.WVK2] = vks[1] || 0; c[CTL.TAPMS] = tapMs; c[CTL.WATCH] = 1;
    HK.push();
    return true;
  },
  stop() {
    HK.vks = null; HK.onTap = null;
    if (HK.worker) { HK.ctl[CTL.WATCH] = 0; HK.push(); }
    mainKeyWatch.stop();
  },
};
function setKeyLog(fn) { HK.log = fn; }
function hookState() { return HK.worker ? { thread: true, installed: HK.installed, why: HK.why } : { thread: false, installed: !!mainKeyHook.handle, failed: HK.failed }; }
function quitKeys() { HK.quitting = true; if (HK.worker) { Atomics.store(HK.ctl, CTL.QUIT, 1); } mainKeyHook.stop(); mainKeyWatch.stop(); }

module.exports = { setKeyLog, hookState, quitKeys, supported, windows, outputs, setCaptureHidden, copyFile, clipboardFile, keyHook, keyWatch, focusWindow, VK_SPACE, VK_NUMPAD0, parseAccelerator, hwndOf };
