// ═══════════════════════════════════════
//  VoiceType — macOS Notarization Script
// ═══════════════════════════════════════
//
// Called automatically by electron-builder after signing (via afterSign hook).
// Requires these env vars:
//   APPLE_ID          — your Apple ID email
//   APPLE_APP_PASSWORD — app-specific password (appleid.apple.com > Security)
//   APPLE_TEAM_ID     — your 10-char Team ID from Developer Portal
//
// To skip notarization (e.g. local dev builds), don't set these env vars.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') return;

  // Skip if credentials aren't set (local/unsigned builds)
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('Skipping notarization — APPLE_ID, APPLE_APP_PASSWORD, or APPLE_TEAM_ID not set');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  });

  console.log('Notarization complete.');
};
