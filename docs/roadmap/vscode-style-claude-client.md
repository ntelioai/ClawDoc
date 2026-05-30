# VSCode-style Claude Code client inside ClawDoc

Analysis of what it would take to upgrade ClawDoc's embedded Claude Code experience from a raw PTY terminal to a rich client comparable to the VSCode extension (rendered tool calls, diff views, inline permission prompts, message bubbles, file/line links).

## Starting point

ClawDoc today is Electron + `node-pty` + WebSocket, piping a `claude` PTY into xterm.js. The question is how to move from terminal coloring to a structured, rendered conversation UI.

## The honest landscape

**The VSCode extension itself is not open source.** Anthropic ships the Claude Code CLI as the engine; the VSCode/JetBrains extensions are closed-source thin clients that talk to the CLI over a local IPC (the same protocol that powers `--ide`). So there is nothing to fork.

What *is* available to build on:

| Project | Stack | What it gives you |
|---|---|---|
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | TS / Python | Official. Runs the agent loop in-process, streams typed messages (`assistant`, `tool_use`, `tool_result`, `permission_request`). The correct primitive for a custom UI. |
| **`claude` CLI with `--output-format stream-json --input-format stream-json`** | any | Same message stream as the SDK, but over stdio. Lets you keep using the binary you already spawn. |
| **[opcode](https://github.com/getAsterisk/opcode)** (formerly Claudia) | Tauri + React | Most polished OSS GUI. Renders tool calls, sessions, MCP config, checkpoints. AGPL — license-compatible with ClawDoc. UX reference. |
| **[Crystal](https://github.com/stravu/crystal)** | Electron + React | Closest architectural match to ClawDoc. Multi-session Claude Code manager. Apache-2.0. Architectural reference. |
| **claude-code-chat** (VSCode webview by Andre Pimenta) | TS + webview | MIT. Smaller surface — useful as a minimal example of rendering the stream-json event types. |
| **claude-squad / claunch** | terminal TUIs | Not useful here — terminal-native. |

## What ClawDoc would need to build

The conceptual shift: **stop rendering a PTY, start rendering a message stream.** The VSCode-like feel comes from five pieces, in roughly increasing effort:

1. **Stream parser.** Replace PTY + xterm for the conversation pane with `claude -p --output-format stream-json --input-format stream-json` (or embed the Agent SDK in the Electron main process). Typed event stream instead of ANSI bytes.
2. **Message rendering** — assistant text as markdown, `tool_use` as collapsible cards (Read / Edit / Bash / etc., each with its own visual), `tool_result` folded under, todos as a checklist panel. Biggest visual win; mostly a React/HTML job.
3. **Diff view for Edit/Write.** `diff` is already a dep. Render unified or side-by-side inside the Edit card. opcode and Crystal both do this.
4. **Permission prompts as inline UI** instead of stdin questions — intercept `canUseTool` (SDK) or permission-request events and render Allow / Allow always / Deny buttons in the conversation.
5. **File/line links.** When the assistant emits `path:42`, make it clickable and open the doc inside ClawDoc — this is where ClawDoc's existing browser pane becomes the differentiator vs. VSCode.

Optional later: session list + resume (`--resume`), MCP server config UI, checkpoint/rewind (opcode has this), thinking-block rendering, slash-command palette.

## Recommendation

Given ClawDoc is already Electron + Node, the lowest-friction path is:

- **Embed the Agent SDK in the main process** (not the CLI subprocess). Avoids PTY/JSON-stream parsing entirely and gives first-class `canUseTool` hooks for permission UI.
- **Crystal as the architectural reference** (same stack, same idea, permissive license).
- **opcode as the UX reference** (better-looking, more features; AGPL — be aware if vendoring code).
- Keep `node-pty` only for Bash tool output streaming inside tool-result cards — not for the whole conversation.

## Effort estimate

- **Core parity** with the VSCode extension's *feel* (message stream, tool cards, diffs, inline permissions, file links): ~1–2 weeks for one engineer.
- **Full parity** (checkpoints, MCP UI, slash-command discovery, IDE selection bridge): ~4–6 weeks.

## What can't be cleanly replicated — and the opportunity

The VSCode extension's `--ide` bridge exposes the editor's open files / selection / diagnostics back to Claude. ClawDoc can't replicate that bridge, but the *ClawDoc-flavored* version — exposing the currently-open doc and selection from the doc browser as context — is arguably the more interesting product than mimicking VSCode.
