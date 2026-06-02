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

## macOS signing & notarization (Path A — Developer ID, direct download)

**Goal:** ship a signed + notarized `.dmg` so users can open it without the `xattr -dr com.apple.quarantine` step in the README. This is the path for distribution from `ntelio.ai` / GitHub Releases — **not** the Mac App Store. (Mac App Store is a dead end for ClawDoc: App Sandbox forbids the PTY-allocated `claude` child process, and AGPL has a long-standing conflict with the App Store distribution agreement. Don't go there.)

### One-time setup (Apple side)

1. **Apple Developer Program** — $99/year. Enroll Ntelio LLC as an organization (~2 weeks of identity verification, but the cert reads "Ntelio LLC" instead of a personal name; worth the wait).
2. **Generate the certificate** at [developer.apple.com](https://developer.apple.com/account/resources/certificates) → Certificates → `+` → **Developer ID Application**. (You don't need "Developer ID Installer" — that's for `.pkg`, and ClawDoc ships `.dmg`.)
3. **Download and double-click** the `.cer` to install it into the macOS Keychain. Verify with `security find-identity -p codesigning -v` — you should see a line like `"Developer ID Application: Ntelio LLC (TEAMID)"`. The full quoted string is your `CLAWDOC_SIGN_IDENTITY`.
4. **App-specific password** at [appleid.apple.com](https://appleid.apple.com/account/manage) → Sign-In and Security → App-Specific Passwords. This is for `notarytool`, not for signing.

### Local build (verify before wiring CI)

```bash
export CLAWDOC_SIGN_IDENTITY="Developer ID Application: Ntelio LLC (TEAMID)"
npm run make -- --platform=darwin --arch=universal
```

`forge.config.js`'s `signAllAppsBeforeMake` hook already picks up the env var and passes it to `scripts/sign-app.sh`. Confirm with:

```bash
codesign -dv --verbose=4 out/make/ClawDoc.dmg
spctl --assess --type open --context context:primary-signature out/make/ClawDoc.dmg
```

### Notarization (separate step — required since macOS 10.15)

```bash
xcrun notarytool submit out/make/ClawDoc.dmg \
  --apple-id "rabih@ntelio.ai" \
  --team-id "TEAMID" \
  --password "app-specific-password" \
  --wait

xcrun stapler staple out/make/ClawDoc.dmg
```

`--wait` blocks until Apple responds (1–5 minutes). On failure, `xcrun notarytool log <submission-id>` shows why.

### Hardened runtime + entitlements (required for notarization)

`scripts/sign-app.sh` must pass `--options runtime` to `codesign`, and because Electron + `node-pty` need JIT and arbitrary process exec, an entitlements plist is required:

```xml
<key>com.apple.security.cs.allow-jit</key>                          <true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>   <true/>
<key>com.apple.security.cs.disable-library-validation</key>         <true/>
<key>com.apple.security.cs.allow-dyld-environment-variables</key>   <true/>
```

Passed via `codesign --entitlements build/entitlements.mac.plist`. Without these the app passes notarization but crashes on launch with `killed: 9` because V8's JIT is blocked.

### Wire it into CI (`.github/workflows/release.yml`)

The workflow already reads `CLAWDOC_SIGN_IDENTITY` from secrets but doesn't yet do the cert import or notarization. Add these GitHub repo secrets:

- `CLAWDOC_SIGN_IDENTITY` — the full "Developer ID Application: …" string
- `MACOS_CERT_P12_BASE64` — base64-encoded `.p12` export of the Developer ID cert (`base64 -i cert.p12 | pbcopy`)
- `MACOS_CERT_PASSWORD` — the password used when exporting the `.p12`
- `APPLE_ID` — Apple Developer Program account email
- `APPLE_TEAM_ID` — 10-character team ID from the developer portal
- `APPLE_APP_PASSWORD` — the app-specific password from step 4

Then add steps to the macOS job:

1. **Import the cert** into a temporary keychain (`security create-keychain`, `security import`, `security list-keychains -s`).
2. **Run `npm run make`** — existing step picks up `CLAWDOC_SIGN_IDENTITY` automatically.
3. **Notarize** with `xcrun notarytool submit ... --wait` against the produced DMG.
4. **Staple** with `xcrun stapler staple`.

The cleaner alternative is to use [@electron/notarize](https://github.com/electron/notarize) directly inside `forge.config.js` as an `osxNotarize` config — that folds the entire flow into `npm run make` and skips the separate notarytool step. Probably the right move once the manual flow is proven.

### Cleanup after first signed release

- Update `README.md` "First-launch on macOS" — drop the `xattr -dr com.apple.quarantine` workaround section; replace with a one-liner "Drag to Applications and double-click. Signed and notarized."
- Update `docs/PACKAGING.md` — the section on Gatekeeper bypass is no longer the recommended path for distribution.
- Update `SECURITY.md` — the "out of scope" bullet about the `xattr` workaround can be removed.

## OSS hygiene — not started

- **Vendor CDN assets** (`marked`, `xterm.js`, `toast-ui` editor). Currently loaded from jsDelivr at runtime; called out as a known gap in README "Caveats". Blocks fully offline use and is a supply-chain footgun for an OSS Electron app.
- **Tests** — none exist. A smoke test for `index.js` (the indexer) and `git.js` would catch a lot. Vitest or plain `node --test`.
- **Auto-update** is not configured. Currently users get a new DMG and re-drag to `/Applications` per release.
