# Why ClawDoc Is Built From Scratch (and Not a VS Code Fork)

**Status:** Architecture rationale
**Last updated:** 2026-06-03

A recurring question: ClawDoc is an Electron app with a file tree, a terminal,
git integration, and multi-format rendering — wouldn't it have been smarter to
fork VS Code (Code-OSS), the way Cursor and Windsurf did, instead of building
the whole thing from the ground up?

Short answer: **no.** Forking VS Code would be both overkill and
off-strategy. Building from scratch was the right call. Three reasons.

---

## 1. Forking VS Code imports the exact identity ClawDoc is defined against

ClawDoc's wedge is **doc-shaped, not code-shaped.** The positioning is explicit
that Cursor and Zed *lose* in this space precisely because they are code editors
that happen to render Markdown — high-friction for non-coders, AI as a chat
sidecar rather than an agent in the folder, no native multi-format rendering.

A VS Code fork makes ClawDoc *become the thing it beats.* The engineering effort
goes into **subtracting** IDE-ness — hiding the command palette, the gutter, the
code-editor chrome, the "open folder as workspace" mental model — instead of
**adding** doc-browser value. That is the worst kind of fork: one where the base
actively pulls against the differentiation.

## 2. ClawDoc is ~11k LOC of first-party code. That is the decisive fact.

```
serve.js        1,687   PTY + git + file server
app.js          5,893   frontend
style.css       2,494
+ electron-main.js, git.js, github.js, index.js
─────────────────────
~11,400 LOC first-party
```

Every line is owned and understood. A VS Code fork is a **six-figure-LOC
liability that must be rebased against upstream forever** — Cursor and Windsurf
each run a dedicated team just to stay merged with Code-OSS. Taking on that
permanent maintenance tax to acquire capabilities ClawDoc mostly does not need
is a bad trade. Lean-and-owned beats huge-and-borrowed here.

## 3. What VS Code would provide, ClawDoc already has or does not want

| VS Code gives you | ClawDoc's reality |
|---|---|
| Cross-platform packaged builds | Already have it — `electron-forge` with makers for dmg/deb/rpm/squirrel |
| Git integration | Already have it, and better-fit — `isomorphic-git` with auto-commit as the *default*, which is a core wedge |
| Integrated terminal | Already have it via `node-pty`, and it auto-cwd's to the open document — the whole point |
| Extension ecosystem | Wrong ecosystem. The network-effect play is **Claude Code skills** (proposals / RFP / decks), not `.vsix` plugins |
| Monaco rich-text editor | ClawDoc doesn't edit code. It *renders* (pandoc / superdoc / univer) and lets the agent write files. A different editing surface entirely |

The overlap between "what a VS Code fork provides" and "what ClawDoc's core is"
is nearly empty. The core is **renderer + agent PTY + git-as-default** — none of
which is what VS Code is good at handing you.

---

## When forking *would* have been the right call

If ClawDoc's heart were a text/code editing surface — LSP, debugging,
multi-cursor, refactoring — then forking would make sense: don't reinvent Monaco
and the extension host. But ClawDoc is a **document browser with an agent in the
folder.** Editing is deliberately offloaded to Claude Code and to rendered
views, so it sidesteps most of what editors are genuinely hard at — simply by
not being one.

## The surgical hedge

If a specific VS Code capability is ever genuinely needed — say a great raw-Markdown
edit mode — embed **Monaco as a library** (`monaco-editor`, MIT-licensed,
npm-installable). That gets the one good part without forking the whole
cathedral. That is the move when a real gap appears — not a fork.

---

## Bottom line

The result of building from scratch is a tight, strategically coherent ~11k-LOC
app that owns its destiny and matches its own positioning. Forking VS Code would
have cost more, locked ClawDoc into a code-shaped identity it explicitly rejects,
and handed it an ecosystem it does not want. Stay scratch; reach for libraries
surgically when a real gap appears.
