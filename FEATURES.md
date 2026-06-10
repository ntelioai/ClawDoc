# ClawDoc — Feature Catalog

This is the source-of-truth inventory of what ClawDoc does, organized by area. It feeds
release-note generation at packaging time: each entry notes the GitHub issue/PR it shipped
under so a release can be assembled by diffing what's new since the last tag.

> **How to use this for release notes.** Pick the features landed since the previous tag
> (cross-reference `git log <prev-tag>..HEAD` and the issue numbers below), then group the
> user-facing ones under **Added / Changed / Fixed** in `CHANGELOG.md`. Internal-only items
> (build, CI, rebrand) usually stay out of user-facing notes.

Status legend: ✅ shipped · 🧪 experimental · 🛠 roadmap (not yet built)

---

## 1. Document viewing & rendering

- ✅ **Markdown rendering** — GitHub-flavored via [marked](https://marked.js.org/): tables,
  fenced code, footnotes. *(0.1.0)*
- ✅ **HTML rendering** — sandboxed same-origin iframe with relative-link interception so
  cross-document jumps stay in-app; relative images resolve against the doc's folder. *(0.1.0)*
- ✅ **PDF rendering** — inline via the embedded Chromium PDF viewer, no plugin. *(0.1.0)*
- ✅ **Spreadsheet viewing** — `.csv` / `.xlsx` rendered via [Univer](https://univer.ai/), now with
  full-fidelity `.xlsx` formatting: fonts, fills, borders, number formats, and merged cells are
  preserved on render. *(#24, 0.3.0)*
- ✅ **Generic file-kind rendering** — images, plain-text / source files, and a graceful
  "no preview" card for unsupported types. *(b2dc22a, part of #35)*
- ✅ **DOCX viewing** — `.docx` rendered in-browser via [SuperDoc](https://superdoc.dev/), with the
  page centered in paginated page view, rulers on, and read/edit-mode + ruler toggles surfaced
  in the toolbar. *(#27, #41)*
- ✅ **Quick-Look office/binary previews** — spacebar in MC mode previews `.xlsx`/`.csv` as
  read-only tables (SheetJS) and `.docx` read-only (SuperDoc viewing); other binaries get a clean
  download/open card instead of garbled text. *(#39)*

## 2. Document editing

- ✅ **Markdown editor** — toast-ui editor; viewer refreshes after the editor closes so saved
  edits are immediately visible. *(0.1.0)*
- ✅ **Spreadsheet editing** — `.csv→.csv` and `.xlsx→.xlsx` round-trip save in the Univer
  viewer. `.xlsx` saves now preserve full formatting (fonts, fills, borders, number formats,
  merged cells) rather than flattening to values, and saving a multi-sheet `.csv` warns before
  dropping the extra tabs. The spreadsheet editor bars are merged into the single top toolbar.
  *(#24, #42, 0.3.0)*
- ✅ **DOCX editing** — in-browser `.docx` edit + save round-trip via SuperDoc. *(#27)*
- ✅ **Export to Word** — bundled [pandoc-wasm](https://github.com/tweag/pandoc-wasm) powers an
  in-app "Export to Word" action and a terminal `pandoc` CLI, no system pandoc required. *(a82d81d)*

## 3. Navigation & file management

- ✅ **Workspace tree** — Google-Drive-style folder tree of every indexed doc. *(0.1.0)*
- ✅ **Multiple workspaces** — attach more than one folder; each is its own top-level tree. *(0.1.0)*
- ✅ **Dual-pane / Midnight-Commander mode** — two-pane file manager view. *(0.1.0)*
- ✅ **Quick open** (`Cmd/Ctrl+P`) — fuzzy filename/title open. *(0.1.0)*
- ✅ **Tree filter** (`Cmd/Ctrl+K`). *(0.1.0)*
- ✅ **New File / New Folder** buttons + refreshed sidebar expand/collapse icons. New folders
  (including empty ones) appear immediately — the node is inserted optimistically and the
  server triggers a reindex so it also survives a reload. *(#28, #44)*
- ✅ **New-file menu with office templates** — create a blank new file, or a starter `.xlsx` /
  `.docx` from the folder/`+` menu. *(0.3.0, 36aae18)*
- ✅ **Split view** — display two tabs side by side with a draggable divider to control the
  split. *(#50, 0.3.0)*
- ✅ **Two-pane folder parity** — all folder behaviour (context menus, progressive collapse,
  `+`/new menu) applies in the two-pane (double-folder) view as well as the single-pane tree.
  *(#53, 0.3.0)*
- ✅ **Progressive collapse** — clicking the collapse icon collapses the focused folder, then
  walks up to its parent on each subsequent click until the whole mounted subtree is closed.
  *(0.3.0)*
- ✅ **Drag-to-move** — drag files from the listing pane onto tree folders to move them,
  with a compact row-sized drag image. The source row disappears immediately (optimistic),
  file ops are locked while a move/delete is resolving, and the server reindexes the affected
  paths so both panes reconcile promptly. *(#35, #46)*
- ✅ **Recursive expand/collapse of a single subtree** — the expand icon expands only the
  selected folder's subtree, not the whole tree. *(#36)*
- ✅ **Multi-select (listing pane)** — Cmd/Ctrl-click toggle, Shift-click range, keyboard
  modifiers, and batch operations on the selection. *(#38, first slice)*
- 🛠 **Multi-select across tree + dual-pane** — extend the selection model to the sidebar tree
  and MC panes. *(#38, open epic)*
- ✅ **Non-blocking file-op feedback** — toast with spinner + Undo for move/copy/delete. *(adc73fa)*

## 4. Search

- ✅ **Full-text search** — in-browser [MiniSearch](https://github.com/lucaong/minisearch)
  index: stemming, typo tolerance, prefix matching, BM25 ranking; title/filename weighted
  above path and body. Whole document body indexed (previous 4 KB cap removed), PDF text
  extracted at index time via `pdftotext` (poppler) when available. Full bodies served
  separately (`search.json` / `/api/search`) and built lazily so first paint stays fast.
  Replaced the earlier brute-force substring scan. *(#29)*
- ✅ **Global search** (`/`) and ranked multi-word AND queries across titles, filenames, body. *(0.1.0)*

## 5. Embedded Claude

- ✅ **One Claude button, two clients** — a single **Claude** button in the topbar opens
  whichever client is selected in **Settings → Claude client**. Default is the rich client;
  the PTY terminal is opt-in. The preference is a local UI setting (`clawdoc.claudeClient`).
- ✅ **Embedded Claude terminal** (Settings → Claude client → *Terminal (PTY)*) — a real
  PTY-backed shell ([xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty))
  cwd'd to the active document's workspace; full interactive TUI (slash commands, permission
  modes, plan mode), inheriting the user's existing `claude` CLI login. *(0.1.0)*
- ✅ **Insert button** — drops the focused file path into the Claude prompt (replaced the
  earlier auto-paste behavior). *(0.1.0)*
- ✅ **Alternative model providers** — a Settings → Model provider section overrides
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` (presets for Google AI Studio, Ollama, OpenRouter,
  or custom) so the embedded terminal + agent can target non-Anthropic / local endpoints. The
  key is stored in `settings.json` (mode `0600`) and never returned to the client; empty = the
  Anthropic default. *(#43)*
- 🧪 **Rich Claude client** (the default — Settings → Claude client → *Rich client*) —
  structured front-end over the same `claude` binary in stream-json mode. Renders the
  conversation as message bubbles, collapsible tool cards, inline diffs for Edit/Write, a
  permission-mode selector, and clickable `file.md` links that open docs in ClawDoc.
  Lazy-connects (doesn't spawn `claude` until the first message). Does **not** yet match the
  PTY's full slash-command/REPL surface. *(#7 epic — M0–M11 delivered)*
  - M1 `/agent` stream-json WebSocket transport *(#9)*
  - M3 message-stream render core *(#11)* · M4 tool-use cards *(#12)* · M5 diff2html diffs *(#13)*
  - M6 inline permission prompts *(#14)* · M7 file/line links into the viewer *(#15)*
  - M8 input composer (send/stop toggle, @-insert, queue) *(#16)* · M9 session lifecycle *(#17)*
  - M10 theme parity, todos, thinking blocks, a11y *(#18)*
- 🛠 **IDE bridge** (`--ide`: `openDiff` + selection/at-mention context) over the existing
  PTY terminal — native diff tabs for every Edit/Write without the rich renderer. *(#20, open)*
- 🛠 **Agent SDK engine** — evaluate `@anthropic-ai/claude-agent-sdk` behind the same
  renderer. *(#21, open)*

## 6. Git & GitHub

- ✅ **Built-in git** via [isomorphic-git](https://isomorphic-git.org/) — auto-commits document
  edits with `clawdoc: edit <files>` messages; optional auto-push to GitHub. *(0.1.0)*
- ✅ **GitHub OAuth Device Flow** sign-in; falls back to personal-access-token paste when
  `CLAWDOC_GITHUB_CLIENT_ID` is unset. Token stored in `settings.json` at mode `0600`. *(0.1.0)*
- ✅ **History / diff viewer** — per-document edit history with a diff view; maximize/restore
  toggle persisted in localStorage; gutter anchored to the scroll pane and overflow fixed. *(#5, #23, #25)*

## 7. Windowing & app shell

- ✅ **Multi-window support** — "Move tab to new window" / "Open in new window" context menu. *(#26)*
- ✅ **Workspace picker on first launch**; settings persisted to Electron's userData dir. *(0.1.0)*
- ✅ **In-app dialogs** — browser `alert`/`confirm` replaced so they work in the packaged
  app. *(#3)*
- ✅ **Reindex moved into the settings dialog**. *(#4)*

## 8. Packaging & distribution

- ✅ **Electron Forge packaging** — universal macOS DMG (Apple Silicon + Intel). A tag-triggered
  CI workflow now builds the full matrix (macOS universal DMG/zip, Windows Squirrel installer,
  Linux deb/rpm) and drafts a GitHub Release with the artifacts attached. *(0.1.0, 0.2.0)*
- ✅ **ClawDoc app icon** (crab shuffling docs) as the packaged macOS icon. *(#2)*
- ✅ **macOS Gatekeeper bypass documented** (`xattr -dr com.apple.quarantine`) until signed
  builds ship. *(0.1.0)*
- ✅ **Open-source scaffolding** — `LICENSE` (AGPL-3.0-only), `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `.github/` issue + PR templates, tag-triggered cross-platform build
  workflow; `package.json` made publishable. *(73083ff)*
- ✅ **Internal rebrand** `mdown → clawdoc` — env vars (`CLAWDOC_ROOT`, `CLAWDOC_PORT`,
  `CLAWDOC_DATA_DIR`, `CLAWDOC_GITHUB_CLIENT_ID`), localStorage keys, drag MIME type,
  `.clawdocignore`, temp prefix, default commit author, `clawdoc.log`. *(73083ff)*
- 🛠 **Auto-update**, **macOS signing + notarization**, **vendored CDN assets**, **fuller CI
  (smoke + lint + tests)** — see `docs/roadmap/`.

---

## Notable bug fixes (for "Fixed" notes)

- ✅ `node-pty`'s `spawn-helper` unpacked from the asar bundle so the embedded terminal works
  in packaged builds. *(0.1.0)*
- ✅ Absolute `claude` CLI paths tried before `PATH` lookup, with an explicit probe so a
  missing binary surfaces a clear error. *(0.1.0)*
- ✅ Spurious "file changed on disk" banner after every save eliminated (was our own
  atomic-write temp files). *(0.1.0)*
- ✅ History diff overflow and gutter-scroll issues. *(#5, #23)*
- ✅ Spreadsheet/docx no longer report unsaved changes on a pristine open (the dirty-gate now
  arms on first real interaction, not a racy `setTimeout(0)`), and discarding from the nav guard
  disposes the editor so the dirty flag clears — ending the infinite "discard?" re-prompt. *(#40)*
- ✅ Spreadsheet/docx viewer height fixed so the sheet bar / toolbar fits the viewport instead
  of being clipped below the fold. *(f746879)*
- ✅ Removed awkward logo highlight. *(#6)*
- 🧪 Rich-client fixes: drop empty bubbles, accurate permission notice, neutral theme,
  @-insert across all workspaces, composer scrollbar behavior. *(part of #7)*

---

## Open epics (in-flight, for "Coming soon")

| # | Epic | State |
|---|------|-------|
| #7  | Rich Claude client (structured conversation UI) | M0–M11 shipped 🧪; refinement ongoing |
| #20 | IDE bridge (`openDiff` + selection context) over the PTY terminal | open 🛠 |
| #21 | Evaluate `@anthropic-ai/claude-agent-sdk` as the engine | open 🛠 |
| #38 | Multi-select across tree, listing, and dual-pane views | listing slice shipped ✅; rest open 🛠 |

---

*Maintained alongside `CHANGELOG.md`. When a feature ships, add it here with its issue/PR
reference; promote the user-facing ones into `CHANGELOG.md` under the next version at
packaging time.*
