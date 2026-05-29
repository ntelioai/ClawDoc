# Contributing to ClawDoc

Thanks for considering a contribution. ClawDoc is a small project — the codebase is short, the design is opinionated, and reviews are friendly.

## Before you start

- For bug fixes and small improvements, just open a PR.
- For new features or significant refactors, open an issue first so we can agree on shape before you spend time. PRs that arrive without that conversation may get redirected.
- By contributing, you agree your contribution is licensed under the same terms as the project ([AGPL-3.0-only](LICENSE)).

## Setup

```bash
git clone https://github.com/ntelioai/ClawDoc.git
cd ClawDoc
npm install
npm start         # boots Electron + dev server with a workspace picker
```

Node 20+ is required (see `engines` in [package.json](package.json)). `node-pty` and `better-sqlite3`-style native deps mean `npm install` will compile against your local Node — if that fails, check that your toolchain (Xcode CLT on macOS, build-essential on Linux, MSVC on Windows) is installed.

To exercise a packaged build:

```bash
npm run make                              # current OS
npm run make -- --platform=darwin --arch=universal   # universal mac DMG
```

See [docs/PACKAGING.md](docs/PACKAGING.md) for the full per-platform matrix and codesigning notes.

## Project layout

```
electron-main.js     Electron entry — boots serve.js in-process and opens the window
serve.js             Local HTTP + WebSocket server (the "backend")
index.js             Workspace indexer — produces index.json
git.js               isomorphic-git wrapper
github.js            GitHub OAuth Device Flow + minimal REST
app/                 Browser UI (vanilla JS, no framework)
docs/                Packaging + design notes
forge.config.js      Electron Forge config
scripts/             Build helpers (codesign, etc.)
```

No build step on the frontend — `app/app.js` is the running source. Edit, reload.

## Coding conventions

- Plain JS (no TypeScript, no JSX). The frontend deliberately ships without a framework.
- 2-space indentation, single quotes, semicolons. Match the surrounding file.
- Comments explain **why** something is non-obvious, not **what** the code does. Skip them when the code is self-evident.
- Keep dependencies small. Anything you add lands in the packaged DMG and the user pays for it on disk.
- Prefer editing existing files over creating new ones.

## What we're actively looking for

These are the highest-leverage contributions today:

1. **Windows + Linux CI** — `forge.config.js` already targets them, but no CI runner produces the builds. See [docs/PACKAGING.md](docs/PACKAGING.md) for the matrix.
2. **Vendoring CDN assets** — `marked`, `xterm.js`, and the toast-ui editor load from jsDelivr at runtime. Make ClawDoc work fully offline by vendoring them under `app/vendor/`.
3. **macOS codesigning + notarization** — `scripts/sign-app.sh` is the starting point. The goal is removing the `xattr -dr com.apple.quarantine` step from the README.
4. **Tests** — there are none. A smoke test for the indexer (`index.js`) and the git wrapper (`git.js`) would catch a lot.

## Commit messages

Format: `<area>: <imperative summary>`. Examples from history:

```
serve: don't fire change events on .clawdoc-tmp-* files
index: skip files larger than 2 MB
ui: insert button drops the focused file path into the prompt
docs: clarify quarantine bypass step
```

Keep the subject under ~72 characters. Body is optional; use it for **why**, not what — the diff already shows what.

## Pull requests

- One topic per PR. Splitting refactor + feature into two PRs is faster to review than one combined PR.
- Run `node --check` on every file you touched. There's no CI lint on PRs yet — please don't make me catch a syntax error in review.
- If you change UI behavior, include a before/after screenshot or short clip in the PR description.
- Update [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` if your change is user-visible.

## Reporting bugs

Use [GitHub Issues](https://github.com/ntelioai/ClawDoc/issues) and include:

- OS + version
- ClawDoc version (`About` menu, or the `version` field in [package.json](package.json) if running from source)
- Steps to reproduce
- What you expected vs what happened
- Relevant lines from `clawdoc.log` (see README → Configuration for the path on your platform)

## Security issues

**Do not file public issues for security vulnerabilities.** See [SECURITY.md](SECURITY.md) for the disclosure process.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). In short: be kind, assume good faith, and focus on the code.
