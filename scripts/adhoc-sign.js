const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Ad-hoc ondertekent de app-bundel na het packen, zodat macOS een geldige
// (maar niet door Apple vertrouwde) handtekening ziet in plaats van een
// alleen door de linker ondertekende binary. Dat voorkomt de melding
// "app is beschadigd"; gebruikers kunnen hem openen via rechtsklik -> Open.
module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
