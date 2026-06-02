# stream-json protocol notes (M0 spike — #8)

Empirical capture against the **installed** CLI so M1–M9 code to reality, not docs.

- Binary: `/opt/homebrew/bin/claude`, `claude_code_version` **2.1.145**
- Invocation under test:
  `claude --input-format stream-json --output-format stream-json --verbose -p`
- Raw captures: `/tmp/clawdoc-spike/out.jsonl` (one-shot) and `ctrl.jsonl` (interactive).
  Re-run the spike to refresh; shapes are version-sensitive and **not** a frozen contract.

## Transport model (the important part)

- `--input-format stream-json` + `-p` does **not** exit after one answer. It reads
  newline-delimited JSON user frames from **stdin** and keeps the process alive.
- Each turn ends with a single `result` event. The session then **waits for the
  next user frame** on stdin. So: write a user frame → read events until `result`
  → repeat. This is the whole basis for the composer (M8) and lifecycle (M9).
- One JSON object per line on stdout (newline-delimited). Parse line-by-line;
  buffer partial lines.

## Output events (stdout), in observed order

| `type` | Notes |
|---|---|
| `system` (`subtype:"init"`) | First event. Carries `session_id`, `cwd`, `model`, `permissionMode`, `tools`, `mcp_servers`, `slash_commands`, `apiKeySource`, `claude_code_version`. Capture `session_id` for `--resume`. |
| `rate_limit_event` | Informational; safe to ignore in the renderer. |
| `assistant` | `message.content[]` is an array of blocks: `thinking` / `text` / `tool_use`. Stream may emit multiple assistant events per turn. |
| `user` | Echoed `message.content[]` containing `tool_result` blocks (the tool outputs). |
| `result` | End-of-turn. `subtype:"success"`, `is_error`, `result` (final text), `session_id`, `num_turns`, `permission_denials[]`, `usage`, `total_cost_usd`. |

### Block shapes (inside `message.content[]`)

```jsonc
// thinking
{ "type":"thinking", "thinking":"<text>", "signature":"<opaque>" }
// text
{ "type":"text", "text":"<markdown>" }
// tool_use
{ "type":"tool_use", "id":"toolu_…", "name":"Read",
  "input":{ "file_path":"/abs/path" }, "caller":{"type":"direct"} }
// tool_result (arrives on a `user` event, correlated by tool_use_id)
{ "type":"tool_result", "tool_use_id":"toolu_…",
  "content":"<string or array of {type:'text',text}>" }
```

Top-level wrapper fields seen on assistant/user events: `type`, `session_id`,
`parent_tool_use_id` (null for top-level; set for sub-agent/Task tool calls).

## Input frames (stdin)

One user turn:

```json
{"type":"user","message":{"role":"user","content":"<text>"}}
```

`content` also accepts the block-array form
(`[{"type":"text","text":"…"}]`). Newline-terminate each frame.

Interrupt: kill is the reliable cross-version stop; a clean interrupt control
frame exists in the SDK but was not relied on here. M8/M9 use child kill +
`--resume` to continue.

## Permissions — the risky bit (drives M6)

- In `-p` with `--permission-mode default`, a `Bash(echo …)` call **executed with
  no `control_request` and `permission_denials:[]`** — i.e. headless mode did
  not surface an interactive gate for it (default rules allowed it).
- So a raw-CLI client cannot assume it will be asked. Two workable levers:
  1. **`--permission-mode`** (`default` | `plan` | `acceptEdits` |
     `bypassPermissions`) chosen per session — the functional control for v1.
  2. **`--permission-prompt-tool mcp__<server>__<tool>`** — route every gate to a
     small MCP tool we host that round-trips the decision to the UI. This is the
     path to true inline Allow/Deny on the CLI engine.
- The SDK's `can_use_tool` control protocol (`control_request` →
  `control_response` with `{behavior:"allow"|"deny", updatedInput?, message?}`)
  is the cleanest, but is the SDK's surface, not guaranteed on raw CLI in this
  mode — captured as the M21/SDK follow-up.

### M6 decision (v1)

Implement, in order of certainty:
1. A **permission-mode selector** in the rich panel (passed as `--permission-mode`).
2. Render `permission_denials` from each `result` as inline system notices.
3. A **defensive `control_request` handler** in the transport: if the CLI ever
   emits `can_use_tool`, render inline Allow / Allow-always / Deny and reply with
   a `control_response`. No-op if the events never come — forward-compatible.

Full guaranteed inline gating → revisit with the Agent SDK (#21).
