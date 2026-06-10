# Changelog

All notable changes to ClawDoc are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-06-10

### Added
- Split view (#50): display two tabs side by side with a draggable divider to control the split.
- Full-fidelity `.xlsx` rendering and editing — preserves cell formatting (fonts, fills, borders, number formats, merged cells); the spreadsheet editor bars are merged into the top toolbar.
- Folder-tree and settings UX batch: blank new-file creation plus `.xlsx`/`.docx` office templates from the folder context menu, and refreshed settings layout.

### Changed
- Folder behaviour (context menus, progressive collapse, `+`/new menu) now applies consistently in the two-pane (double-folder) view as well as the single-pane tree (#53).

## [0.2.0] — 2026-06-03

### Added
- Open-source launch scaffolding: `LICENSE` (AGPL-3.0-only), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/` issue + PR templates, and a tag-triggered cross-platform build workflow.
- Full-text search (#29): in-browser [MiniSearch](https://github.com/lucaong/minisearch) index with stemming, typo tolerance, prefix matching and BM25 ranking, replacing the brute-force substring scan. The whole document body is now indexed (the previous 4 KB cap is gone), and PDF text is extracted at index time via `pdftotext` (poppler) when available. Full bodies are served separately from the doc list (`search.json` / `/api/search`) and the index is built lazily so first paint stays fast.

### Changed
- Renamed all internal identifiers from `mdown` to `clawdoc`: environment variables (`CLAWDOC_ROOT`, `CLAWDOC_PORT`, `CLAWDOC_DATA_DIR`, `CLAWDOC_GITHUB_CLIENT_ID`), localStorage keys (`clawdoc.*`), drag MIME type (`text/x-clawdoc-path`), ignore file (`.clawdocignore`), atomic-write temp prefix (`.clawdoc-tmp-`), default git commit author, and log file (`clawdoc.log`).
- `package.json` is no longer `private`; added `license`, `author`, `homepage`, `repository`, `bugs`, and `keywords` so the project can be discovered and published.

## [0.1.0] — 2026-05-29

Initial public release.

### Added
- Local document browser for Markdown, HTML, and PDF files across one or more workspace folders.
- Markdown rendering via [marked](https://marked.js.org/) with GitHub-flavored syntax (tables, fenced code, footnotes).
- HTML rendering in a sandboxed iframe with relative-link interception so cross-document jumps stay in-app.
- Inline PDF rendering via the embedded Chromium PDF viewer.
- Ranked search across titles, filenames, and document body text; multi-word AND queries.
- Embedded Claude Code terminal — a real PTY-backed shell ([xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)) cwd'd to the active document's workspace.
- "Insert" button that drops the focused file path into the Claude terminal prompt (replaces the earlier auto-paste behavior).
- Multi-workspace support — each attached folder appears as a separate top-level tree.
- Quick-open (`Cmd/Ctrl+P`), global search (`/`), tree filter (`Cmd/Ctrl+K`), `Esc` to dismiss.
- Built-in git integration via [isomorphic-git](https://isomorphic-git.org/) — auto-commits document edits with `clawdoc: edit <files>` messages, optional auto-push to GitHub.
- GitHub OAuth Device Flow for sign-in (falls back to personal-access-token paste if `CLAWDOC_GITHUB_CLIENT_ID` is not set).
- Electron desktop packaging via [Electron Forge](https://www.electronforge.io/) — universal macOS DMG (Apple Silicon + Intel) in the current release; Windows/Linux configured but not yet built in CI.
- macOS Gatekeeper bypass documented (`xattr -dr com.apple.quarantine`) until signed builds ship.
- Workspace picker on first launch; settings persisted to Electron's `userData` directory.
- Editor view with a "Refresh viewer after closing" behavior so saved edits are immediately visible.

### Fixed
- `node-pty`'s `spawn-helper` is now unpacked from the asar bundle so the embedded terminal works in packaged builds.
- Absolute `claude` CLI paths are tried before falling back to `PATH` lookup, with an explicit probe so a missing binary surfaces as a clear error rather than a silent spawn failure.
- Spurious "file changed on disk" banner no longer fires after every save (was triggered by our own atomic-write temp files).

[Unreleased]: https://github.com/ntelioai/ClawDoc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ntelioai/ClawDoc/releases/tag/v0.1.0
