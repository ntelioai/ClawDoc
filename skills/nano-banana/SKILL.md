---
name: nano-banana
description: "Generate or edit image assets with Gemini's image models ('nano banana') — hero images, diagrams, product shots, logo composites — written straight to a file. Use when a document, deck, or page needs an image asset that doesn't exist yet."
trigger: /nano-banana
---

# /nano-banana

Generates or edits images with Gemini's image-generation models via `nano_banana.py`.
Credentials live in ClawDoc's own settings (Settings → Gemini tab), not in this skill —
so nothing secret ships in this repo.

```bash
python3 ~/.claude/skills/nano-banana/nano_banana.py "<prompt>" --out path/to/file.png
python3 ~/.claude/skills/nano-banana/nano_banana.py "<edit instruction>" --ref existing.png --out path/to/edited.png
```

`--ref` (repeatable) attaches existing images — a logo, a product photo, a brand
background — for the model to compose, restyle, or edit alongside the prompt. Order
matters: mention references in the same order in the prompt ("the logo from the first
image on the mug from the second").

**This skill ships inside ClawDoc**, under `skills/nano-banana/`, so it travels with
that repo. On a new machine: clone ClawDoc, then `node scripts/install-skills.js` —
that symlinks `~/.claude/skills/nano-banana` at the checkout, and every later
`git pull` updates the skill in place.

**No API key configured** → the script exits with the exact fix: open ClawDoc →
Settings → Gemini and paste one. Don't try to work around this by asking for a key in
chat or hardcoding one — it belongs in that one settings.json field (mode 0600).

**If ClawDoc's own server is running** for this workspace, `POST
http://localhost:$CLAWDOC_PORT/api/gemini/generate-image` (`{prompt, path, refs?,
model?}`, `path`/`refs` are workspace-prefixed, e.g. `"Business/Products/cartaja/
assets/hero.png"`) does the same generation but writes through ClawDoc directly, which
also queues the file for auto-commit if the workspace has that on. `$CLAWDOC_PORT` is
set in every terminal ClawDoc spawns. Prefer the CLI script when you're not sure
whether a server is up, or when writing outside a tracked workspace — it always works.

## Writing the prompt

This is the part that actually determines output quality — the API call is trivial by
comparison. Gemini's image models respond to **a short descriptive paragraph**, not a
comma-separated keyword list. Cover, in prose, whatever of these is relevant:

- **Subject and action** — what's actually in frame, doing what.
- **Composition/framing** — full shot, close-up, isolated on white, flat-lay, etc.
  There's no aspect-ratio parameter in this API path, so state it in words if it
  matters ("wide 16:9 banner", "square social tile").
- **Style/medium** — photograph, flat vector illustration, 3D render, line art,
  watercolor — pick one; "photorealistic" and "cartoon illustration" pull in
  conflicting directions if both are present.
- **Lighting, palette, mood** — especially for anything going into a deck or brand
  page, where it has to sit next to other assets.
- **Exact text**, quoted verbatim, if the image must contain text (a label, a sign, a
  logo wordmark) — nano banana renders in-image text reasonably well but only from an
  explicit quote, never from paraphrase.
- **What must NOT change**, when editing via `--ref` — name the parts of the reference
  to keep untouched as well as the parts to change; an edit prompt that only describes
  the change tends to also drift on everything else.

Treat the first result as a draft. If something's off, don't hand-tune pixels — refine
the sentence that described that part and regenerate; that's almost always faster and
more reliable than iterating with vague "make it better" follow-ups.

**Before generating from scratch**, check whether the workspace already has a brand
asset that should be reused or edited instead (a canonical logo, cover graphic, product
shot) — ask if unsure which one is canonical rather than guessing.

## Where output goes

No fixed convention across workspaces — save next to the document that will use it,
in that project's existing `assets/` folder if it has one, with a descriptive
kebab-case filename (`hero-dashboard-dark.png`, not `image1.png`). Match the file
extension to the format you asked for (`.png` unless there's a reason for `.jpg`/
`.webp`).

## Rules

- **Never print or log the API key.** It's read from settings.json and used in-memory
  only; don't echo it, don't put it in a generated file, don't paste it into chat.
- **This is spend, not free** — one call per asset you actually need, not a batch of
  variations "to see what comes out." If you want options, say so and ask first.
- **ClawDoc is a public repo.** This skill's source lives there — code and prompting
  guidance only. Generated images, workspace paths, and brand specifics belong in the
  workspace, never committed back into this skill's own folder.
