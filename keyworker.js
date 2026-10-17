'use strict';
// Snipzo's keyboard hook, on its own thread.
//
// Why a thread: Windows silently removes a low-level keyboard hook whose thread doesn't answer in time
// (LowLevelHooksTimeout). On the main thread the hook had to wait whenever the app was busy, and the app is
// busiest right when the picker opens (window list, screen images). Pressing Esc in that moment made Windows
// drop the hook, and the shortcut stopped working (Crofty, 17 Oct). Here the hook answers at once, whatever
// the main thread is doing, and tells the main thread afterwards.
//
// The main thread writes what to do into a shared Int32Array (see CTL below) and bumps GEN; this thread reads it
// between messages. Events go back with postMessage:
//   { t: 'fire' }                                  the shortcut was pressed (and swallowed)
//   { t: 'tap', vk, downAt, upAt }                 a watched key was tapped (epoch ms; never swallowed)
//   { t: 'state', installed, why }                 the hook was (re)installed or failed
const { parentPort, workerData } = require('worker_threads');
const { performance } = require('perf_hooks');

const CTL = { GEN: 0, QUIT: 1, HOOK: 2, VK: 3, MODS: 4, WATCH: 5, WVK1: 6, WVK2: 7, TAPMS: 8 };
const ctl = new Int32Array(workerData.sab);

let K;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
  const KBD = koffi.struct('SNZW_KBDLLHOOKSTRUCT', { vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' });
  const HookProc = koffi.proto('intptr_t __stdcall SnzwHookProc(int code, uintptr_t wParam, void *lParam)');
  K = {
    koffi, KBD, HookProc,
    SetWindowsHookExW: user32.func('intptr_t __stdcall SetWindowsHookExW(int id, SnzwHookProc *fn, intptr_t mod, uint32_t thread)'),
    UnhookWindowsHookEx: user32.func('bool __stdcall UnhookWindowsHookEx(intptr_t hook)'),
    CallNextHookEx: user32.func('intptr_t __stdcall CallNextHookEx(intptr_t hook, int code, uintptr_t wParam, void *lParam)'),
    GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
    SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t n, const void *inputs, int size)'),
    PeekMessageW: user32.func('bool __stdcall PeekMessageW(void *msg, intptr_t hwnd, uint32_t min, uint32_t max, uint32_t remove)'),
    MsgWaitForMultipleObjects: user32.func('uint32_t __stdcall MsgWaitForMultipleObjects(uint32_t n, void *handles, bool waitAll, uint32_t ms, uint32_t mask)'),
    GetModuleHandleW: kernel32.func('intptr_t __stdcall GetModuleHandleW(const char16_t *name)'),
    GetTickCount: kernel32.func('uint32_t __stdcall GetTickCount()'),
  };
} catch (e) {
  parentPort.postMessage({ t: 'state', installed: false, why: 'koffi: ' + e.message, fatal: true });
  return; // eslint-disable-line no-unsafe-finally
}

const WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
const LLKHF_INJECTED = 0x10, MARK = 0x534E5A; // 'SNZ' in dwExtraInfo: our own injected key
const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, LWIN: 0x5B, RWIN: 0x5C, DUMMY: 0xFF };
const PM_REMOVE = 1, QS_ALLINPUT = 0x04FF;

let cfg = { hook: false, vk: 0, mods: 0, watch: false, vks: new Set(), tapMs: 500 };
let handle = 0, installedAt = 0, swallowUp = false;
const down = new Map();
const epoch = (at) => performance.timeOrigin + at;
const isDown = (vk) => (K.GetAsyncKeyState(vk) & 0x8000) !== 0;

function dummy() { // a key nobody uses, so releasing Win afterwards doesn't open the Start menu
  const b = Buffer.alloc(80);
  for (let i = 0; i < 2; i++) { const o = i * 40; b.writeUInt32LE(1, o); b.writeUInt16LE(VK.DUMMY, o + 8); b.writeUInt32LE(i ? 2 : 0, o + 12); b.writeBigUInt64LE(BigInt(MARK), o + 24); }
  K.SendInput(2, b, 40);
}

function proc(code, wParam, lParam) {
  wParam = Number(wParam);
  try {
    if (code === 0) {
      const ev = K.koffi.decode(lParam, K.KBD);
      const injected = (ev.flags & LLKHF_INJECTED) && Number(ev.dwExtraInfo) === MARK;
      const dn = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN, up = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;
      if (!injected) {
        // 1. the shortcut: swallowed so Windows (Snipping Tool) never sees it
        if (cfg.hook && ev.vkCode === cfg.vk) {
          if (up && swallowUp) { swallowUp = false; return 1; }
          if (dn) {
            const m = cfg.mods, win = isDown(VK.LWIN) || isDown(VK.RWIN);
            if (win === !!(m & 1) && isDown(VK.CONTROL) === !!(m & 2) && isDown(VK.MENU) === !!(m & 4) && isDown(VK.SHIFT) === !!(m & 8)) {
              if (!swallowUp) { // the first press, not a key repeat
                if (m & (1 | 4)) dummy();
                parentPort.postMessage({ t: 'fire' });
              }
              swallowUp = true;
              return 1;
            }
          }
        }
        // 2. watched keys (Start on Space): noticed, always passed on
        if (cfg.watch && cfg.vks.has(ev.vkCode)) {
          const lag = (K.GetTickCount() - ev.time) >>> 0; // how long ago the key really moved
          const at = performance.now() - (lag < 2000 ? lag : 0);
          if (dn && !down.has(ev.vkCode)) down.set(ev.vkCode, at);
          else if (up && down.has(ev.vkCode)) {
            const downAt = down.get(ev.vkCode); down.delete(ev.vkCode);
            if (at - downAt <= cfg.tapMs) parentPort.postMessage({ t: 'tap', vk: ev.vkCode, downAt: epoch(downAt), upAt: epoch(at) });
          }
        }
      }
    }
  } catch { /* never break the keyboard */ }
  return K.CallNextHookEx(0, code, wParam, lParam);
}
const cb = K.koffi.register(proc, K.koffi.pointer(K.HookProc));

function install() {
  if (handle) { K.UnhookWindowsHookEx(handle); handle = 0; }
  handle = Number(K.SetWindowsHookExW(WH_KEYBOARD_LL, cb, K.GetModuleHandleW(null), 0)) || 0;
  installedAt = Date.now();
  return handle;
}
function uninstall() { if (handle) { K.UnhookWindowsHookEx(handle); handle = 0; } swallowUp = false; down.clear(); }

function readCfg() {
  const vks = new Set([ctl[CTL.WVK1], ctl[CTL.WVK2]].filter((v) => v > 0));
  cfg = { hook: ctl[CTL.HOOK] === 1 && ctl[CTL.VK] > 0, vk: ctl[CTL.VK], mods: ctl[CTL.MODS], watch: ctl[CTL.WATCH] === 1 && vks.size > 0, vks, tapMs: ctl[CTL.TAPMS] || 500 };
  if (!cfg.watch) down.clear();
}

const msg = Buffer.alloc(64);
let gen = -1;
parentPort.postMessage({ t: 'state', installed: false, ready: true });
while (Atomics.load(ctl, CTL.QUIT) === 0) {
  const g = Atomics.load(ctl, CTL.GEN);
  if (g !== gen) {
    gen = g; readCfg();
    const need = cfg.hook || cfg.watch;
    if (need && !handle) { const ok = install(); parentPort.postMessage({ t: 'state', installed: !!ok, why: ok ? '' : 'Windows did not accept the keyboard hook.' }); }
    else if (!need && handle) { uninstall(); parentPort.postMessage({ t: 'state', installed: false }); }
  }
  // Put the hook back now and then: Windows can still drop one (sleep, a secure desktop), silently
  if (handle && Date.now() - installedAt > 60000) install();
  K.MsgWaitForMultipleObjects(0, null, false, 50, QS_ALLINPUT); // sleeps until input arrives or 50 ms pass
  while (K.PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) { /* the hook runs inside this call */ }
}
uninstall();
