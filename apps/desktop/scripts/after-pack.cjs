/**
 * electron-builder afterPack hook. Unsigned builds (no CSC_LINK) get an AD-HOC signature over the
 * whole bundle, llama binaries included: Apple Silicon refuses to run unsigned arm64 code, and a
 * bundle whose seal is broken is reported as "damaged" rather than "unidentified developer".
 * With CSC_LINK set, electron-builder signs after this hook and replaces the ad-hoc signature.
 */
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const server = join(appPath, 'Contents/Resources/llama/llama-server');
  if (!existsSync(server)) throw new Error(`llama-server missing from the bundle (${server}); run scripts/fetch-llama.mjs before packaging`);
  chmodSync(server, 0o755);
  if (process.env.CSC_LINK) return;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`ad-hoc signed ${appPath}`);
};
