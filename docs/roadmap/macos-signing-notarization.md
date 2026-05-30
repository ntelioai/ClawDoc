# macOS signing & notarization (Path A — Developer ID, direct download)

**Goal:** ship a signed + notarized `.dmg` so users can open it without the `xattr -dr com.apple.quarantine` step in the README. This is the path for distribution from `ntelio.ai` / GitHub Releases — **not** the Mac App Store.

> Mac App Store is a dead end for ClawDoc: App Sandbox forbids the PTY-allocated `claude` child process, and AGPL has a long-standing conflict with the App Store distribution agreement. Don't go there.

## One-time setup (Apple side)

1. **Apple Developer Program** — $99/year. Enroll Ntelio LLC as an organization (~2 weeks of identity verification, but the cert reads "Ntelio LLC" instead of a personal name; worth the wait).
2. **Generate the certificate** at [developer.apple.com](https://developer.apple.com/account/resources/certificates) → Certificates → `+` → **Developer ID Application**. (You don't need "Developer ID Installer" — that's for `.pkg`, and ClawDoc ships `.dmg`.)
3. **Download and double-click** the `.cer` to install it into the macOS Keychain. Verify with `security find-identity -p codesigning -v` — you should see a line like `"Developer ID Application: Ntelio LLC (TEAMID)"`. The full quoted string is your `CLAWDOC_SIGN_IDENTITY`.
4. **App-specific password** at [appleid.apple.com](https://appleid.apple.com/account/manage) → Sign-In and Security → App-Specific Passwords. This is for `notarytool`, not for signing.

## Local build (verify before wiring CI)

```bash
export CLAWDOC_SIGN_IDENTITY="Developer ID Application: Ntelio LLC (TEAMID)"
npm run make -- --platform=darwin --arch=universal
```

[`forge.config.js`](../../forge.config.js)'s `signAllAppsBeforeMake` hook already picks up the env var and passes it to [`scripts/sign-app.sh`](../../scripts/sign-app.sh). Confirm with:

```bash
codesign -dv --verbose=4 out/make/ClawDoc.dmg
spctl --assess --type open --context context:primary-signature out/make/ClawDoc.dmg
```

## Notarization (separate step — required since macOS 10.15)

```bash
xcrun notarytool submit out/make/ClawDoc.dmg \
  --apple-id "rabih@ntelio.ai" \
  --team-id "TEAMID" \
  --password "app-specific-password" \
  --wait

xcrun stapler staple out/make/ClawDoc.dmg
```

`--wait` blocks until Apple responds (1–5 minutes). On failure, `xcrun notarytool log <submission-id>` shows why.

## Hardened runtime + entitlements (required for notarization)

[`scripts/sign-app.sh`](../../scripts/sign-app.sh) must pass `--options runtime` to `codesign`, and because Electron + `node-pty` need JIT and arbitrary process exec, an entitlements plist is required:

```xml
<key>com.apple.security.cs.allow-jit</key>                          <true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>   <true/>
<key>com.apple.security.cs.disable-library-validation</key>         <true/>
<key>com.apple.security.cs.allow-dyld-environment-variables</key>   <true/>
```

Passed via `codesign --entitlements build/entitlements.mac.plist`. Without these the app passes notarization but crashes on launch with `killed: 9` because V8's JIT is blocked.

## Wire it into CI ([`.github/workflows/release.yml`](../../.github/workflows/release.yml))

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

## Cleanup after first signed release

- Update [`README.md`](../../README.md) "First-launch on macOS" — drop the `xattr -dr com.apple.quarantine` workaround section; replace with a one-liner "Drag to Applications and double-click. Signed and notarized."
- Update [`docs/PACKAGING.md`](../PACKAGING.md) — the section on Gatekeeper bypass is no longer the recommended path for distribution.
- Update [`SECURITY.md`](../../SECURITY.md) — the "out of scope" bullet about the `xattr` workaround can be removed.
