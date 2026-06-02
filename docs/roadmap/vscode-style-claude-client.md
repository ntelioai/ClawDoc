# Rich Claude client inside ClawDoc

How to give ClawDoc a structured, VSCode-extension-like Claude experience —
rendered tool calls, diff views, inline permission prompts, message bubbles,
file/line links — **without** giving up the PTY terminal we already ship.

## Starting point

ClawDoc today is Electron + `node-pty` + WebSocket. The **Claude** button
([`#chat-toggle`](../../app/index.html#L40)) opens a right-side panel that pipes
a real `claude` PTY (spawned in [serve.js](../../serve.js#L1016) via
`findClaudeBinary()` over the `/terminal` WebSocket) into xterm.js. It renders
the actual TUI byte-for-byte and inherits the user's existing `claude` login,
MCP servers, settings, hooks, skills, slash commands, and permission modes —
all for free, because it's the user's own binary.

The PTY terminal is good. The goal here is **not to replace it** but to build a
second, structured front-end next to it and let them be compared head-to-head.

## Build strategy: two buttons, zero regression

- Keep the **Claude** (PTY) button exactly as-is. It stays the default and the
  fallback. We touch none of its code paths.
- Add a second button — **Claude ✦** (working name "Rich") — that opens a
  separate panel driving a structured conversation renderer.
- Both panels can be open at once, so the comparison is genuine: same engine,
  same workspace, two front-ends, side by side.

This de-risks the whole effort. If the rich client is worse on some axis, the
PTY is one click away and never regressed.

## The honest landscape

**The VSCode extension itself is not open source.** Anthropic ships the Claude
Code CLI as the engine; the VSCode/JetBrains extensions are closed-source thin
clients that talk to the CLI over a local IPC (the same protocol behind
`--ide`). There is nothing to fork.

What *is* available to build on:

| Project | Stack | What it gives you |
|---|---|---|
| **`claude` CLI** with `--output-format stream-json --input-format stream-json` | any | Same typed message stream the SDK uses, over stdio, from the **user's already-installed, already-authed binary**. Recommended engine. |
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | TS / Python | Official. Wraps a (bundled) CLI, streams typed messages, exposes a first-class `canUseTool` hook. Cleaner API, but a *second, separately-versioned engine* — see the caveat below. |
| **[opcode](https://github.com/getAsterisk/opcode)** (formerly Claudia) | Tauri + React | Most polished OSS GUI: tool cards, sessions, MCP config, checkpoints. **AGPL** — same license as ClawDoc, so vendoring is fully compatible. UX reference. |
| **[Crystal](https://github.com/stravu/crystal)** | Electron + React | Closest architectural match to ClawDoc; multi-session Claude Code manager. Apache-2.0. Architectural reference. |
| **claude-code-chat** (Andre Pimenta) | TS + webview | MIT. Minimal example of rendering the stream-json event types. |
| **`coder/claudecode.nvim`, `claude-code-ide.el`, Zed** | various | Third-party editors that **reimplemented the `--ide` bridge** by speaking its WebSocket protocol — proof the bridge is replicable (see "IDE bridge" below). |

## Two goals that are often conflated

The "VSCode feel" is really **two independent products** with very different
costs. Earlier framing bundled them; they should be sequenced separately.

- **Goal A — rendered conversation UI** (message bubbles, tool cards, diffs,
  inline permissions). Genuinely requires a typed event stream
  (stream-json/SDK). This is what the second button delivers.
- **Goal B — editor integration** (native diff tabs, current-selection as
  context, file/line links, at-mentions). Does **not** require touching the
  conversation pane. It's the `--ide` bridge — and it can keep the PTY.

Treat them as parallel tracks, not one monolith.

## Recommended engine: the CLI in stream-json mode

Spawn the **same** `claude` binary the PTY uses (`findClaudeBinary()`), but with
`--output-format stream-json --input-format stream-json`. A new `/agent`
WebSocket relays the typed events to the renderer; user turns go back as
stream-json input frames.

Why this over embedding the Agent SDK, for *v1 specifically*:

- **Apples-to-apples comparison.** Same binary, same version, same auth, same
  MCP/settings as the PTY button. The only variable under test is the
  front-end. Embedding the SDK introduces a second, independently-versioned
  engine and muddies exactly the comparison this whole effort exists to make.
- **No new auth/distribution surface.** We already locate and trust the user's
  binary.

The SDK remains the better long-term API (its `canUseTool` hook is cleaner than
hand-rolling the stdio permission protocol). Revisit it once the renderer is
proven — it's an engine swap behind the same renderer, captured as its own
issue. Keep `node-pty` only for the existing PTY button.

## What the rich client has to build

In roughly increasing effort:

1. **Stream transport + parser** — `/agent` WebSocket, spawn claude in
   stream-json mode, relay typed events; send user input as stream-json frames.
2. **Message rendering** — assistant text as streamed markdown bubbles, user
   bubbles. Biggest visual win, mostly a render job. `marked` is already loaded.
3. **Tool-use cards** — `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` /
   `Task` etc. as collapsible cards, each with its own affordance, with the
   matching `tool_result` folded underneath.
4. **Diff view for Edit/Write** — `diff2html` is **already loaded** in
   [index.html](../../app/index.html#L190); render the edit's patch inside the card.
5. **Inline permission prompts** — Allow / Allow always / Deny buttons rendered
   in the conversation, wired to the stdio permission control request (or, if we
   later move to the SDK, the `canUseTool` hook).
6. **File/line links** — `path:42` becomes clickable and opens the doc in
   ClawDoc's existing viewer/nav. This is where ClawDoc beats a plain terminal.
7. **Input composer** — textarea, send, stop/interrupt, `@`-path insert (reuse
   the existing workspace-rooting + path logic from the PTY panel), queueing
   while a turn is running.
8. **Session lifecycle** — resume, restart, exit/error states, workspace
   rooting at parity with the PTY panel.

Optional polish: todos checklist, thinking-block rendering, slash-command
palette, MCP config UI, checkpoint/rewind (opcode has this).

## Caveats — read before committing

- **You inherit the REPL surface you give up.** stream-json `--print` mode is
  headless. Everything the interactive TUI gives free — slash commands,
  permission modes, plan mode, interactive prompts — must be re-exposed in the
  rich client or it's simply absent. Budget for this; it's the bulk of the
  hidden cost, and it's the main reason the PTY button stays.
- **Maintenance treadmill.** The PTY renders whatever the CLI emits, including
  features that don't exist yet. A structured renderer must be updated for every
  new tool type or event shape Anthropic ships, or it degrades to "unknown tool"
  cards. This is an ongoing cost, not a one-time build.
- **stream-json is not a frozen public contract.** Event shapes change between
  CLI versions. Pin/scope to the installed version, and start with a spike that
  captures the *actual* event schema rather than coding to docs. (The SDK
  absorbs some of this churn — a point in its favor later.)
- **Permission protocol is the riskiest unknown.** The exact stdio control-
  request mechanism for routing permission decisions back to the client needs to
  be nailed down empirically in the spike before the permission-UI issue starts.
- **Engine drift if you choose the SDK.** The SDK bundles its own CLI; its
  version may differ from the user's installed `claude`. Fine for production,
  bad for an apples-to-apples comparison — hence CLI-first.

## The IDE bridge — the higher-leverage track (Goal B)

Earlier analysis claimed the `--ide` bridge "can't be cleanly replicated." That
is wrong, and correcting it matters. The bridge is just a lockfile in
`~/.claude/ide/<port>.lock` advertising a local WebSocket/MCP server the CLI
auto-connects to. The protocol isn't *officially* documented, but it has been
reimplemented by non-Anthropic editors — `coder/claudecode.nvim`, Emacs
`claude-code-ide.el`, Zed — none of which forked the extension; they spoke the
protocol.

That bridge is what delivers the genuinely VSCode-like half of the wishlist:
`openDiff` (a native diff tab for every Edit/Write), current-selection and
open-file as context, at-mention — **all while keeping the interactive PTY
terminal.** It does not require rendering a single message bubble.

So the diff view and file-link goals are reachable two ways: inside the rich
renderer (Goal A), *or* through the bridge over the existing terminal (Goal B).
The bridge is lower-effort for that specific value and loses nothing. It is the
recommended *first* differentiator once the rich client lands — tracked as its
own epic.

## Roadmap / milestones

These map 1:1 to the GitHub issues under the `rich-client` epic.

- **M0 — Spike**: capture the real stream-json event schema and permission
  control protocol for the installed CLI version.
- **M1 — Transport**: `/agent` WebSocket + stream-json spawn + relay.
- **M2 — Shell**: second button + second panel, independent of the PTY panel.
- **M3 — Render core**: message bubbles + streaming markdown.
- **M4 — Tool cards** + tool_result folding.
- **M5 — Diff view** (diff2html) for Edit/Write.
- **M6 — Inline permissions**.
- **M7 — File/line links** into the ClawDoc viewer.
- **M8 — Composer**: input, stop, @-insert, queueing.
- **M9 — Lifecycle**: resume/restart/exit/error + workspace rooting parity.
- **M10 — Polish**: theme parity, todos, thinking blocks, a11y.
- **M11 — Docs**: README + a comparison checklist for evaluating PTY vs rich.
- **Epic B (parallel) — IDE bridge**: lockfile + WS server, `openDiff`,
  selection/open-file context, at-mention — over the existing terminal.
- **Later — SDK engine swap**: evaluate `@anthropic-ai/claude-agent-sdk` behind
  the same renderer once Goal A is proven.

## Effort estimate

- **Rich client to visual parity** with the VSCode extension's *feel* (M1–M9):
  ~2–3 weeks for one engineer — higher than a naive estimate because re-exposing
  the REPL surface (slash commands, modes, prompts) is real work, not polish.
- **IDE bridge (Epic B)**: ~1 week for diff tabs + selection context; this is
  the cheapest path to the most VSCode-like value and is independent of the
  above.
- Both are bounded by the **maintenance treadmill** noted in the caveats — plan
  for ongoing upkeep, not a one-shot delivery.

## Status — what shipped

M0–M11 landed behind the **Claude ✦** button (the PTY **Claude** button is
untouched). Engine: the same `claude` binary in stream-json mode over a new
`/agent` WebSocket. Implemented: streamed message bubbles, collapsible tool
cards with folded results, inline diffs for Edit/Write/MultiEdit, a
permission-mode selector + defensive `can_use_tool` handler, clickable file
links into the viewer, a composer with send/stop/queue/@-insert, and
restart/resume lifecycle. Protocol capture: `stream-json-notes.md`.

Known gaps (by design, for now): no slash-command palette, no plan-mode UI, and
true *interactive* per-call Allow/Deny depends on the CLI emitting
`can_use_tool` (it didn't in the tested modes — the mode selector is the
functional control). These are the REPL-surface caveats above, made concrete.

## PTY vs rich — comparison checklist

Use this rubric to decide whether the rich client graduates from experiment to
default. Open both panels on the same workspace and score each axis.

| Axis | PTY (**Claude**) | Rich (**Claude ✦**) | Notes |
|---|---|---|---|
| First-token latency / feel | | | Subjective; rich adds a render layer. |
| Slash-command / REPL coverage | full | partial | Rich has none yet. |
| Permission UX | native TUI prompts | mode selector + denial notices | Rich lacks live per-call gate on this CLI version. |
| Plan mode | full | mode flag only | |
| Diff readability | ANSI in terminal | rendered diff2html card | Rich should win. |
| Tool legibility (Read/Bash/Grep…) | scrollback text | labeled collapsible cards | Rich should win. |
| File-link usefulness | none | click → opens doc in ClawDoc | Rich-only differentiator. |
| Multi-turn / interrupt | native | send/stop/queue | Verify interrupt actually aborts. |
| Failure modes (spawn fail, exit, resume) | parity target | parity target | |
| Maintenance cost | ~zero (renders raw TUI) | per new tool/event type | Structural; see caveats. |

Graduation bar: rich must win clearly on diff/tool/file-link legibility **and**
reach acceptable parity on latency and failure handling, *without* a REPL-
coverage gap that blocks real work. Until then it ships as the experimental
second button.
