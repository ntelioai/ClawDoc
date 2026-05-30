# CI: upgrade lint job to a fuller smoke

[`.github/workflows/lint.yml`](../../.github/workflows/lint.yml) currently runs `node --check` on every JS file and stops there. No `npm ci`, no actual imports resolved. Chosen to keep the job under ~30s; `node-pty` is a native module and installing it on a fresh Ubuntu runner takes 2–3 minutes.

## When to upgrade

When external contributors start sending PRs, or the first time a missing-dependency / package-lock drift bug ships to a release.

## What "fuller smoke" means

1. Add `npm ci` after the Node setup step (needs `cache: npm` and probably the Linux build deps already listed in [`release.yml`](../../.github/workflows/release.yml)).
2. After `npm ci`, add a one-liner that exercises the imports, e.g. `node -e "require('./serve.js'); require('./index.js'); require('./git.js'); require('./github.js')"`. Catches the cases plain `node --check` misses:
   - A `require('some-package')` where `some-package` isn't in `package.json`.
   - `package-lock.json` out of sync with `package.json`.
   - Import paths that resolve locally but break on a clean install.

## Cost

~3 min per push/PR instead of ~30s.
