# Packaging ClawDoc as a desktop app

ClawDoc ships as a Node HTTP server + WebSocket PTY bridge + a static frontend. The desktop build wraps all of that in [Electron Forge](https://www.electronforge.io/), producing a standalone `.app` (macOS), `Setup.exe` (Windows), or `.deb` / `.rpm` (Linux) that includes Node, Chromium, every npm dep, and the `node-pty` native binding. End users get one downloadable file with no Node or browser dependency.

This document covers:

1. How the wrapping works (architecture)
2. Local development (`npm start`)
3. Producing distributable artifacts (`npm run make`)
4. Cross-platform builds (CI matrix)
5. Code signing and notarization
6. Caveats, gotchas, and known issues

---

## 1. Architecture

ClawDoc's core (`serve.js`, `index.js`, `git.js`, `github.js`, `app/`) is unmodified Node + a static browser UI. The packaging layer adds two files:

| File | Role |
|---|---|
| [`electron-main.js`](../electron-main.js) | Electron entry. Boots `serve.js` in-process on a free port, then opens a `BrowserWindow` pointing at `http://127.0.0.1:<port>/`. Also redirects writable state to userData. |
| [`forge.config.js`](../forge.config.js) | Electron Forge config. Declares packager options, makers for each OS, and the `auto-unpack-natives` plugin. |

**Why in-process?** Loading `serve.js` with `require()` from the Electron main process means the server starts inside the same Node runtime — no child Node binary needed, no IPC, no port file. The server's `server.listen(PORT, ...)` runs at module load time, so `electron-main.js` simply requires it, polls the port until it accepts connections, then opens a window.

**Why a free port?** A hardcoded port (the dev default is 7878) collides if the user already has a dev ClawDoc instance running. `electron-main.js` calls `net.createServer().listen(0)` at boot to claim a free port, then sets `CLAWDOC_PORT` in `process.env` before requiring `serve.js`.

**Writable state.** `serve.js` and `index.js` read `CLAWDOC_DATA_DIR` and place `settings.json`, `index.json`, and `clawdoc.log` there. In dev mode the var is unset and they live next to the script (existing behavior); in the packaged app, `electron-main.js` sets it to `app.getPath('userData')`:

- macOS: `~/Library/Application Support/ClawDoc/`
- Linux: `~/.config/ClawDoc/`
- Windows: `%APPDATA%\ClawDoc\`

**Native modules.** `node-pty` is a native module — it has to be rebuilt against Electron's Node ABI (different from system Node). Two things make this work automatically:

- `@electron/rebuild` runs during `electron-forge start` / `package` to compile native modules against Electron's ABI.
- `@electron-forge/plugin-auto-unpack-natives` excludes anything with a `.node` file from the ASAR, so the OS loader can `dlopen` them at runtime. (The OS can't `dlopen` from inside an ASAR archive.)

**Reindex spawns.** `serve.js` spawns `index.js` via `process.execPath` for the Reindex button. In a packaged app `process.execPath` is the Electron binary, which would try to launch a window. The fix is to pass `ELECTRON_RUN_AS_NODE=1` in the child's env — Electron treats the env var as "behave as plain Node for this process." Harmless in dev mode (real Node ignores it).

---

## 2. Local development

```bash
cd .
npm install         # one-time; installs Electron, Forge, native rebuilds
npm start           # equivalent to: electron-forge start
```

`npm start`:

1. Runs `@electron/rebuild` against the current Electron ABI (idempotent if already built).
2. Spawns Electron with `electron-main.js` as the entry.
3. On first launch (no `settings.json` in userData and no `CLAWDOC_ROOT` env), shows a folder picker for the workspace.
4. Boots `serve.js` and opens a window.

Subsequent launches read the persisted workspace from `settings.json` and skip the picker.

To target a specific workspace without a picker:

```bash
CLAWDOC_ROOT=/Volumes/dev/Business npm start
```

To target a specific port (otherwise a free one is picked):

```bash
CLAWDOC_PORT=7879 npm start
```

To reset state during development:

```bash
rm -rf ~/Library/Application\ Support/ClawDoc   # macOS
```

---

## 3. Producing distributables

Two commands:

| Command | Output | Use case |
|---|---|---|
| `npm run package` | `out/<name>-<platform>-<arch>/<Name>.app` (or `.exe` etc.) — the raw bundle | Local testing of the packaged build |
| `npm run make` | `out/make/...` — installer artifacts (zip, dmg, deb, exe) | Distribution |

On macOS arm64 today `npm run make` produces:

```
out/make/zip/darwin/arm64/clawdoc-darwin-arm64-0.2.0.zip
```

~128 MB. The zip contains `ClawDoc.app`, which contains Electron (~150 MB uncompressed) + your code.

### Application icon

The icon is wired via `packagerConfig.icon: 'build/icon'` (no extension). Electron Packager picks the platform-specific file at that basename:

| Platform | File           | Used by                                 |
|----------|----------------|-----------------------------------------|
| macOS    | `build/icon.icns` | `.app` bundle icon + Dock              |
| Windows  | `build/icon.ico`  | `.exe` icon + Squirrel installer       |
| Linux    | `build/icon.png`  | `.desktop` file + window manager icon  |

The maker configs reference the same files where they need explicit paths (Squirrel's `setupIcon`, deb/rpm's `options.icon`).

**Source**: `app/assets/ntelio-square-logo-512.png` (the ntelio square logo).

**Regenerating the icons** after editing the source PNG:

```bash
cd .
SRC=app/assets/ntelio-square-logo-512.png

# macOS .icns — uses iconutil (built into macOS)
ICONSET=/tmp/ClawDoc.iconset
rm -rf $ICONSET && mkdir -p $ICONSET
sips -z 16 16   "$SRC" --out $ICONSET/icon_16x16.png       >/dev/null
sips -z 32 32   "$SRC" --out $ICONSET/icon_16x16@2x.png    >/dev/null
sips -z 32 32   "$SRC" --out $ICONSET/icon_32x32.png       >/dev/null
sips -z 64 64   "$SRC" --out $ICONSET/icon_32x32@2x.png    >/dev/null
sips -z 128 128 "$SRC" --out $ICONSET/icon_128x128.png     >/dev/null
sips -z 256 256 "$SRC" --out $ICONSET/icon_128x128@2x.png  >/dev/null
sips -z 256 256 "$SRC" --out $ICONSET/icon_256x256.png     >/dev/null
sips -z 512 512 "$SRC" --out $ICONSET/icon_256x256@2x.png  >/dev/null
sips -z 512 512 "$SRC" --out $ICONSET/icon_512x512.png     >/dev/null
cp "$SRC" $ICONSET/icon_512x512@2x.png
iconutil -c icns $ICONSET -o build/icon.icns

# Windows .ico — uses the png-to-ico devDependency
node -e "const m=require('png-to-ico'); const fn=m.default||m; require('fs').writeFileSync('build/icon.ico', require('buffer').Buffer.from(await fn('$SRC')))"
# (or the .then() form if your node doesn't support top-level await)

# Linux .png — source PNG at 512px is enough
cp "$SRC" build/icon.png
```

The three files in `build/` should be committed so CI builds don't need to regenerate them. The `.iconset` directory in `/tmp/` is throwaway.

**Notes**:

- The source PNG should be at least 1024×1024 for crisp Retina rendering. Today's source is 512px, so the `@2x` 1024 entry in the iconset is just the 512px copy (acceptable but not ideal for high-DPI Macs).
- macOS caches icons aggressively. After replacing `build/icon.icns` and rebuilding, you may still see the old icon in Finder. Force a refresh with `killall Finder` or by moving the bundle in/out of `/Applications/`.
- Windows `.ico` should contain multiple resolutions (16, 32, 48, 256). `png-to-ico` does this automatically from a single source.
- Linux desktop environments use the PNG at multiple sizes; 512px is large enough for all of them to downscale.

### What gets bundled vs skipped

`forge.config.js` `packagerConfig.ignore` excludes runtime-generated files and dev chaff:

```js
ignore: [
  /^\/index\.json$/,        // regenerated on first launch
  /^\/settings\.json$/,     // user-specific, lives in userData
  /^\/\.clawdocignore$/,      // dev-only convenience
  /^\/REQUIREMENTS\.md$/,
  /^\/README\.md$/,
  /^\/out($|\/)/,           // previous build output
  /^\/\.git($|\/)/,
  /^\/forge\.config\.js$/,
]
```

`devDependencies` from `package.json` are automatically excluded by Electron Packager.

---

## 4. Cross-platform builds

**`electron-forge make` only builds for the host OS.** It does not cross-compile a working `.exe` on a Mac or vice versa. The standard pattern is a CI matrix.

### GitHub Actions matrix (recommended)

```yaml
# .github/workflows/release.yml
name: Build desktop apps
on:
  push:
    tags: ['v*']
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: .
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      # Linux: needed by maker-deb / maker-rpm / Squirrel
      - if: matrix.os == 'ubuntu-latest'
        run: sudo apt-get update && sudo apt-get install -y fakeroot dpkg rpm
      - run: npm ci
      - run: npm run make
      - uses: actions/upload-artifact@v4
        with:
          name: clawdoc-${{ matrix.os }}
          path: out/make/**/*
```

Per platform:

| Runner | Maker(s) | Artifact | System deps |
|---|---|---|---|
| `macos-latest` | `@electron-forge/maker-zip` | `.zip` containing `ClawDoc.app` | none (Xcode tools already present) |
| `ubuntu-latest` | `@electron-forge/maker-deb`, `@electron-forge/maker-rpm` | `.deb` and `.rpm` | `fakeroot`, `dpkg`, `rpm` |
| `windows-latest` | `@electron-forge/maker-squirrel` | `Setup.exe` (Squirrel.Windows installer) | none (Mono is no longer required for Squirrel on Windows) |

### Adding a DMG for macOS

The current config produces a `.zip`. To produce a `.dmg` instead (or in addition):

```js
// forge.config.js
makers: [
  { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' }, platforms: ['darwin'] },
  // ...
],
```

`maker-dmg` is already in `devDependencies`. The DMG looks more polished for end users but is larger and slower to produce.

### Adding an AppImage for Linux

`maker-deb` and `maker-rpm` cover the two main package managers. For distro-agnostic distribution, add `@electron-forge/maker-appimage`:

```bash
npm install --save-dev @electron-forge/maker-appimage
```

```js
{ name: '@electron-forge/maker-appimage', config: {} },
```

AppImage produces a single-file executable that works on most distros without installation.

---

## 5. Code signing and notarization

The ad-hoc-signed build that `npm run make` produces today **will launch on the build machine** but will be blocked by Gatekeeper / SmartScreen on other users' machines. For real distribution you need:

### macOS

A Developer ID Application certificate ($99/yr Apple Developer account) plus notarization with Apple.

```js
// forge.config.js — packagerConfig additions
osxSign: {
  identity: 'Developer ID Application: Your Name (TEAMID)',
  optionsForFile: () => ({
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    'entitlements-inherit': 'build/entitlements.mac.plist',
    'signature-flags': 'library',
  }),
},
osxNotarize: {
  appleId: process.env.APPLE_ID,
  appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD, // not your login pw
  teamId: process.env.APPLE_TEAM_ID,
},
```

Entitlements file (`build/entitlements.mac.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict>
</plist>
```

Forge will sign every nested framework and helper, package the bundle, upload it to Apple, wait for notarization (~3–10 min), and staple the ticket. The user sees no Gatekeeper warning when they run it.

CI secrets needed: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and the `.p12` certificate (imported into the runner keychain in a preceding step).

### Windows

A code-signing certificate (EV recommended to avoid SmartScreen warnings on day one; standard OV certs take a few weeks of install-base to "warm up").

```js
// forge.config.js — maker config
{
  name: '@electron-forge/maker-squirrel',
  config: {
    name: 'clawdoc',
    certificateFile: process.env.WINDOWS_CERT_PATH,
    certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
  },
},
```

### Linux

`.deb` and `.rpm` don't need signing to install. If you publish them through an apt or yum repository, sign the repository metadata with `gpg` after the build:

```bash
gpg --detach-sign --armor --output Release.gpg Release
```

AppImage can optionally embed a signature via `appimagetool --sign`.

---

## 6. Caveats and gotchas

### `ELECTRON_RUN_AS_NODE=1` breaks everything

If this env var is set in your shell (which happens if you've debugged Electron's RunAsNode mode and forgot to unset, or have a `.zshrc` line exporting it), every `electron-forge start` and every launch of the packaged `.app` will silently exit with code 0 — Electron treats the env var as "act as plain Node for this process," finds no script arg, and exits.

Symptoms:
- `npm start` returns instantly, no window
- The packaged `.app` opens for a fraction of a second and disappears
- `~/Library/Application Support/ClawDoc/clawdoc.log` is never created

Fix:

```bash
unset ELECTRON_RUN_AS_NODE
```

End users won't hit this — LaunchServices doesn't propagate shell environment to GUI apps.

### `node-pty` needs its `spawn-helper` unpacked too

`node-pty` ships **two** binaries: `pty.node` (the Node addon) and `spawn-helper` (a small Mach-O / ELF executable that node-pty `execve`s as part of PTY setup). The default `@electron-forge/plugin-auto-unpack-natives` plugin only unpacks `*.node` files — so `spawn-helper` stays trapped inside `app.asar` where the kernel can't exec it.

Symptom inside the packaged app:

```
Could not start Claude Code. Tried: claude, /opt/homebrew/bin/claude, ...
Underlying error: posix_spawn failed: No such file or directory
```

The misleading part: the ENOENT is about `spawn-helper`, **not** about the binary you asked node-pty to launch. node-pty's error surface doesn't distinguish — any failure inside `pty.spawn()` looks like the target binary couldn't be found.

Fix in [`forge.config.js`](../forge.config.js): extend `packagerConfig.asar.unpack` to cover the helper:

```js
packagerConfig: {
  asar: { unpack: '**/{spawn-helper,*.dylib,*.so}' },
}
```

The plugin merges this with its own `**/*.node` pattern, so all three classes of files get unpacked. After rebuilding, verify with:

```bash
find out/<name>-darwin-arm64/<Name>.app/Contents/Resources/app.asar.unpacked -name spawn-helper
```

Same gotcha applies to any other native module that ships an auxiliary binary (e.g. `keytar`'s `keytar.js` is fine since it's pure `*.node`, but some `sqlite` builds ship a CLI helper). When you add a new native dep, do an `npm run package` and check what made it into `app.asar.unpacked` — if a sibling binary is missing, extend the unpack pattern.

### Ad-hoc signed apps don't survive transit

The unsigned/ad-hoc `.app` produced by a vanilla `npm run make` will run on the build machine, but if you zip it, send it to someone, they unzip and double-click — macOS marks the unzipped bundle as quarantined and Gatekeeper refuses to launch it (no error dialog on some macOS versions; some show "ClawDoc is damaged and can't be opened").

Workarounds for testing only:

```bash
xattr -dr com.apple.quarantine /Applications/ClawDoc.app   # the recipient runs this
```

Or right-click → Open → Open Anyway in System Settings → Privacy & Security.

For real distribution, sign + notarize per section 5.

### `node-pty` rebuild

`node-pty` is the only native dep currently. If you bump Electron's major version, the native ABI changes, and `npm install` alone won't recompile node-pty — you'll see a runtime error like `Module did not self-register` when opening the embedded terminal. Run:

```bash
./node_modules/.bin/electron-rebuild
```

(This also runs automatically as part of `electron-forge start` / `package`, so the error is mostly only visible when running `serve.js` directly under Electron's Node binary outside the forge workflow.)

If you add other native modules (`better-sqlite3`, `keytar`, etc.), the auto-unpack-natives plugin will unpack them outside the ASAR automatically. No config changes needed.

### Renaming `index.js` (don't)

`serve.js` spawns the indexer via `path.join(SCRIPT_DIR, 'index.js')`. In the packaged app, `SCRIPT_DIR` is inside `app.asar`. Renaming `index.js` or moving it will break Reindex in the packaged build (works in dev because Node's CJS resolver doesn't care about ASAR paths).

### The `index.json` rebuild path is platform-specific

When `serve.js` triggers a reindex, it uses `process.execPath` (the Electron binary) + `ELECTRON_RUN_AS_NODE=1` to run `index.js` as a Node script. This works on all three platforms but the exit code semantics differ on Windows (Squirrel's relaunch logic during updates can cause `index.js` runs to be queued). Test the Reindex button after each Windows installer build.

### CDN-loaded frontend deps

The UI loads `marked`, `xterm.js`, and the toast-ui editor from jsDelivr at runtime. The packaged `.app` therefore needs network access on first launch to render Markdown and open the terminal. To make the app fully offline:

1. `npm install marked @xterm/xterm @toast-ui/editor` (or vendor the CDN URLs)
2. Copy them into `app/vendor/`
3. Update the `<script>` tags in `app/index.html`

Not currently done because ClawDoc was designed as an online-by-default local tool.

### macOS userData survives uninstall

Deleting `ClawDoc.app` doesn't remove `~/Library/Application Support/ClawDoc/`. If you ship a major schema change to `settings.json`, either version-check on load or document a `rm -rf ~/Library/Application\ Support/ClawDoc` step for users.

### Bundle size

The current arm64 `.zip` is ~128 MB. ~95% of that is Electron itself (Chromium + Node + ICU + locales). To slim:

- Strip unused locales via `packagerConfig.electronLanguages: ['en']` — saves ~50 MB
- Use `maker-dmg` with `format: 'ULFO'` (LZFSE compression) for tighter Mac archives
- Consider Tauri or Wails if size is critical (~10 MB bundles, but requires rewriting `serve.js` in Rust or running Node as a sidecar — non-trivial for this codebase)

### Auto-updates

Not configured. To add:

- macOS / Windows: `electron-updater` (works with GitHub Releases, S3, or any HTTP host)
- Linux: distro package managers handle updates for `.deb` / `.rpm`; AppImage uses `AppImageUpdate`

This is out of scope for the initial packaging work but worth knowing before you ship v1.

---

## Quick reference

```bash
# dev
npm start

# build for current OS
npm run package           # raw .app/.exe
npm run make              # installer/zip

# clean userData (macOS)
rm -rf ~/Library/Application\ Support/ClawDoc

# verify packaged app launched
tail -f ~/Library/Application\ Support/ClawDoc/clawdoc.log

# reset native modules after Electron upgrade
./node_modules/.bin/electron-rebuild

# inspect a built bundle's signature
codesign -dv --verbose=4 out/clawdoc-darwin-arm64/ClawDoc.app
```
