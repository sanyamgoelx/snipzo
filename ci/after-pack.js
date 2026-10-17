// electron-builder afterPack hook, runs before signing and before the installer files are made.
//  1. Keep only this build's own ffprobe and koffi binaries (ffprobe-static ships every OS and CPU, ~60 MB each).
//     Platform-level "files" lists replace the root list in electron-builder (the Mac app once packed dist/ and
//     .git that way), so this is done here instead.
//  2. Mac: ad-hoc sign the app. electron-builder left Electron's own, now stale, signature on Apple silicon and
//     nothing on Intel; Apple silicon refuses unsigned code.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }; // builder-util Arch

function keepOnly(dir, keep, label) {
  if (!fs.existsSync(dir)) return;
  for (const n of fs.readdirSync(dir)) {
    if (!keep(n)) { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); console.log(`  • removed ${label}/${n} (not this OS/CPU)`); }
  }
}

exports.default = async function afterPack(ctx) {
  const os = ctx.electronPlatformName, arch = ARCH[ctx.arch] || 'x64'; // 'darwin' | 'win32' | 'linux'
  const res = os === 'darwin' ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(ctx.appOutDir, 'resources');
  const nm = path.join(res, 'app.asar.unpacked', 'node_modules');
  keepOnly(path.join(nm, 'ffprobe-static', 'bin'), (n) => n === os, 'ffprobe-static/bin');
  keepOnly(path.join(nm, 'ffprobe-static', 'bin', os), (n) => n === arch, `ffprobe-static/bin/${os}`);
  keepOnly(path.join(nm, 'koffi', 'build', 'koffi'), (n) => n === `${os}_${arch}`, 'koffi/build/koffi');
  if (os !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
