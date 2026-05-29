# ClawDoc — open follow-ups

Captured from the OSS-launch prep session. Not exhaustive — just the deferred decisions worth not forgetting.

## CI: upgrade lint job to a fuller smoke

`.github/workflows/lint.yml` currently runs `node --check` on every JS file and stops there. No `npm ci`, no actual imports resolved. Chosen to keep the job under ~30s; `node-pty` is a native module and installing it on a fresh Ubuntu runner takes 2–3 minutes.

When to upgrade: when external contributors start sending PRs, or the first time a missing-dependency / package-lock drift bug ships to a release.

What "fuller smoke" means:

1. Add `npm ci` after the Node setup step (will need `cache: npm` and probably the Linux build deps already listed in `release.yml`).
2. After `npm ci`, add a one-liner that exercises the imports, e.g. `node -e "require('./serve.js'); require('./index.js'); require('./git.js'); require('./github.js')"`. Catches the cases plain `node --check` misses:
   - A `require('some-package')` where `some-package` isn't in `package.json`.
   - `package-lock.json` out of sync with `package.json`.
   - Import paths that resolve locally but break on a clean install.

Cost: ~3 min per push/PR instead of ~30s.

## Email aliases (block publishing)

These addresses are referenced in repo files and must route to a real inbox before flipping public:

- `security@ntelio.ai` — referenced in `SECURITY.md`.
- `conduct@ntelio.ai` — referenced in `CODE_OF_CONDUCT.md`.

## GitHub repo settings

**Block publishing:**

- Enable **Discussions** (Settings → Features → Discussions). `.github/ISSUE_TEMPLATE/config.yml` points at it; if you'd rather not have Discussions, remove that contact link instead.

**Polish, after going public:**

- The **Private vulnerability reporting** toggle (org-level bulk control) is gated behind GitHub Advanced Security on paid Enterprise plans, so it isn't visible on the ntelioai free/team org. Not required — `SECURITY.md`'s advisory link works on any public repo without it; PVR just adds a visible "Report a vulnerability" button to the Security tab. After flipping public, check `https://github.com/ntelioai/ClawDoc/settings/security_analysis` — the per-repo toggle often appears there once visibility changes.

## macOS signing for release builds

`.github/workflows/release.yml` falls back to ad-hoc signing (`CLAWDOC_SIGN_IDENTITY=-`) so unsigned DMGs still build. To produce signed builds users can run without the `xattr -dr com.apple.quarantine` step:

1. Add `CLAWDOC_SIGN_IDENTITY` as a repo secret (the "Developer ID Application: …" string).
2. Whatever notarization vars `scripts/sign-app.sh` reads also need secrets (Apple ID, app-specific password / API key).
3. Update README's "First-launch on macOS" section to drop the `xattr` workaround once signed builds are the default.

## OSS hygiene — not started

- **Vendor CDN assets** (`marked`, `xterm.js`, `toast-ui` editor). Currently loaded from jsDelivr at runtime; called out as a known gap in README "Caveats". Blocks fully offline use and is a supply-chain footgun for an OSS Electron app.
- **Tests** — none exist. A smoke test for `index.js` (the indexer) and `git.js` would catch a lot. Vitest or plain `node --test`.
- **`REQUIREMENTS.md`** is a pre-rebrand internal spec doc that contradicts the shipped product in places (says "read-only browser; editing stays in the IDE" but the product has an editor + Claude terminal). Decide: delete, archive under `docs/`, or rewrite as a public design doc.
- **Auto-update** is not configured. Currently users get a new DMG and re-drag to `/Applications` per release.
