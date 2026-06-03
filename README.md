# ClawDoc

A local document browser for your Markdown / HTML / PDF files, with an embedded Claude Code terminal that knows where you are in the tree.

Point ClawDoc at one or more folders on disk. It walks them, builds a searchable index, and gives you a Google-Drive-style tree on the left and a rendered document on the right. Markdown gets GitHub-flavored rendering. HTML loads in a sandboxed iframe with relative-link interception so cross-document jumps stay inside ClawDoc. PDFs render inline via the bundled Chromium viewer. The **Claude** button opens a real PTY-backed terminal cwd'd to the workspace of the document you're looking at, inheriting your existing `claude` CLI login.

Everything is local — there's no server, no upload, no telemetry. ClawDoc reads files from disk and serves them to its own embedded browser over loopback.

---

## Download

**[Download ClawDoc 0.1.0 for macOS (Universal: Apple Silicon + Intel)](https://github.com/ntelioai/ClawDoc/releases/latest/download/ClawDoc-0.1.0-universal.dmg)** · 208 MB

Windows and Linux builds are not published yet — the `forge.config.js` is set up for them, but the binaries aren't being produced in CI. Build from source if you need them today (see [Build from source](#build-from-source)).

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

The first time you launch ClawDoc, it shows a folder picker. Choose the folder you want to browse. The choice is remembered in `~/Library/Application Support/ClawDoc/settings.json`; you can add or change workspaces later from the UI. Multiple folders show up as top-level entries in the tree.

---

## Features

- **Renders Markdown** with GitHub-flavored syntax (tables, fenced code) via [marked](https://marked.js.org/).
- **Renders HTML** in a sandboxed iframe; relative `<a>` links to other indexed docs stay inside ClawDoc, relative images resolve against the document's folder.
- **Renders PDFs** inline via the embedded Chromium PDF viewer (no plugin install).
- **Search** — full-text over the whole document body (including extracted PDF text) via an in-browser [MiniSearch](https://github.com/lucaong/minisearch) index: stemming, typo tolerance, prefix matching and BM25 ranking, with title/filename weighted above path and body. Stays local and offline; no server-side search service.
- **Embedded Claude terminal** (the **Claude** button) — a real PTY (via [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)) bound to the `claude` CLI, cwd'd to the doc's workspace. This is the full interactive TUI: slash commands, permission modes, plan mode — everything your normal `claude` does.
- **Rich Claude client** (the **Claude ✦** button) — an *experimental* structured front-end over the same `claude` binary running in stream-json mode. Renders the conversation as message bubbles, collapsible tool cards, inline diffs for edits, a permission-mode selector, and clickable `file.md` links that open the doc inside ClawDoc. Runs side-by-side with the PTY terminal so you can compare them. See [docs/roadmap/vscode-style-claude-client.md](docs/roadmap/vscode-style-claude-client.md) for the rationale and known gaps (it does **not** yet match the PTY's full slash-command/REPL surface).
- **Multiple workspaces** — attach more than one folder; each shows up as its own top-level tree.
- **Quick open** (`Cmd/Ctrl+P`) and global search (`/`).
- **Git-aware** — built-in `isomorphic-git` integration commits document edits with `clawdoc: edit <files>` messages, and optionally auto-pushes to GitHub if you've signed in.

### Keyboard

| Key | Action |
|---|---|
| `/` | Focus global search |
| `Cmd/Ctrl+K` | Focus folder filter |
| `Cmd/Ctrl+P` | Quick open (fuzzy filename/title) |
| `↑` / `↓` + `Enter` | Navigate search results |
| `Esc` | Clear / close overlay |

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

- `settings.json` — workspace list, git config, GitHub token (mode 0600)
- `index.json` — generated index of every Markdown/HTML/PDF in your workspaces (rebuilt on demand via the **Reindex** button)
- `clawdoc.log` — Electron + server log

Environment overrides:

- `CLAWDOC_ROOT=/path/to/workspace` — skip the picker on first launch
- `CLAWDOC_PORT=7879` — pin the embedded server's port (default: random free port)
- `CLAWDOC_DATA_DIR=/some/dir` — override where `settings.json` / `index.json` / `clawdoc.log` live
- `CLAWDOC_GITHUB_CLIENT_ID=<oauth-app-id>` — enable GitHub OAuth Device Flow; without it the UI falls back to a personal-access-token paste

---

## Privacy & security

- **All processing is local.** ClawDoc reads files from disk and serves them to its own embedded browser over `127.0.0.1`. Nothing is uploaded.
- **The Claude terminal connects to wherever your `claude` CLI is configured to connect.** ClawDoc itself doesn't touch the Anthropic API.
- **GitHub token storage**: if you sign in to GitHub from the UI, the OAuth token is stored in `settings.json` with file mode `0600`. Treat that file as you would your shell history.

---

## Caveats

- The frontend loads `marked`, `xterm.js`, and the toast-ui editor from jsDelivr. ClawDoc therefore needs network access on first launch to render Markdown and open the terminal. Vendoring those is on the roadmap.
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
