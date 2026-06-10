# ClawDoc vs. Claude Desktop vs. Claude Cowork

**Status:** Competitive positioning
**Last updated:** 2026-06-06

A three-way analysis of ClawDoc against Anthropic's two first-party desktop
surfaces: **Claude Desktop** (the chat-first app) and **Claude Cowork** (the
local-folder agent launched January 2026). Cowork is the comparison that
matters — it ships ClawDoc's core thesis as a first-party feature — so this doc
is written Cowork-first and honest about where the defensible wedge actually is.

---

## TL;DR

- **Claude Desktop** = talk to Claude; attach files into the conversation.
- **Claude Cowork** = *delegate* a task; an autonomous agent works your local
  folders (and your screen, browser, phone) and hands back a finished deliverable.
- **ClawDoc** = a document *workspace you inhabit* — a rendered, editable file
  tree with full-text search, git history, and the Claude Code agent on tap,
  running local-first and model-agnostic.

Cowork commoditized "an agent that touches your local files." ClawDoc can no
longer win on that. Its surviving wedge is three things Cowork structurally is
not: **(1) a document browser/editor you work *in*** rather than delegate *to*;
**(2) local-first + bring-your-own-model + open-source**; **(3) per-document git
history and full-corpus search.**

---

## 1. The three paradigms

| | Claude Desktop | Claude Cowork | ClawDoc |
|---|---|---|---|
| **Center of gravity** | The conversation | The delegated task | The document on disk |
| **You are…** | chatting | handing off | working in your files |
| **The agent is…** | an assistant in a thread | an autonomous coworker | a collaborator on tap |
| **Metaphor** | messaging app w/ attachments | a digital employee | an agentic IDE for documents |
| **Primary verb** | *ask* | *delegate* | *browse / edit / produce* |

Desktop and Cowork are both **chat-driven**: you type intent into a prompt.
ClawDoc is **document-driven**: you navigate and render a corpus, and the agent
is summoned next to whatever you're looking at. That inversion is the whole
story.

---

## 2. What Cowork actually is (the real competitor)

Cowork brings the **Claude Code / Claude Agent SDK** engine to non-technical
knowledge work, inside the Claude macOS app:

- **Persistent agent in a sandboxed Linux VM** on your Mac, isolated from the host.
- **Scoped local filesystem access** — reads/edits/creates files only inside
  user-selected folders.
- **Generates business formats** — Excel with formulas, PowerPoint, Word, PDF
  extraction, multi-file research synthesis.
- **Computer Use** — eyes/hands on the host GUI, can drive other apps.
- **Claude in Chrome** — the agent "steps out" to the web to verify/fetch.
- **Dispatch** — fire tasks from your phone to the desktop agent.
- **All paid plans**, macOS-first (Windows rolling out), MCP connectors + plugins.

This erases most of ClawDoc's advantages over *vanilla Desktop*: local-folder
access, scoped permissions, the real agent, generating DOCX/XLSX/PPTX. Treat
Cowork — not Desktop — as the benchmark.

---

## 3. Feature matrix

| Capability | Claude Desktop | Claude Cowork | ClawDoc |
|---|---|---|---|
| **File access** | Upload to cloud, or local via filesystem MCP | Scoped local folders, direct | Direct from disk; agent cwd'd to the open doc |
| **Document browser UI** | None | None (chat panel) | **Drive-style tree, dual-pane, quick-open** |
| **Native rendering** | Parses for the model | Produces files; limited in-app viewing | **Renders MD/HTML/PDF/DOCX/XLSX/CSV/images** |
| **In-app editing** | In chat / Artifacts | Agent edits, you don't hand-edit in-app | **WYSIWYG editors round-trip to the real file** |
| **The agent** | Assistant + tools | **Autonomous Claude Code agent** | **Claude Code agent** (PTY + rich client) |
| **Autonomy** | Turn-by-turn | **Multi-step, parallel subtasks, plans** | Turn-by-turn, human-in-the-loop |
| **Reach beyond files** | Web search, analysis tool | **Computer Use + Chrome + phone Dispatch** | Files + agent only |
| **Full-text corpus search** | Project knowledge only | No browse/search index | **BM25 across all workspaces + PDF text** |
| **Versioning** | None | None per-document | **Built-in git auto-commit + history/diff** |
| **Model choice** | Anthropic only | Anthropic only | **Anthropic / OpenRouter / Gemini / local Ollama** |
| **Privacy** | Files to cloud | Files local; reasoning + Computer-Use to Anthropic | **App uploads nothing; can run fully local** |
| **Sandbox/isolation** | N/A | **Sandboxed Linux VM** | Runs on host (single-user local tool) |
| **Access / cost** | Paid plan | All paid plans | Existing `claude` login or any endpoint; **OSS (AGPL)** |
| **Extensibility** | MCP connectors | MCP connectors + plugins | **Claude Code skills** + MCP |
| **Distribution** | Signed, auto-update, supported | Signed, auto-update, supported | Unsigned today, no auto-update |
| **Platforms** | Mac/Win/web/mobile | macOS-first (Win rolling) | macOS + Windows builds |

---

## 4. ClawDoc's surviving advantages

Against Cowork specifically, the list is shorter than it was against Desktop —
but each item is real and structural.

**1. A workspace you inhabit, not a task you delegate.**
Cowork is "hand it off, get a deliverable back." It has no document
browser/editor surface — you don't *navigate* your corpus or *hand-edit* a
spreadsheet cell in it. ClawDoc is the opposite ergonomic: render the tree,
open the DOCX in a paginated page view, edit the XLSX directly, scan diffs,
and call the agent for the parts you want delegated. For people who want to
**stay in the loop on the document itself**, that's a different product, not a
worse one.

**2. Local-first, and genuinely model-agnostic.**
Cowork keeps files local but routes reasoning (and Computer-Use screenshots) to
Anthropic's cloud, on Anthropic models, behind a paid plan. ClawDoc's *app*
uploads nothing, and the agent can target OpenRouter, Gemini, or **fully local
Ollama**. For regulated, air-gapped, or cost-sensitive users, "no content leaves
the machine and you choose the model" is a category Cowork can't enter without
becoming a different product.

**3. Per-document git history + full-corpus search.**
Every edit auto-commits with a diff/history viewer; BM25 full-text search spans
all workspaces including extracted PDF text — both offline. Neither exists in
Cowork.

**4. Open-source and skill-extensible.**
AGPL-3.0, auditable, self-hostable, extended via Claude Code skills (proposal /
RFP / deck generators) rather than a closed connector marketplace.

---

## 5. Where the Anthropic products win (honest)

- **Cowork's autonomy and reach** — multi-step parallel execution, plus Computer
  Use, Chrome, and phone Dispatch. ClawDoc is files + agent, human-in-the-loop.
- **Sandbox isolation** — Cowork's Linux VM is a real security boundary; ClawDoc
  runs on the host as a single-user local tool.
- **Polish & trust** — both Anthropic apps are signed, auto-updating, supported.
  ClawDoc ships unsigned (Gatekeeper workaround) with no auto-update yet.
- **Zero setup & distribution** — Cowork is bundled into every paid plan; ClawDoc
  assumes a working `claude` CLI or a configured endpoint.
- **Continuity** — Desktop syncs across desktop/web/mobile; Cowork adds phone
  control. ClawDoc is a single local app.

---

## 6. Strategic read

**Cowork is the existential question for ClawDoc's positioning.** "Agent in your
local folders for non-coders" is now Anthropic's framing too — bundled free into
every paid plan, built on the same Agent SDK, with reach (Computer Use, Chrome,
Dispatch) ClawDoc can't match. ClawDoc **cannot win on "agent touches local
files"** anymore; that is commoditized by the platform owner.

What ClawDoc can win on:

1. **Being the document workspace itself** — the render/edit/browse/search/version
   surface that Cowork deliberately doesn't have. Cowork *produces* documents;
   ClawDoc is a place to *work in* them. Lean into the IDE-for-documents identity,
   not the agent identity.
2. **Local-only + bring-your-own-model + open-source** — the privacy, sovereignty,
   and cost story Cowork can't tell. This is the clearest non-overlapping wedge.
3. **Human-in-the-loop control** — for high-stakes documents (proposals, pricing,
   legal), "I drive, the agent assists, every change is a reviewable git diff"
   beats "delegate and trust the autonomous output."

The old "ClawDoc vs. Claude Desktop" pitch reads as outdated to anyone who knows
Cowork exists. The defensible pitch is narrower and sharper:

> **Cowork delegates work on your files to Anthropic's cloud. ClawDoc is the
> local, model-agnostic, open-source workspace where you actually browse, edit,
> version, and search your documents — with an agent on tap, and nothing leaving
> your machine.**

---

*Maintained alongside `docs/why-not-fork-vscode.md`. Update when Anthropic ships
Cowork changes that move the wedge (e.g. an in-app document browser/editor, local
model support, or a free tier).*
