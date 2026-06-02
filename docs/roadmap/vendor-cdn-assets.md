# Vendor CDN assets

`marked`, `xterm.js`, and `toast-ui` editor are currently loaded from jsDelivr at runtime. Called out as a known gap in [`README.md`](../../README.md) "Caveats".

## Why this matters

- Blocks fully offline use — a core promise for a local-first doc browser.
- Supply-chain footgun for an OSS Electron app: a compromised CDN response executes inside ClawDoc's renderer with whatever privileges the preload exposes.

## What "done" looks like

- Pin versions in `package.json` and copy the built assets into `app/vendor/` (or similar) at install time, or vendor them once and check them in.
- Update [`app/index.html`](../../app/index.html) to load from the local path instead of `https://cdn.jsdelivr.net/...`.
- Add a Content-Security-Policy meta or header that disallows remote script/style — guarantees no regression.
