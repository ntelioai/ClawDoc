// Electron Forge config for ClawDoc.
// Produces a universal macOS .dmg, plus zip/squirrel/deb/rpm for other targets.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// On arm64 hosts the x64 cross-build of node-pty lands at bin/darwin-x64-<abi>/
// while the arm64 build compiles to build/Release/. That asymmetry breaks
// @electron/universal's "same file count in both builds" check. Strip the
// x64-only path — node-pty falls back to prebuilds/darwin-x64/pty.node which
// is present in both arch builds, so x64 runtime still works.
// Two cleanups before universal stitching:
//   1. Drop bin/darwin-(x64|arm64)-<abi>/ — these only appear in cross-build
//      trees and break the universal stitcher's "same file count" check.
//   2. Drop node-gyp bookkeeping (obj.target/, .deps/, *.o) — these leak from
//      electron-rebuild and only exist in the arch that was compiled locally,
//      which breaks the asar-merge "single arch file" check. They're never
//      needed at runtime; the actual .node binary is all that matters.
const cleanupNodePtyBuildArtifacts = (buildPath, _electronVersion, _platform, _arch, callback) => {
  try {
    const binDir = path.join(buildPath, 'node_modules/node-pty/bin');
    if (fs.existsSync(binDir)) {
      for (const entry of fs.readdirSync(binDir)) {
        if (/^darwin-(x64|arm64)-/.test(entry)) {
          fs.rmSync(path.join(binDir, entry), { recursive: true, force: true });
        }
      }
    }
    // Nuke all node-gyp build-time artifacts that leak into the package tree.
    // node-pty's loader prefers prebuilds/ which ships identical contents for
    // both arches in both build trees, so removing these unblocks the asar
    // merge without breaking runtime.
    for (const sub of ['build', 'node-addon-api', 'src', 'binding.gyp', 'third_party']) {
      const p = path.join(buildPath, 'node_modules/node-pty', sub);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    callback();
  } catch (err) {
    callback(err);
  }
};

// Sign every .app bundle in out/ inside-out so AMFI will load it. Runs as a
// preMake hook (after all packaging, including universal stitching, before
// any maker creates a DMG/zip). Honors CLAWDOC_SIGN_IDENTITY (set to a
// Developer ID for distribution); defaults to ad-hoc.
const signAllAppsBeforeMake = async (_forgeConfig) => {
  if (process.platform !== 'darwin') return;
  const outDir = path.join(__dirname, 'out');
  if (!fs.existsSync(outDir)) return;
  const identity = process.env.CLAWDOC_SIGN_IDENTITY || '-';
  for (const entry of fs.readdirSync(outDir)) {
    const sub = path.join(outDir, entry);
    if (!fs.statSync(sub).isDirectory()) continue;
    if (entry === 'make') continue; // skip the makers' output dir
    for (const name of fs.readdirSync(sub)) {
      if (!name.endsWith('.app')) continue;
      const appPath = path.join(sub, name);
      execFileSync(path.join(__dirname, 'scripts/sign-app.sh'), [appPath, identity], { stdio: 'inherit' });
    }
  }
};

module.exports = {
  packagerConfig: {
    name: 'ClawDoc',
    // The packaged executable is named `clawdoc` (lowercase) on every platform.
    // Without this, Electron Packager names the binary after `name` ("ClawDoc"),
    // but the Linux deb/rpm makers look for the lowercased package name
    // ("clawdoc") and fail with "could not find the Electron app binary". A
    // lowercase executable is also the convention on Linux (.desktop Exec / bin).
    executableName: 'clawdoc',
    appBundleId: 'ai.ntelio.clawdoc',
    // No extension — Electron Packager picks build/icon.icns on macOS,
    // build/icon.ico on Windows, and build/icon.png on Linux automatically.
    icon: 'build/icon',
    // node-pty ships a `spawn-helper` Mach-O binary alongside pty.node — the
    // PTY setup execs it, and ENOENT crashes the embedded terminal if it
    // stays inside the asar. The auto-unpack-natives plugin only unpacks
    // *.node files, so we extend the pattern to also cover spawn-helper and
    // any other native dylibs/sos a module might ship.
    // spawn-helper + native libs must be real files (PTY execs them). The
    // bundled pandoc-wasm tools (vendor/pandoc/**) are unpacked too: the
    // embedded terminal's shell execs the `pandoc` shim and the Node runtime
    // reads pandoc.wasm/core.js from a real path, neither of which works from
    // inside the read-only asar.
    asar: { unpack: '**/{spawn-helper,*.dylib,*.so,vendor/pandoc/**}' },
    // Universal-build merging: node-pty's prebuild structure differs between
    // arm64 (locally compiled .node in build/Release) and x64 (downloaded
    // prebuild under bin/darwin-x64-*). Tell @electron/universal to keep
    // anything inside node-pty as arch-specific instead of trying to merge.
    osxUniversal: {
      mergeASARs: true,
      // node-pty's prebuilt .node files (one per arch) are identical across
      // both build trees because they ship as part of the npm package. Tell
      // the universal stitcher to leave them as-is rather than trying to
      // lipo-merge them.
      x64ArchFiles: '**/node-pty/**/*',
    },
    afterCopy: [cleanupNodePtyBuildArtifacts],
    ignore: [
      /^\/index\.json$/,
      /^\/settings\.json$/,
      /^\/\.clawdocignore$/,
      /^\/REQUIREMENTS\.md$/,
      /^\/README\.md$/,
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/forge\.config\.js$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    // Sign every packaged .app *after* universal stitching but *before* any
    // maker runs, so the DMG/zip contains an already-signed bundle.
    preMake: signAllAppsBeforeMake,
  },
  makers: [
    // macOS — DMG is the primary distribution format. Drag-to-Applications UX.
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'ClawDoc',
        icon: 'build/icon.icns',
        format: 'ULFO', // LZFSE — best compression on macOS 10.11+
      },
    },
    // Also produce a zip per arch for CI uploads / scripted installs.
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    // Windows — Squirrel installer.
    { name: '@electron-forge/maker-squirrel', config: { name: 'ClawDoc', setupIcon: 'build/icon.ico' } },
    // Linux — .deb / .rpm.
    { name: '@electron-forge/maker-deb', config: { options: { icon: 'build/icon.png' } } },
    { name: '@electron-forge/maker-rpm', config: { options: { icon: 'build/icon.png' } } },
  ],
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
  ],
};
