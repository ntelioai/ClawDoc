---
name: crm
description: "Personal sales-pipeline CRM over ~/crm.sqlite — query the pipeline, update deals, capture todos/actions against the right deal, log activity, regenerate the funnel snapshot, serve the dashboard, draft follow-ups"
trigger: /crm
---

# /crm

One skill for the whole sales pipeline. The database is `~/crm.sqlite`; everything
else — funnel JSON, dashboards, PDFs — is derived from it.

Run everything through `crm.py`. Do not hand-write SQL for operations it already
covers, and never hand-edit `funnel.json`.

```bash
python3 ~/.claude/skills/crm/crm.py <command> [--db PATH]
```

`--db` defaults to `~/crm.sqlite` (override with `$CRM_DB`).

**This skill ships inside ClawDoc**, under `skills/crm/`, so it travels with that repo.
On a new machine: clone ClawDoc, then `node scripts/install-skills.js` — that symlinks
`~/.claude/skills/crm` at the checkout, and every later `git pull` updates the skill in
place.

**Per-machine settings live outside the repo** in `~/.config/crm/config.json` (override
its location with `$CRM_CONFIG`) — any subset of:

```json
{"db": "~/crm.sqlite", "app_dir": "~/CRM/app", "archive_dir": "~/CRM/archive",
 "clawdoc_json": "...", "owner": "you"}
```

Precedence is **env var > config file > default**, per setting: `CRM_DB`, `CRM_APP_DIR`,
`CRM_ARCHIVE_DIR`, `CRM_CLAWDOC_JSON`, `CRM_OWNER`. Defaults are `~/crm.sqlite` and
`~/CRM/{app,archive}`; `owner` falls back to your login name, and `clawdoc_json`
auto-resolves to the enclosing checkout's `settings.json`, else the packaged app's
userData dir. `crm.py doctor` prints what actually resolved — start there when a path
looks wrong, and fix it in the config file rather than in this repo.

## Usage

```
/crm                          # status + open pipeline
/crm <org or deal>            # everything about one deal
/crm update <what happened>   # apply an update, then report what changed
/crm <an action, in words>    # captured as a todo against the right deal
/crm todos                    # what's open, what's overdue
/crm review                   # weekly review: stale deals, missing next steps, due tasks
/crm follow up <org>          # draft the outbound message from deal state
/crm funnel                   # regenerate + archive the snapshot
```

## The three surfaces

| Surface | What it is | When |
|---|---|---|
| **`crm.py`** (this skill) | Reads and writes the sqlite directly. The only surface that can change data. | Always, for anything that mutates. |
| **ClawDoc** — [crm.js](../../crm.js), routes in [serve.js](../../serve.js) | `/crm/dashboard` + `/crm/report`, backed by `GET /api/crm/funnel.json` which queries the DB **live**. Settings at `/api/crm/settings` (`{enabled, dbPath}`), schema auto-init on first enable. Same repo as this skill — a change to one is a candidate change to the other. | The normal way to *look* at the pipeline. No regen step. |
| **Standalone** — `$CRM_APP_DIR` (`app_dir` in the config file) | `index.html` + `report.html` fetching a static `funnel.json`. Same two files as ClawDoc's, with the fetch target swapped. | Offline, printing, and the dated archive trail. |

ClawDoc's `getFunnel()` and this skill's `build_funnel()` produce the same payload
shape from the same policy — keep them in sync if either changes.

## Commands

**Read**

| | |
|---|---|
| `status` | counts, raw and weighted totals, by status and by stage |
| `pipeline [--stage S] [--org N]` | open deals ranked by weighted value |
| `deal <id\|org\|title>` | one deal: terms, custom fields, tasks, activity, notes, attachments |
| `tasks [--overdue]` · `activity [-n N]` | open todos / recent activity |
| `orgs` · `contacts [--org N]` | accounts with open pipeline / people |
| `sql "<query>"` | escape hatch; read-only unless `--write` |
| `doctor` | snapshot drift, ClawDoc config, data hygiene |

Read commands take `--json` where a machine-readable dump is more useful.

**Write**

| | |
|---|---|
| `add-deal --org O --title T [--contact C --value N --stage S --next "..." --close YYYY-MM-DD]` | creates the org and contact too if they don't exist |
| `stage <ref> <stage> [--probability P] [--next "..."]` | probability follows the policy unless overridden; a closed stage also sets `status` and `actual_close_date` |
| `close <ref> won\|lost [--value N] [--date D]` | the closing shorthand |
| `next <ref> "<text>"` · `value <ref> <amount>` | the two fields that change most often |
| `field <ref> <name> <value>` | upsert a `custom_fields` row — this is where fee breakdowns live |
| `attach <ref> <path>` | link a proposal or term sheet |
| `todo "<title>" [--deal R --due D --priority P --desc "..." --meta k=v]` | capture an action — shorthand for `task add` |
| `task list\|show\|edit\|done\|start\|wait\|cancel` | the rest of the todo lifecycle |
| `log <type> "<subject>" [--deal R --direction inbound\|outbound]` | an email/call/meeting/demo/whatsapp against a deal |
| `note "<body>" [--deal R]` | free-form |

`<ref>` is a deal id, or a fuzzy org/title match — ambiguous matches list the
candidates and stop rather than guessing.

**Artifacts**

| | |
|---|---|
| `funnel [--out P] [--stdout] [--no-archive]` | archive the previous snapshot, write a new one |
| `serve [--port 8000]` | serve the standalone dashboard + report |
| `init` | create or upgrade the schema from `reference/schema.sql` (idempotent) |

## Todos and actions

**A prompt after `/crm` that reads like an action is a todo — capture it, don't just
answer it.** *Follow up with…*, *remind me…*, *send…*, *call…*, *chase…*, *book…*,
*prepare…*, *draft…*, *check…*, *need to…*, *by Friday* — all of these mean: write a
task with `crm.py todo`, then say what you recorded.

**1 — Find the project.** Every todo should hang off a deal; an unlinked one is a todo
nobody reviews. Match names in the prompt against the DB (`crm.py orgs`, `crm.py
pipeline`). `--deal` accepts a deal id, an org name, or a deal title.

- one match → link it
- several deals for that org → **ask which one**; a fuzzy `--deal` that hits more than one lists the candidates and stops rather than guessing
- no org named but clearly deal-work → **ask which deal**
- genuinely general ("renew the domain") → create it unlinked and say so

**2 — Infer the metadata, don't invent it.**

| Signal in the prompt | Goes to |
|---|---|
| "by Friday", "tomorrow", "end of month", "in two weeks" | `--due` |
| "urgent"/"asap" → `urgent` · "important" → `high` · nothing → `medium` · "when you get a chance" → `low` | `--priority` |
| "waiting on them", "blocked until…" | `--status waiting` |
| anything the todo needs that its title doesn't carry | `--desc` |
| channel, who's blocking, amounts, doc references | `--meta k=v` (repeatable) |

Leave `--due` off rather than inventing a date.

**3 — Add the context you already have.** Read the deal first (`crm.py deal <ref>`).
If its stage, `next_step`, last activity or attached proposal are what make the todo
actionable a week from now, put that in `--desc` as a one-line "why now". Don't restate
the title and don't pad it.

**4 — When the todo *is* the deal's next move,** pass `--set-next` so `deals.next_step`
and the task agree. Use it when the todo is the one thing standing between the deal and
its next stage; skip it for side errands. Closing such a task warns that `next_step` is
now stale — set the new one with `crm.py next <deal> "..."`.

**Due-date shorthand:** `YYYY-MM-DD` · `today` · `tomorrow` · `eow` (Friday) · `eom` ·
`mon`…`sun` · `next friday` · `+3d` · `+2w` · `+1m`. Weekday names mean the next future
occurrence. Unrecognised input is rejected, never guessed.

**Metadata** lives in `custom_fields` with `entity_type='task'`, so a todo can carry
whatever the situation needs — `channel=whatsapp`, `waiting_on=client legal`,
`amount_usd=25000`, `ref=proposal-v2.md`. Use real keys, reuse them
across todos, and don't stuff prose in there — that's what `--desc` is for.

**Ask when it matters:** which deal, and a deadline that's implied but unstated
("before the demo" — which demo, when?). Don't ask about priority or wording — pick a
sane default and state what you picked. One question, not a form.

## Pipeline policy

`qualification → discovery → proposal → negotiation → verbal_commit → closed_won / closed_lost`

| Stage | Default P |
|---|---|
| qualification | 0.10 |
| discovery | 0.20 |
| proposal | 0.40 |
| negotiation | 0.60 |
| verbal_commit | 0.80 |
| closed_won | 1.00 |
| closed_lost | 0.00 |

Per-deal `probability` overrides the stage default — set it when a specific deal
is genuinely better or worse than its stage implies, and say why in `notes`.
`weighted_value = value × probability`. Statuses: `open`, `won`, `lost`, `abandoned`.
Single owner (`$CRM_OWNER`, defaulting to your login name), single currency (USD).

## Data model

13 tables. Spine: `organizations` → `contacts` → `deals`. Around it:
`activities`, `tasks`, `notes`, `contact_methods`, `custom_fields`, `attachments`,
`tags`/`entity_tags`, `imports`, and `crm_users` (a Mattermost identity bridge
supplying `owner/created_by/updated_by` FKs). Five read views —
`v_deals_enriched`, `v_open_pipeline`, `v_contacts_enriched`, `v_upcoming_tasks`,
`v_recent_activity` — and `updated_at` triggers on every mutable table.

Full DDL: [reference/schema.sql](reference/schema.sql).

**`value` is the headline number; the structure lives in `custom_fields`.** Fee
breakdowns in use: `setup_fee_usd`, `integration_fee_usd`, `one_time_fee_usd`,
`monthly_fee_usd`, `monthly_recurring_fee_usd`, `recurrent_fee_usd`,
`daily_recurring_fee_usd`, plus `value_basis`, `product`, `partnership_model`,
`stage_label`. When a deal is multi-year or has an NRE-plus-subscription shape,
put the Year-1 total in `value`, the components in `custom_fields`, and the terms
in `notes`.

## Workflows

**Something happened** (email, WhatsApp, meeting, a new file in the deal folder):

1. `crm.py deal <org>` — read current state first.
2. Apply it: `stage`, `next`, `value`, `field`, `attach`, `log`, `todo`.
   Log the interaction as well as the state change — `activities` is the history
   that makes a later follow-up draftable.
3. Report what changed. Regenerate the snapshot only if asked, or if the standalone
   dashboard is what they're looking at.

**Weekly review:** `crm.py doctor`, `crm.py tasks --overdue`, then `crm.py pipeline`. Surface open deals with
no `next_step`, no value, or untouched 30+ days, and overdue todos. Propose
the concrete next action per deal; don't just list them.

**Drafting a follow-up:** read the deal with `crm.py deal <ref>` — `next_step`,
`notes`, recent `activities`, and the attached proposal are the source material.
Read the attachment before referring to its contents. Match the channel (WhatsApp
is short; email carries the detail).

**A new prospect:** `add-deal` creates org, contact and deal together. Start at
`qualification` with value 0 if it isn't scoped yet — an honest zero beats an
invented number, and `doctor` will surface it.

## Rules

- **Never commit `~/crm.sqlite`** or a dump of it. Deal data is confidential.
  `funnel.json` is a safe derived artifact and is already in the repo.
- **ClawDoc is a public repo.** This skill's own source lives there; deal data, org
  names, amounts, real paths and snapshots must never follow it in. Code and policy
  only — machine- and pipeline-specific values belong in `~/.config/crm/config.json`.
- **`funnel.json` is generated.** Never hand-edit it. It is a snapshot, not state.
- **`archive/` is append-only.** `funnel` stamps the *previous* snapshot with its
  own `generated_at` (`funnel_YYYYMMDD-HHMMSS.json`) and copies it there before
  overwriting. Never delete or overwrite anything in `archive/`.
- **Report PDFs** go to `archive/` dated (`report_YYYYMMDD-HHMMSS.pdf`); only the
  unstamped live copy stays in `app/`.
- **Mind auto-commit.** If `app_dir`/`archive_dir` sit inside a ClawDoc workspace
  with auto-commit on, anything written there lands in git without being asked — so
  don't drop scratch files next to the dashboard; point `--out` somewhere else.
- Stage and status must agree. `stage`/`close` keep them consistent — prefer them
  over a raw `UPDATE`.
- Document naming conventions don't apply to files in `app_dir` — those are app
  assets, not documents.
