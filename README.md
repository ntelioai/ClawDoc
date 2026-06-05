# ClawDoc

**The agentic IDE for documents.**

ClawDoc brings the developer's workflow — a file tree, a fast editor, full-text search, git, and an AI agent that knows what you're working on — to everyday business and technical documents. Point it at one or more folders on disk and it walks them, builds a searchable index, and gives you a Google-Drive-style tree on the left and a rendered document on the right. The **Claude** button opens a Claude Code agent cwd'd to the workspace of the document you're looking at, so it can read, draft, and edit your files in place.

It's built for the people who churn out documents all day — executives, consultants, founders — who want the leverage of an AI coding agent without living in VS Code. Proposals, RFP responses, pricing models, and deck outlines that used to take a week take an afternoon.

ClawDoc renders **Markdown, HTML, PDF, DOCX, CSV/XLSX, images, and plain-text/source files**. Markdown gets GitHub-flavored rendering and a WYSIWYG editor; spreadsheets and Word docs are viewable and editable in-browser; HTML loads in a sandboxed iframe with relative-link interception so cross-document jumps stay inside ClawDoc; PDFs render inline via the bundled Chromium viewer.

Everything is local — there's no server, no upload, no telemetry. ClawDoc reads files from disk and serves them to its own embedded browser over loopback. It's model-agnostic too: the embedded agent defaults to Anthropic but can target Google AI Studio, OpenRouter, Ollama, or any custom endpoint.

---

## Download

**[Download ClawDoc 0.2.0 for macOS (Universal: Apple Silicon + Intel)](https://github.com/ntelioai/ClawDoc/releases/latest/download/ClawDoc-0.2.0-universal.dmg)** · 211 MB  
**[Download ClawDoc 0.2.0 for Windows (x64)](https://github.com/ntelioai/ClawDoc/releases/download/v0.2.0/ClawDoc-0.2.0.Setup.exe)**

Linux builds are not published yet — the `forge.config.js` is set up for them, but the binaries aren't being produced in CI. Build from source if you need them today (see [Build from source](#build-from-source)).

### First-launch on macOS

Because ClawDoc isn't yet signed with a Developer ID, macOS Gatekeeper will block it the first time you open it with one of these dialogs:

> *"ClawDoc is damaged and can't be opened. You should move it to the Trash."*
> *"ClawDoc can't be opened because Apple cannot check it for malicious software."*

This is **not** a virus warning — it's Gatekeeper rejecting an unsigned download. To bypass it, after dragging ClawDoc to `/Applications`, run this once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/ClawDoc.app
```

Then double-click ClawDoc normally. This is a one-time step; it'll launch directly on every subsequent run. We'll remove this step once we ship signed + notarized builds.

### First-launch — picking a workspace

The first time you launch ClawDoc, it shows a folder picker. Choose the folder you want to browse. The choice is remembered in `~/Library/Application Support/ClawDoc/settings.json`; you can add or change workspaces later from the UI. Multiple folders show up as top-level entries in the tree. Folders synced locally by Google Drive or GitHub work just like any other — attach the synced directory.

---

## Features

### View & render

- **Markdown** — GitHub-flavored via [marked](https://marked.js.org/): tables, fenced code, footnotes.
- **HTML** — sandboxed same-origin iframe; relative `<a>` links to other indexed docs stay inside ClawDoc, relative images resolve against the document's folder.
- **PDF** — inline via the embedded Chromium PDF viewer (no plugin install).
- **Spreadsheets** — `.csv` / `.xlsx` rendered via [Univer](https://univer.ai/).
- **Word docs** — `.docx` rendered in-browser via [SuperDoc](https://superdoc.dev/) in paginated page view, with rulers and read/edit toggles in the toolbar.
- **Everything else** — images, plain-text and source files, and a graceful "no preview" download card for unsupported types.
- **Quick-Look previews** — spacebar in dual-pane mode previews `.xlsx`/`.csv` as read-only tables and `.docx` read-only; other binaries get a clean download/open card instead of garbled text.

### Edit

- **Markdown editor** — WYSIWYG [toast-ui](https://ui.toast.com/tui-editor) editor; the viewer refreshes on close so saved edits show immediately.
- **Spreadsheet editing** — `.csv` and `.xlsx` round-trip save in the Univer viewer; the save-bar spells out exactly what persists.
- **DOCX editing** — in-browser `.docx` edit + save round-trip via SuperDoc.
- **Export to Word** — bundled [pandoc-wasm](https://github.com/tweag/pandoc-wasm) powers an in-app "Export to Word" action and a terminal `pandoc` CLI; no system pandoc required.

### Navigate & manage files

- **Workspace tree** — Google-Drive-style folder tree of every indexed doc, with single-subtree recursive expand/collapse.
- **Multiple workspaces** — attach more than one folder; each shows up as its own top-level tree.
- **Dual-pane (Midnight Commander) mode** — a two-pane file manager view.
- **New File / New Folder**, **drag-to-move** files onto tree folders, and **multi-select** (Cmd/Ctrl-click, Shift-click range) with batch operations in the listing pane.
- **Non-blocking file ops** — move/copy/delete show a toast with spinner and Undo; the UI updates optimistically and the server reindexes affected paths.
- **Quick open** (`Cmd/Ctrl+P`) and tree filter (`Cmd/Ctrl+K`).

### Search

- **Full-text search** over the whole document body (including extracted PDF text) via an in-browser [MiniSearch](https://github.com/lucaong/minisearch) index: stemming, typo tolerance, prefix matching and BM25 ranking, with title/filename weighted above path and body. Stays local and offline; no server-side search service.

### Embedded Claude agent

- **One Claude button, two clients** — the **Claude** button in the topbar opens whichever client is selected in **Settings → Claude client**. Both are cwd'd to the active document's workspace and inherit your existing `claude` CLI login.
  - **Rich client** *(default)* — a structured front-end over the `claude` binary in stream-json mode. Renders the conversation as message bubbles, collapsible tool cards, inline diffs for edits, a permission-mode selector, and clickable `file.md` links that open the doc inside ClawDoc. *(Experimental: doesn't yet match the PTY's full slash-command/REPL surface — see [docs/roadmap/vscode-style-claude-client.md](docs/roadmap/vscode-style-claude-client.md).)*
  - **Terminal (PTY)** *(opt-in)* — a real PTY ([xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)) running the full interactive `claude` TUI: slash commands, permission modes, plan mode — everything your normal `claude` does.
- **Insert button** — drops the focused file path into the Claude prompt.
- **Alternative model providers** — **Settings → Model provider** overrides `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` (presets for Google AI Studio, Ollama, OpenRouter, or custom) so the agent can target non-Anthropic or local endpoints. The key is stored in `settings.json` (mode `0600`) and never returned to the client.

### Git & history

- **Built-in git** via [isomorphic-git](https://isomorphic-git.org/) — auto-commits document edits with `clawdoc: edit <files>` messages, with optional auto-push to GitHub.
- **GitHub OAuth Device Flow** sign-in, falling back to a personal-access-token paste when `CLAWDOC_GITHUB_CLIENT_ID` is unset.
- **History / diff viewer** — per-document edit history with a diff view.

### App shell

- **Multi-window** — "Move tab to new window" / "Open in new window" from the context menu.
- **Workspace picker** on first launch; settings persisted to Electron's userData dir.

### Keyboard

| Key | Action |
|---|---|
| `/` | Focus global search |
| `Cmd/Ctrl+K` | Focus folder filter |
| `Cmd/Ctrl+P` | Quick open (fuzzy filename/title) |
| `↑` / `↓` + `Enter` | Navigate search results |
| `Esc` | Clear / close overlay |

> Looking for the complete, issue-referenced inventory? See [FEATURES.md](FEATURES.md).

---

## Build from source

```bash
git clone https://github.com/ntelioai/ClawDoc.git
cd ClawDoc
npm install
npm start              # dev mode (Electron + live workspace picker)
npm run make           # build installer for the current OS
```

To produce a universal macOS DMG (works on Apple Silicon and Intel):

```bash
npm run make -- --platform=darwin --arch=universal
# → out/make/ClawDoc.dmg
```

For Windows or Linux, run `npm run make` on a `windows-latest` / `ubuntu-latest` runner — `electron-forge make` only builds for the host OS. See [docs/PACKAGING.md](docs/PACKAGING.md) for the full CI matrix and signing/notarization details.

---

## Configuration

ClawDoc stores its writable state in Electron's userData directory:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/ClawDoc/` |
| Linux | `~/.config/ClawDoc/` |
| Windows | `%APPDATA%\ClawDoc\` |

Files there:

- `settings.json` — workspace list, git config, GitHub token, model-provider key (mode 0600)
- `index.json` — generated index of every supported file in your workspaces (rebuilt on demand via **Settings → Reindex**)
- `search.json` — full document bodies served to the search index, built lazily
- `clawdoc.log` — Electron + server log

Environment overrides:

- `CLAWDOC_ROOT=/path/to/workspace` — skip the picker on first launch
- `CLAWDOC_PORT=7879` — pin the embedded server's port (default: random free port)
- `CLAWDOC_DATA_DIR=/some/dir` — override where `settings.json` / `index.json` / `clawdoc.log` live
- `CLAWDOC_GITHUB_CLIENT_ID=<oauth-app-id>` — enable GitHub OAuth Device Flow; without it the UI falls back to a personal-access-token paste

---

## Privacy & security

- **All processing is local.** ClawDoc reads files from disk and serves them to its own embedded browser over `127.0.0.1`. Nothing is uploaded and there is no telemetry.
- **The Claude agent connects to wherever your `claude` CLI (or configured model provider) is set to connect.** ClawDoc itself doesn't touch the Anthropic API.
- **Secret storage**: the GitHub OAuth token and any model-provider API key are stored in `settings.json` with file mode `0600`. Treat that file as you would your shell history.

---

## Caveats

- The frontend loads some assets (`marked`, `xterm.js`, the toast-ui editor) from jsDelivr. ClawDoc therefore needs network access on first launch to render Markdown and open the terminal. Vendoring those is on the roadmap.
- HTML decks render inside a sandboxed iframe. Cross-doc link interception works because the iframe is same-origin (served from `/raw/<path>`).
- The index covers up to 2 MB per file; larger files are skipped.
- Markdown rendering does not sanitize HTML inside Markdown — this is a single-user local tool reading your own files.
- Auto-update is not configured. To upgrade, download a new build from [Releases](https://github.com/ntelioai/ClawDoc/releases).

---

## License

ClawDoc is released under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only).

In short: you can use, modify, and self-host ClawDoc freely. If you offer it as a hosted service or distribute a modified version, the AGPL requires you to make the corresponding source code available to your users under the same license. For a non-AGPL commercial license, contact [rabih@ntelio.ai](mailto:rabih@ntelio.ai).

Copyright © 2026 Ntelio LLC
Copyright © 2026 Rabih Nassar
