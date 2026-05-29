# mdown

Local Markdown / HTML document browser for the Business workspace. Google Drive–like UI: folder tree on the left, folder contents or rendered document on the right, with fast search and cross-document linking.

## Run

`mdown` indexes the directory you launch it from (current working directory). The UI assets and the generated `index.json` stay alongside the scripts.

```bash
# one-time: install native dep (node-pty) used by the embedded Claude terminal
cd /path/to/mdown && npm install

# cd into the workspace you want to browse
cd /path/to/your/workspace

# 1) Generate the index
node /path/to/mdown/index.js

# 2) Start the local server
node /path/to/mdown/serve.js

# 3) Open the UI
open http://127.0.0.1:7878/
```

The **Reindex** button in the top-right re-runs step 1 without leaving the UI.

To point at a folder without changing directories:

```bash
MDOWN_ROOT=/path/to/workspace node /path/to/mdown/serve.js
```

### Multiple workspaces

Attach more than one folder by repeating `-p`:

```bash
node /path/to/mdown/index.js -p /Volumes/dev/Business -p /Volumes/dev/SomeOther
node /path/to/mdown/serve.js -p /Volumes/dev/Business -p /Volumes/dev/SomeOther
```

Each workspace shows up as a top-level folder in the tree (named after the
folder's basename, with `-2`, `-3`, … appended on collisions). The Reindex
button automatically re-runs `index.js` with the same `-p` flags `serve.js`
was launched with.

## What it does

- Walks the workspace and indexes every `.md`, `.markdown`, `.html`, `.htm` file (titles, dates parsed from `YYYY-MM-DD_…` filenames, plain-text body extract, outbound links, backlinks).
- Renders Markdown with GitHub-flavored syntax (tables, fenced code) via `marked` (loaded from CDN).
- Renders standalone HTML inside a sandboxed iframe; relative `<a>` links to other indexed docs are intercepted and stay inside mdown.
- Resolves relative image paths against the document's folder.
- Search ranks title/filename matches above body matches; supports multi-word AND queries.
- **Claude** button opens an embedded Claude Code terminal (real PTY via [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)) cwd'd to the workspace of the doc you're viewing. Inherits your existing `claude` CLI login.

## Keyboard

| Key | Action |
|---|---|
| `/` | Focus global search |
| `Cmd/Ctrl+K` | Focus folder filter |
| `Cmd/Ctrl+P` | Quick open (fuzzy filename/title) |
| `↑` / `↓` + `Enter` | Navigate search results |
| `Esc` | Clear / close overlay |

## Configuration

- **Port** — `MDOWN_PORT=8000 node Utils/mdown/serve.js`
- **Ignore patterns** — edit `Utils/mdown/.mdownignore` (gitignore-style; matches workspace-relative path or basename). Defaults exclude `archive/`, `Downloads/`, `node_modules/`, `.git/`, and `Utils/mdown/app`.
- **Workspace root** — the directory you launched from (`process.cwd()`); override with `MDOWN_ROOT=/abs/path`.

## Files

```
Utils/mdown/
├── REQUIREMENTS.md       requirements doc
├── README.md             this file
├── package.json          npm deps (node-pty, ws — for the embedded terminal)
├── index.js              CLI: filesystem walker → index.json
├── serve.js              local HTTP server + WebSocket PTY bridge
├── .mdownignore          ignore patterns (gitignore-style)
├── .gitignore            keeps index.json out of git
├── index.json            generated; rebuilt by Reindex button
└── app/
    ├── index.html        UI shell (xterm.js loaded from CDN)
    ├── app.js            tree, viewer, search, routing, terminal client
    └── style.css
```

Two npm deps: `node-pty` (native, drives the embedded Claude terminal) and `ws` (WebSocket server). Front-end loads `marked`, `xterm.js`, and the toast-ui editor from CDN.

## Desktop app

mdown can be packaged as a standalone `.app` / `.exe` / `.deb` via Electron Forge. Quick start:

```bash
npm install
npm start            # dev
npm run make         # build installer for current OS → out/make/
```

Full instructions, cross-platform CI matrix, signing/notarization, and gotchas: see [docs/PACKAGING.md](docs/PACKAGING.md).

## Caveats

- `marked` loads from jsDelivr. If you need offline operation, vendor it into `app/vendor/marked.min.js` and update the `<script>` tag in `app/index.html`.
- HTML decks render inside a sandboxed iframe; their internal JS still runs (with `allow-scripts`) but cannot reach the parent. Cross-doc link interception works only when the iframe is same-origin (it is, via `/file?path=…`).
- Markdown rendering does not currently sanitize HTML inside Markdown — this is a single-user local tool reading your own files.
- The index covers up to 2 MB per file; larger files are skipped.
