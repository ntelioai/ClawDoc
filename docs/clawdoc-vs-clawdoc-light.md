# ClawDoc vs. ClawDoc Light

**Last updated:** 2026-09-05 (post Cowork built-in browser)
**Related:** [`clawdoc-vs-claude-desktop-and-cowork.md`](./clawdoc-vs-claude-desktop-and-cowork.md) — read that first for competitive context; this doc assumes it.

Hypothetical comparison: the current native/desktop ClawDoc vs. a browser-only
"Light" build running Node in [StackBlitz WebContainers](https://webcontainers.io/)
plus the [Claude Agent SDK](https://docs.anthropic.com/claude-agent-sdk) in
place of the CLI binary.

Goal of Light: user opens a URL, authenticates Claude (API key or OAuth), grants
folder access, and is in business — no server-side registration, no local install.

| Area | Full ClawDoc (today) | ClawDoc Light (browser + WebContainers + SDK) |
|---|---|---|
| **Runtime** | Node backend + Electron/browser frontend, native binaries alongside | Static site + WebContainer (Node-in-WASM by StackBlitz) + Claude Agent SDK |
| **Install** | Download signed installer or `npm i -g` + `claude` binary | Open a URL. No install |
| **First-run cost** | ~200 MB app; runs instantly | ~50–150 MB WebContainer boot + WASM warmup on first visit; then cached |
| **Browser support** | Any (frontend), backend runs natively | Chromium-only in practice (File System Access API + WebContainer requirements). No Safari/Firefox |
| **Registration** | None | None |
| **Auth to Claude** | `claude login` OAuth → `~/.claude/.credentials.json` | API key in IndexedDB, or OAuth device flow. No CLI credential store |
| **Auth to GitHub** | System `gh`/git creds | Device-flow OAuth → IndexedDB; a public static app-secret redirect is fine, no server needed |
| **Filesystem** | Real Node `fs`, absolute paths, mounted workspaces from settings | File System Access API. User grants each folder per session; persistent handles survive via IndexedDB |
| **File watching** | chokidar → live reindex on any change | `FileSystemObserver` (Chrome 129+) or polling. Weaker; multi-GB trees will lag |
| **Reindex speed** | Native `fs` walk + workers, fast on 100k+ files | FSA is 5–20× slower per op; big workspaces feel slow |
| **File size limits** | Whatever the OS allows | Browser memory (WASM ~4 GB per instance); large Excel/PDF may fail |
| **Claude Code** | Real CLI binary, full feature set | Agent SDK inside WebContainer, or SDK talking directly to API with `anthropic-dangerous-direct-browser-access` |
| **`canUseTool` / live permission prompts** | CLI headless mode denies silently (current pain) | ✅ SDK exposes it natively — the prompt UI you already have becomes fully functional |
| **Terminal (PTY, xterm.js)** | Real PTY via `node-pty`, actual `claude` TUI | ❌ No PTY. Text-only stream. TUI features (alt screen, curses UIs, keybinds) gone |
| **Slash commands (`/skill`, `/loop`, custom)** | Full support via CLI | Depends on SDK — some are CLI-only. Custom project skills probably work; built-ins vary |
| **Subagents (Task/Explore/Plan)** | Yes | Yes, if driven through SDK |
| **Hooks** | Yes (CLI settings.json) | Requires reimplementation on top of SDK — not automatic |
| **MCP servers** | STDIO + HTTP + SSE transports; can install `.mcpb` Desktop Extensions (one-click bundles) | ❌ STDIO impossible in browser. HTTP/SSE only. As of mid-2026 the official MCP registry has 9,400+ servers — the STDIO-only majority is out of reach |
| **Git** | System `git` + `git.js` wrapper (real diffs, blame, branches, push) | **isomorphic-git** — clone/commit/push work; performance ~5–10× slower on big repos; some corners (submodules, LFS, sparse checkout, credential helpers) rough or missing |
| **External binaries (rg, fzf, python, imagemagick…)** | Whatever user has on PATH | Only what you bundle into the WebContainer image. `rg` — you'd have to ship a WASM build or fall back to JS grep |
| **pandoc (md→docx)** | Bundled pandoc-wasm already | Same — pandoc-wasm carries over unchanged |
| **CRM SQLite (`~/crm.sqlite`)** | Real SQLite via node bindings, on-disk | `sql.js` (SQLite in WASM) + IndexedDB persistence. Works; write throughput lower; risk of browser storage eviction |
| **Session history (`~/.claude/projects/…`)** | Filesystem, restore any past session | IndexedDB. Same UX, different storage. Persists per browser profile, doesn't sync across devices unless you build sync |
| **Multi-window** | Full support (Electron/browser tabs) | Browser tabs only; each tab = own WebContainer (heavy) or shared (needs SharedWorker choreography) |
| **Reveal in Finder / Open in native app** | ✅ | ❌ No shell access. "Download" is the browser equivalent |
| **Notifications, dock badges, tray** | Electron/OS APIs | Web Notifications API only; no dock/menubar |
| **Watch mode / live doc reload** | Instant via SSE from chokidar | Delayed (polling / `FileSystemObserver`) |
| **Networking / CORS** | Direct HTTP to any endpoint | `api.anthropic.com` works with the browser-access header. Fetching arbitrary URLs (WebFetch tool) hits CORS unless target permits it or you proxy |
| **Offline** | Fully offline once installed | Frontend cacheable via SW; SDK needs the API (no offline Claude) |
| **Performance ceiling** | Native | WebContainer ~2–5× slower for Node; WASM garbage collection pauses; big MC-mode operations feel it |
| **Update path** | Ship new installer or auto-update | Deploy the static site; users refresh |
| **Distribution / licensing cost** | Free (self-hosted install) | WebContainer is StackBlitz-proprietary — free for personal/OSS, **paid commercial license** for a hosted product with users. That's a real line item |
| **Data privacy story** | "Nothing leaves your machine except Claude API calls" — easy to explain | "Files stay in your browser sandbox, Claude API calls go direct" — also strong, but harder for non-technical users to trust vs. a native app |
| **Feature coverage vs. Full** | 100% | Rough estimate ~55–65% by feature count; ~80% by "daily use" if you accept no PTY and Chromium-only |
| **Feature coverage vs. Claude Cowork (the real competitor)** | See sibling doc | Loses on: autonomy, Computer Use, phone Dispatch, MCP ecosystem depth, built-in browser, polish. Wins on: browser accessibility, no install, no paid plan, model choice, corpus search, git history, open-source |
| **Engineering effort to build** | Existing | Substantial: FSA layer replacing `serve.js`, WebContainer wiring, SDK-based agent path with `canUseTool`, isomorphic-git port, sql.js CRM port, session/IndexedDB shim, feature-flagging for unsupported MCP/hooks. Weeks-to-months of focused work |
| **Ongoing maintenance** | One code path | Two code paths unless you unify (frontend can be shared; backend layer needs a `platform` abstraction — real refactor of `serve.js`'s API surface) |

## Sanity flags on this analysis

- WebContainer exact caveats (which binaries ship, filesystem semantics) come
  from memory; verify against current WebContainer docs before committing.
- Agent SDK feature parity with the CLI (hooks, skills, subagents) shifts
  release-to-release — some may already be first-class, some may still be
  CLI-only. Worth confirming.
- `isomorphic-git` performance and feature gaps are real but the exact list
  shifts version to version.

---

## Competitive reality check (Sep 2026)

What changed since the original ClawDoc vs. Cowork analysis materially affects
whether Light is worth building:

- **Windows parity.** Claude Desktop shipped on Windows (Feb 10, 2026) with full
  Cowork + MCP support. The "Mac-first, Windows-only-via-workaround" wedge for
  Full ClawDoc is gone; the "browser works everywhere" wedge for Light is worth
  correspondingly less.
- **Cowork's built-in browser.** As of Q3 2026, Cowork ships a sandboxed browser
  pane inside Claude Desktop (Cmd+Shift+B) — Anthropic no longer needs the
  Chrome extension for agentic web tasks. Users get "agent + files + web" in one
  first-party app, no install beyond the desktop app itself.
- **Desktop Extensions (`.mcpb`).** One-click MCP install replaced manual JSON
  config. The MCP ecosystem is now genuinely mainstream (~9,400 servers mid-2026).
- **Continued Anthropic-only + paid.** All of the above still assumes an
  Anthropic paid plan and an Anthropic model.

### Where this leaves Light

Light's pitch — "open a URL, no install, use Claude on your files" — collides
directly with Cowork's pitch, and Cowork wins on autonomy, browser, MCP depth,
polish, and Computer Use. **Light cannot compete on "agent + files + web in a
convenient package."** That's Cowork's turf now, and the built-in browser closed
the last gap.

Light's non-overlapping wedges narrow to three, all inherited from Full ClawDoc:

1. **Zero install AND zero paid plan.** Cowork requires Claude Pro/Max/Team.
   Light with BYO API key (or a free-tier model like Gemini/Ollama-via-proxy) can
   be genuinely free for the user.
2. **Model choice.** Cowork is Anthropic-only. Light can target OpenRouter,
   Gemini, or an Ollama endpoint the user runs themselves.
3. **Document-workspace ergonomics.** Cowork has no document browser/editor
   surface — the render/edit/browse/search wedge from Full ClawDoc carries over.
   Light-in-a-browser is arguably a better delivery vehicle for that wedge than
   a downloadable app, if the user's files live in the cloud already.

### Sequencing implication

The earlier "build a WorkspaceSource adapter, ship Drive-connected Full ClawDoc
first, then port to Light" plan looks even better in light of this:

- The **Drive-connected Full ClawDoc** ships into a market where Cowork still
  can't browse/edit Drive documents in-app. That's an unambiguous new capability
  with no direct first-party competitor.
- **Light** becomes a "try it without installing" front door to the same
  product, funneling users who convert to Full for performance/completeness.
- The BYO-model story (wedge #2) is where Light has a *unique* advantage over
  both Cowork and any hypothetical browser-hosted Anthropic product, since
  Anthropic will never ship "point us at Ollama."

### Go/no-go framing

- **Go on Light** if the primary user is: someone with cloud-stored documents
  (Drive/Dropbox/etc.), doesn't want to install anything, values BYO-model or
  free-tier access, tolerates Chromium-only, and doesn't need Cowork-level
  autonomy or MCP depth.
- **No-go on Light** if the primary user is: a Cowork subscriber, comfortable
  with a signed desktop app, wants the full MCP ecosystem, or works on huge
  local trees where FSA/WebContainer performance will disappoint.

Cheapest experiment: ship the **WorkspaceSource abstraction + Google Drive
adapter in Full ClawDoc** first. That both validates the adapter model and
delivers a real capability Cowork doesn't have. Only then decide whether Light
is a distinct build or a deployment target of the same codebase.

---

## Alternative filesystem: cloud connectors (Google Drive et al.)

For ClawDoc Light in particular, a **Google Drive connector** may be a stronger
filesystem-source than the File System Access API. It also generalizes cleanly
to other clouds.

### Why a Drive connector is compelling for Light

- Works in every browser (no Chromium restriction — Safari and Firefox OK).
- Files sync across devices for free — inherits Drive's story.
- Users' Drives already contain their Docs, PDFs, notes.
- OAuth is well-understood; no server-side account system needed on our end.
- Bonus: Drive gives version history for free.

### The catch: Google Docs aren't files

Regular Drive files (PDF, `.md`, `.txt`, images) are byte streams — trivial to
read/write via the Drive API. Google Docs/Sheets/Slides are stored in Google's
proprietary format. Three ways to handle them:

| Approach | UX | Effort |
|---|---|---|
| **A. Export-only** — treat every Doc as read-only (`files.export` → `.docx`/`.md`/`.html`) | Loses editability, or "edit creates a new file" | Low |
| **B. Docs API round-trip** — fetch structured content, render in our own editor, translate edits into `batchUpdate` ops | We own the editor experience, but implementing Docs' operation-based API against a WYSIWYG is a real editor project | High |
| **C. Embed the Google Docs iframe** for Doc-type files, use our own editors for everything else | Real collaborative editing, exactly what users expect from a Google Doc; ClawDoc becomes the organizer + rich shell | Low |

**C is almost certainly the right MVP.** ClawDoc = tree, tabs, search, previews,
non-Doc editing (Markdown/Excel/HTML), Claude sidekick. When a user opens a
Google Doc, embed `docs.google.com/document/d/<id>/edit` — they get the real
thing.

### Friction to plan for

- **OAuth scopes.** `drive.file` (only files our app opened via Picker) launches
  with zero verification but constrains browsing UX. `drive` (full access)
  requires Google's annual verification + security assessment for a public
  product. Not a blocker, but budget for it.
- **Change watching.** Drive push notifications need a public HTTPS webhook =
  server. Without one, we poll `changes.list` every N seconds. Fine for a
  document workspace, wouldn't scale to a 50K-file dev repo.
- **Latency.** Every read/write is an HTTP call; reindexing a large Drive is
  slow. Cache aggressively (Drive gives ETags + `changes.list` for
  invalidation).
- **Rate limits.** 10K req/user/100s on Drive v3; heavy reindex or watch loops
  need throttling.
- **Path model.** Drive is a graph — files can live in multiple folders,
  shortcuts exist. We'll synthesize a "primary parent" path for the tree.
- **Offline.** Doesn't work. Downloadable snapshot could — later.

### The generalizable framing: WorkspaceSource adapters

Don't build "a Google Drive connector" — build a **workspace-source adapter
interface** in ClawDoc:

```ts
interface WorkspaceSource {
  list(folderId): Promise<Entry[]>
  read(fileId): Promise<Blob | string>
  write(fileId, content): Promise<void>
  watch(callback): Unsubscribe
  search(query): Promise<Entry[]>
  render?(fileId): 'iframe' | 'native'   // for Doc-type embeds
}
```

Google Drive becomes one implementation. Dropbox, OneDrive/SharePoint (via MS
Graph), GitHub repos, S3 buckets, and — bringing it back — local FSA and the
current Node `fs` backend are all other implementations. Full ClawDoc keeps its
Node `fs` adapter; Light gets FSA + Drive + others. Same tree, same UI, different
sources.

That refactor is worth doing regardless of Light — it also cleans up the
current implicit coupling of `serve.js` to Node `fs`.

### Effort estimate for Drive adapter

- With the adapter abstraction in place: **~2–3 weeks** for a solid MVP (OAuth +
  browse + read/write + Doc iframe embed + polling watcher + basic caching).
- If we first need to refactor `serve.js` to a `WorkspaceSource` interface:
  add **~1–2 weeks**. Worth it.

### Sequencing suggestion

A Drive-connected **Full ClawDoc** (desktop app that mounts Drive as a workspace
source) would ship sooner than Light and reveal 80% of the design decisions
Light needs. Prove the adapter model in the environment where debugging is
easy, then port to the browser-only build.
