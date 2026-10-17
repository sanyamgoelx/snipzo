'use strict';
// The Holding Area: where discarded snips go. Copied from Trimothy's holding.js (keep the two in step);
// shared with Crofty's other tools (F:\Tool\_shared\TOOLS-CONTRACT.md):
//  - files in the user folder (or elsewhere on the system drive): %USERPROFILE%\_Quarantine\<batch>\...
//    (outside the user folder under _outside\...)
//  - files on any other drive: X:\_Quarantine\<batch>\...
//  - every batch has a manifest.json (Drive Cleanup's format), written as each file moves, so nothing
//    in the Holding Area is ever unlisted. Drive Cleanup shows these batches and can empty them.
// The Recycle Bin is never used: Windows silently deletes files too big for it.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const DIR = '_Quarantine';
const OUTSIDE = '_outside';
const KIND = 'snipzo';

const lc = (p) => path.resolve(p).toLowerCase();
const isWin = process.platform === 'win32';

function home() { return process.env.SNIPZO_HOLDING_HOME || (isWin ? process.env.USERPROFILE : process.env.HOME) || os.homedir(); }
function under(p, base) { const a = lc(p), b = lc(base).replace(/[\\/]+$/, ''); return a === b || a.startsWith(b + path.sep); }
function relFrom(p, base) { return path.relative(path.resolve(base), path.resolve(p)); }
function noRoot(p) { const r = path.parse(path.resolve(p)).root; return path.resolve(p).slice(r.length); }

// { area: the Holding Area folder, rel: where the file sits inside a batch }
function place(original) {
  if (process.env.SNIPZO_HOLDING_BASE) return { area: path.join(process.env.SNIPZO_HOLDING_BASE, DIR), rel: noRoot(original) };
  const h = home();
  if (h && under(original, h)) return { area: path.join(h, DIR), rel: relFrom(original, h) };
  if (isWin) {
    const drive = path.parse(path.resolve(original)).root; // "D:\"
    const sys = (process.env.SystemDrive || 'C:').toUpperCase() + '\\';
    if (/^[A-Za-z]:\\$/.test(drive) && drive.toUpperCase() !== sys) return { area: path.join(drive, DIR), rel: relFrom(original, drive) };
  } else if (process.platform === 'darwin') {
    const m = /^\/Volumes\/[^/]+/.exec(path.resolve(original));
    if (m) return { area: path.join(m[0], DIR), rel: relFrom(original, m[0]) };
  }
  return { area: path.join(h || os.tmpdir(), DIR), rel: path.join(OUTSIDE, noRoot(original)) };
}

const pad = (n) => String(n).padStart(2, '0');
function batchName(d = new Date()) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())} ${KIND}`;
}

function batchDirOf(held) {
  let d = path.resolve(held);
  for (;;) { const parent = path.dirname(d); if (parent === d) return null; if (path.basename(parent).toLowerCase() === DIR.toLowerCase()) return d; d = parent; }
}

async function readManifest(batchDir) { try { return JSON.parse(await fsp.readFile(path.join(batchDir, 'manifest.json'), 'utf8')); } catch { return null; } }
async function writeManifest(batchDir, m) {
  const tmp = path.join(batchDir, `manifest.json.${process.pid}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(m, null, 1), 'utf8');
  await fsp.rename(tmp, path.join(batchDir, 'manifest.json'));
}
// One writer at a time per batch (the queue and the Originals panel can both write).
const locks = new Map();
function withLock(key, fn) { const prev = locks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(key, next.catch(() => {})); return next; }

async function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let k = 2; k < 1000; k++) { const q = `${base} (${k})${ext}`; if (!fs.existsSync(q)) return q; }
  return `${base} (${Date.now()})${ext}`;
}

async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await fsp.rename(src, dest); return; } catch (e) { if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; }
  const size = (await fsp.stat(src)).size;
  await fsp.copyFile(src, dest);
  if ((await fsp.stat(dest)).size !== size) { await fsp.unlink(dest).catch(() => {}); throw new Error('the copy came out the wrong size'); }
  await fsp.unlink(src);
}

// Moves `src` into batch `batch` and lists it. Returns where it went.
async function hold(src, { batch, label, replaced = null }) {
  const { area, rel } = place(src);
  const batchDir = path.join(area, batch);
  const dest = await uniquePath(path.join(batchDir, rel));
  const bytes = (await fsp.stat(src)).size;
  await moveFile(src, dest);
  await withLock(lc(batchDir), async () => {
    const m = (await readManifest(batchDir)) || { batch, kind: KIND, createdAt: Date.now(), entries: [] };
    m.entries.push({ from: path.resolve(src), to: dest, bytes, isDir: false, label, ...(replaced ? { replaced } : {}) });
    await writeManifest(batchDir, m);
  });
  return dest;
}

// The file now standing in for a held original (set once the trim or compressed copy has taken its place).
async function setReplaced(held, replaced) {
  const batchDir = batchDirOf(held); if (!batchDir) return;
  await withLock(lc(batchDir), async () => {
    const m = await readManifest(batchDir); if (!m) return;
    const e = (m.entries || []).find((x) => lc(x.to) === lc(held)); if (!e) return;
    e.replaced = replaced; await writeManifest(batchDir, m);
  });
}

async function pruneEmpty(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null); if (!ents) return;
  for (const e of ents) if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name));
  const left = await fsp.readdir(dir).catch(() => ['x']); if (!left.length) await fsp.rmdir(dir).catch(() => {});
}

// After a held file was deleted for good or moved back: drop it from the list; an emptied batch goes.
async function forget(held) {
  const batchDir = batchDirOf(held); if (!batchDir) return;
  await withLock(lc(batchDir), async () => {
    const m = await readManifest(batchDir); if (!m) return;
    m.entries = (m.entries || []).filter((x) => lc(x.to) !== lc(held));
    if (m.entries.length) { await writeManifest(batchDir, m); await pruneEmpty(path.dirname(held)).catch(() => {}); }
    else { await fsp.rm(batchDir, { recursive: true, force: true }); await fsp.rmdir(path.dirname(batchDir)).catch(() => {}); }
  });
}

// Every entry Trimothy put in the Holding Area for files that were under `root`.
async function entriesFor(root) {
  const { area } = place(path.join(root, 'x'));
  const out = [];
  const dirs = await fsp.readdir(area, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const batchDir = path.join(area, d.name);
    const m = await readManifest(batchDir);
    if (!m || m.kind !== KIND) continue;
    for (const e of m.entries || []) if (under(e.from, root) && fs.existsSync(e.to)) out.push({ ...e, batch: m.batch, batchDir, createdAt: m.createdAt });
  }
  return out;
}

module.exports = { DIR, KIND, place, batchName, batchDirOf, hold, setReplaced, forget, entriesFor, readManifest };
