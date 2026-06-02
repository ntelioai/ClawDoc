# Auto-update

Not configured. Currently users get a new DMG and re-drag to `/Applications` per release.

## Options

- **`update.electronjs.org`** — free hosted update server for OSS Electron apps published on GitHub Releases. Lowest friction. Needs the app to be code-signed first (see [macos-signing-notarization.md](macos-signing-notarization.md)) — Squirrel.Mac refuses to apply updates to unsigned bundles.
- **`electron-updater`** (from electron-builder) against GitHub Releases directly — more control, more moving parts. Probably overkill until there's a reason.

## Dependencies

- macOS signing + notarization must land first.
- A Windows code-signing cert if Windows auto-update is in scope (separate, expensive — defer).

## Wire-up sketch

1. Add `electron-updater` or `update-electron-app` (the wrapper for `update.electronjs.org`).
2. Call the updater in [`electron-main.js`](../../electron-main.js) after `app.whenReady()`.
3. Decide UX: silent background install on quit, or visible "update available" toast.
