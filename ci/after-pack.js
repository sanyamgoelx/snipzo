// electron-builder afterPack hook: ad-hoc sign the Mac app before the .dmg/.zip are made.
// electron-builder left the app with Electron's own (now stale) signature on Apple silicon and unsigned on Intel;
// an Apple silicon Mac refuses to run unsigned code, and a stale signature fails Gatekeeper's checks.
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
