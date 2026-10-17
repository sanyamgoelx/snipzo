// electron-builder afterPack hook: ad-hoc sign the Mac app before the .dmg/.zip are made.
// electron-builder left the app with Electron's own (now stale) signature on Apple silicon and unsigned on Intel;
// an Apple silicon Mac refuses to run unsigned code, and a stale signature fails Gatekeeper's checks.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  // Each Mac build is for one architecture: drop the other one's ffprobe and koffi (ffprobe alone is ~65 MB)
  const arch = ctx.arch === 3 ? 'arm64' : 'x64', other = arch === 'arm64' ? 'x64' : 'arm64'; // builder-util Arch: 1 x64, 3 arm64
  const un = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  for (const p of [path.join(un, 'ffprobe-static', 'bin', 'darwin', other), path.join(un, 'koffi', 'build', 'koffi', `darwin_${other}`)]) {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); console.log('  • removed (other architecture)', path.relative(app, p)); }
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
