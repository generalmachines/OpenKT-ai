/**
 * electron-builder afterPack hook. Unsigned builds (no CSC_LINK) get an AD-HOC signature over the
 * whole bundle — llama-server, whisper-cli and openkt-ocr included: Apple Silicon refuses to run unsigned arm64 code, and a
 * bundle whose seal is broken is reported as "damaged" rather than "unidentified developer".
 * With CSC_LINK set, electron-builder signs after this hook and replaces the ad-hoc signature.
 */
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const helpers = [
    ['Contents/Resources/llama/llama-server', 'scripts/fetch-llama.mjs'],
    ['Contents/Resources/whisper/whisper-cli', 'scripts/build-whisper.sh'],
    ['Contents/Resources/ocr/openkt-ocr', 'scripts/build-ocr.sh'],
  ];
  for (const [rel, script] of helpers) {
    const file = join(appPath, rel);
    if (!existsSync(file)) throw new Error(`${rel} is missing from the bundle; run ${script} before packaging`);
    chmodSync(file, 0o755); // the exec bit must survive packaging
  }
  if (process.env.CSC_LINK || process.platform !== 'darwin') return;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`ad-hoc signed ${appPath}`);
};
