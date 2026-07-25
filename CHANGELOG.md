# Changelog

All notable changes to ClawDoc are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] — 2026-07-25

### Added
- HTML files (`.html`/`.htm`, e.g. decks) are now editable: the viewer's **Edit** button opens the HTML source in the CodeMirror editor (with `htmlmixed` highlighting) and saves it back verbatim. Works in single-pane and in either split pane. `/api/save` now accepts `.html`/`.htm`, and its size cap was raised to 25 MB for large inlined decks.
- Split view: an inactive pane showing an `<iframe>`/`<embed>` (HTML deck, PDF) — which otherwise swallows clicks — now gets a transparent click-to-focus overlay, so you can activate and edit it.

### Changed
- Split view (#50) reworked from a tab-coupled read-only companion into two real document panes. It now opens immediately (no need for a second tab); click a pane to make it active (focus ring); a tree click opens the file in the active pane. Both panes render read-only by default and the single editor "follows" the active pane — click Edit to edit either side (markdown, text/code, Word and spreadsheets). Only one editor is ever live, so there's no remount jank on navigation; clicking Edit in one pane while the other has unsaved changes prompts to Save / Discard / Cancel. The ⇄ button swaps the two panes.
- Topbar icons are now a uniform 32×32 set with clearer glyphs — a two-panel split-screen icon for split view, a folder-transfer icon for the two-pane file manager, and the Claude logomark (replacing the "Claude" text button).

### Fixed
- The Claude panel header no longer clips its right-side buttons at narrow widths — the mode selector shrinks (and the title truncates) while every control stays visible.
- Resizing the Claude panel no longer gets stuck when the drag crosses a deck/PDF/HTML iframe in the viewer (the resizer now disables iframe pointer-events mid-drag, like the split divider).
- Pinning the Claude panel no longer crops the document toolbar: the breadcrumb path scrolls in its own box and the secondary actions (reveal/copy/zoom/fullscreen) fold away when the content area is narrow, keeping reload/history/edit visible.

## [0.3.2] — 2026-07-24

### Added
- Multiple Claude chat tabs (#63): the rich client holds several independent conversations at once — each with its own stream, message log, and session — with a tab strip to open (`+`), switch and close them. Open tabs persist across reloads.
- Restore past conversations (#61): a "Past conversations" picker lists recent Claude sessions (title, preview, workspace, time) and re-opens one as a tab, rendering its transcript and continuing it via `--resume`. Backed by `/agent/sessions` and `/agent/session`.
- Editable text and source files (#62): `.json`, `.yaml`, `.txt`, and common code formats now open in an in-app CodeMirror editor (with a plain-textarea fallback) wired into the existing Save/Close and dirty-navigation guard; invalid JSON is flagged before save.
- Pin/dock the Claude panel (#64): a pin toggle docks the panel beside the editor so it reflows the content instead of overlaying it; unpinned keeps the overlay drawer. State persists.

### Fixed
- Deck "Export PDF" now works in the packaged app. The viewer rendered decks in a sandboxed iframe without `allow-downloads`, so Chromium silently blocked the export (jsPDF `pdf.save()`); added the flag to the viewer iframes and a `will-download` handler that saves to `~/Downloads` via a Save dialog.
- Claude conversation rows no longer compress into thin unreadable bars as the transcript grows (#60): message/tool-call rows keep their natural height so the log scrolls instead.

## [0.3.1] — 2026-07-21

### Fixed
- Git status no longer pins a CPU core and churns gigabytes of memory on workspaces with a large packed history. `git.js` never handed isomorphic-git a cache, so every call started cold and the first packed object it read pulled the entire `.pack` into memory and re-verified its SHA-1 — on a workspace whose history had been gc'd into a ~1GB packfile, a single `status()` could run for minutes, and the UI polls it every 60s per workspace. Each workspace now keeps one cache for the process lifetime.
- Ahead/behind is computed by walking out from each tip until it reaches the other, instead of always enumerating up to 500 commits from both sides, and the result is memoized per tip pair. A workspace whose remote is in sync no longer touches the packfile at all.
- Ahead/behind counts are now correct on branches that have diverged by more than a few hundred commits (previously reported the walk cap rather than the real distance).

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

[Unreleased]: https://github.com/ntelioai/ClawDoc/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/ntelioai/ClawDoc/releases/tag/v0.3.1
[0.1.0]: https://github.com/ntelioai/ClawDoc/releases/tag/v0.1.0
