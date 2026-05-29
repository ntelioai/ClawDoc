// Electron Forge config for mdown.
// Minimal config to isolate launch issues. Re-add makers, fuses, signing once
// the .app launches reliably from a packaged build.

module.exports = {
  packagerConfig: {
    name: 'mdown',
    appBundleId: 'ai.ntelio.mdown',
    // No extension — Electron Packager picks build/icon.icns on macOS,
    // build/icon.ico on Windows, and build/icon.png on Linux automatically.
    icon: 'build/icon',
    asar: true,
    ignore: [
      /^\/index\.json$/,
      /^\/settings\.json$/,
      /^\/\.mdownignore$/,
      /^\/REQUIREMENTS\.md$/,
      /^\/README\.md$/,
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/forge\.config\.js$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-squirrel', config: { name: 'mdown', setupIcon: 'build/icon.ico' } },
    { name: '@electron-forge/maker-deb', config: { options: { icon: 'build/icon.png' } } },
    { name: '@electron-forge/maker-rpm', config: { options: { icon: 'build/icon.png' } } },
  ],
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
  ],
};
