#!/usr/bin/env python3
"""
crm.py — single entry point for a personal sales-pipeline CRM.

One place for what otherwise ends up scattered across three:
  - the SQL you'd write by hand against ~/crm.sqlite
  - the funnel.json regen script
  - the snapshot-archiving and dashboard-serving ritual

Stdlib only. The database is the source of truth; every artifact is derived.

Per-machine paths come from env vars or ~/.config/crm/config.json — see below.
Nothing here is specific to one machine or one pipeline.
"""

import argparse
import getpass
import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

SKILL_DIR    = os.path.dirname(os.path.abspath(os.path.realpath(__file__)))
SCHEMA_SQL   = os.path.join(SKILL_DIR, "reference", "schema.sql")

# Per-machine settings live outside the repo, in an optional JSON file:
#
#   ~/.config/crm/config.json   (override the location with $CRM_CONFIG)
#   {"db": "~/crm.sqlite", "app_dir": "~/CRM/app",
#    "archive_dir": "~/CRM/archive", "clawdoc_json": "...", "owner": "you"}
#
# Precedence for every setting: env var > config file > built-in default. Any
# subset of keys is fine; the file itself is optional. Keep real paths and names
# here rather than editing this script, which is version-controlled and shared.
CONFIG_PATH = os.path.expanduser(os.environ.get("CRM_CONFIG") or "~/.config/crm/config.json")

def _load_config(path):
    try:
        with open(path) as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"warning: ignoring {path} ({e})", file=sys.stderr)
        return {}
    return cfg if isinstance(cfg, dict) else {}

CONFIG = _load_config(CONFIG_PATH)

def _setting(env, key, default):
    """env var > config file > default. Strings are ~-expanded."""
    v = os.environ.get(env) or CONFIG.get(key)
    if isinstance(v, str) and v.strip():
        return os.path.expanduser(v.strip())
    return default

def _clawdoc_settings():
    """Where ClawDoc keeps settings.json, for `doctor`'s cross-check.

    This skill ships inside the ClawDoc repo (skills/crm/), so a symlink install
    can find a dev checkout's settings.json two levels up. Otherwise fall back to
    the packaged app's per-platform userData dir.
    """
    repo = os.path.join(os.path.dirname(os.path.dirname(SKILL_DIR)), "settings.json")
    if os.path.exists(repo):
        return repo
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/ClawDoc/settings.json")
    if os.name == "nt":
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"),
                            "ClawDoc", "settings.json")
    return os.path.expanduser("~/.config/ClawDoc/settings.json")

DEFAULT_DB   = _setting("CRM_DB", "db", os.path.expanduser("~/crm.sqlite"))
APP_DIR      = _setting("CRM_APP_DIR", "app_dir", os.path.expanduser("~/CRM/app"))
ARCHIVE_DIR  = _setting("CRM_ARCHIVE_DIR", "archive_dir", os.path.expanduser("~/CRM/archive"))
CLAWDOC_JSON = _setting("CRM_CLAWDOC_JSON", "clawdoc_json", _clawdoc_settings())

STAGES = ["qualification", "discovery", "proposal", "negotiation",
          "verbal_commit", "closed_won", "closed_lost"]
POLICY = {"qualification": 0.10, "discovery": 0.20, "proposal": 0.40,
          "negotiation": 0.60, "verbal_commit": 0.80,
          "closed_won": 1.00, "closed_lost": 0.00}
CLOSING = {"closed_won": "won", "closed_lost": "lost"}
OWNER = _setting("CRM_OWNER", "owner", getpass.getuser())

# ---------------------------------------------------------------- plumbing

def connect(path, create=False):
    if not create and not os.path.exists(path):
        sys.exit(f"CRM database not found at {path}\n"
                 f"Run:  crm.py init --db {path}")
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con

def money(n):
    return f"${n:,.0f}" if n else "$0"

def today():
    return datetime.now().strftime("%Y-%m-%d")

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")

def table(rows, cols):
    """Print aligned rows. cols = [(header, key, align)]."""
    if not rows:
        print("  (none)")
        return
    data = [[str(r[k]) if r[k] is not None else "" for _, k, _ in cols] for r in rows]
    widths = [max(len(h), *(len(d[i]) for d in data)) for i, (h, _, _) in enumerate(cols)]
    print("  " + "  ".join(h.ljust(w) if a == "l" else h.rjust(w)
                           for (h, _, a), w in zip(cols, widths)))
    print("  " + "  ".join("-" * w for w in widths))
    for d in data:
        print("  " + "  ".join(v.ljust(w) if a == "l" else v.rjust(w)
                               for v, (_, _, a), w in zip(d, cols, widths)))

def resolve_deal(con, ref):
    """Accept a deal id, or a fuzzy organization/title match."""
    if str(ref).isdigit():
        row = con.execute("SELECT * FROM v_deals_enriched WHERE id = ?", (int(ref),)).fetchone()
        if not row:
            sys.exit(f"No deal with id {ref}")
        return row
    like = f"%{ref}%"
    rows = con.execute("""SELECT * FROM v_deals_enriched
                          WHERE organization_name LIKE ? OR title LIKE ?
                          ORDER BY status='open' DESC, id""", (like, like)).fetchall()
    if not rows:
        sys.exit(f"No deal matching {ref!r}")
    if len(rows) > 1:
        print(f"{len(rows)} deals match {ref!r} — pick an id:", file=sys.stderr)
        table(rows, [("ID", "id", "r"), ("ORG", "organization_name", "l"),
                     ("TITLE", "title", "l"), ("STAGE", "stage", "l")])
        sys.exit(1)
    return rows[0]

def resolve_org(con, name, create=False):
    row = con.execute("SELECT id, name FROM organizations WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    row = con.execute("SELECT id, name FROM organizations WHERE name LIKE ?",
                      (f"%{name}%",)).fetchone()
    if row:
        return row["id"]
    if not create:
        sys.exit(f"No organization matching {name!r} (pass --create-org to add it)")
    cur = con.execute("INSERT INTO organizations (name, status, owner) VALUES (?, 'prospect', ?)",
                      (name, OWNER))
    print(f"+ organization {name!r} (id {cur.lastrowid})")
    return cur.lastrowid


# ---------------------------------------------------------------- todo helpers

WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
DUE_FORMS = ("YYYY-MM-DD | today | tomorrow | eow | eom | mon..sun | "
             "[next] friday | +3d | +2w | +1m")

def parse_due(s):
    """Accept a real date, or the shorthand a person actually types.

    Weekday names always mean the next future occurrence; 'next friday' is the
    same thing, not the one after. Anything unrecognised is an error rather than
    a silently-wrong date."""
    if not s:
        return None
    t = str(s).strip().lower()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
        return t
    base = datetime.now()
    fmt = lambda d: d.strftime("%Y-%m-%d")
    if t in ("today", "now", "eod"):
        return fmt(base)
    if t == "tomorrow":
        return fmt(base + timedelta(days=1))
    m = re.fullmatch(r"\+?(\d+)\s*([dwm])", t)
    if m:
        n = int(m.group(1))
        return fmt(base + timedelta(days=n * {"d": 1, "w": 7, "m": 30}[m.group(2)]))
    if t in ("eow", "end of week"):
        return fmt(base + timedelta(days=(4 - base.weekday()) % 7))
    if t in ("eom", "end of month"):
        nxt = base.replace(day=28) + timedelta(days=4)
        return fmt(nxt - timedelta(days=nxt.day))
    key = t.replace("next ", "").strip()[:3]
    if key in WEEKDAYS:
        ahead = (WEEKDAYS[key] - base.weekday()) % 7 or 7
        return fmt(base + timedelta(days=ahead))
    sys.exit(f"Unrecognised due date {s!r}. Accepted: {DUE_FORMS}")

def parse_meta(pairs):
    out = {}
    for item in pairs or []:
        if "=" not in item:
            sys.exit(f"--meta expects key=value, got {item!r}")
        k, v = item.split("=", 1)
        out[k.strip()] = v.strip()
    return out

def set_meta(con, entity_type, entity_id, meta):
    for k, v in meta.items():
        con.execute("""INSERT INTO custom_fields (entity_type, entity_id, field_name, field_value)
                       VALUES (?,?,?,?)
                       ON CONFLICT(entity_type, entity_id, field_name)
                       DO UPDATE SET field_value = excluded.field_value""",
                    (entity_type, entity_id, k, v))

def get_meta(con, entity_type, entity_id):
    return con.execute("""SELECT field_name, field_value FROM custom_fields
                          WHERE entity_type=? AND entity_id=? ORDER BY field_name""",
                       (entity_type, entity_id)).fetchall()

def resolve_contact(con, name, org_id=None):
    row = con.execute("SELECT id FROM contacts WHERE full_name LIKE ?", (f"%{name}%",)).fetchone()
    return row["id"] if row else None

# ---------------------------------------------------------------- read

def cmd_status(con, a):
    deals = [dict(r) for r in con.execute("SELECT * FROM v_deals_enriched").fetchall()]
    if a.json:
        print(json.dumps(build_funnel(con, a.db)["summary"], indent=2))
        return
    print(f"\n  {a.db}\n")
    by_status = {}
    for d in deals:
        s = by_status.setdefault(d["status"], {"count": 0, "value": 0.0, "weighted": 0.0})
        s["count"] += 1
        s["value"] += d["value"] or 0
        s["weighted"] += d["weighted_value"] or 0
    rows = [{"k": k, "n": v["count"], "v": money(v["value"]), "w": money(v["weighted"])}
            for k, v in sorted(by_status.items())]
    table(rows, [("STATUS", "k", "l"), ("N", "n", "r"), ("VALUE", "v", "r"), ("WEIGHTED", "w", "r")])
    print()
    rows = []
    for s in STAGES:
        ds = [d for d in deals if d["stage"] == s]
        if not ds:
            continue
        rows.append({"k": s, "n": len(ds),
                     "v": money(sum(d["value"] or 0 for d in ds)),
                     "w": money(sum(d["weighted_value"] or 0 for d in ds))})
    table(rows, [("STAGE", "k", "l"), ("N", "n", "r"), ("VALUE", "v", "r"), ("WEIGHTED", "w", "r")])
    n = lambda q: con.execute(q).fetchone()[0]
    print(f"\n  {n('SELECT COUNT(*) FROM organizations')} orgs · "
          f"{n('SELECT COUNT(*) FROM contacts')} contacts · "
          f"{n('SELECT COUNT(*) FROM v_upcoming_tasks')} open tasks · "
          f"{n('SELECT COUNT(*) FROM activities')} activities\n")

def cmd_pipeline(con, a):
    q = "SELECT * FROM v_deals_enriched WHERE status = 'open'"
    p = []
    if a.stage:
        q += " AND stage = ?"
        p.append(a.stage)
    if a.org:
        q += " AND organization_name LIKE ?"
        p.append(f"%{a.org}%")
    q += " ORDER BY weighted_value DESC, id"
    rows = [dict(r) for r in con.execute(q, p).fetchall()]
    if a.json:
        print(json.dumps(rows, indent=2))
        return
    for r in rows:
        r["value_f"] = money(r["value"])
        r["weighted_f"] = money(r["weighted_value"])
        r["p"] = f"{r['probability']:.2f}"
        r["next"] = (r["next_step"] or "")[:44]
    print()
    table(rows, [("ID", "id", "r"), ("ORG", "organization_name", "l"),
                 ("STAGE", "stage", "l"), ("P", "p", "r"),
                 ("VALUE", "value_f", "r"), ("WEIGHTED", "weighted_f", "r"),
                 ("CLOSE", "expected_close_date", "l"), ("NEXT STEP", "next", "l")])
    print(f"\n  {len(rows)} deals · {money(sum(r['value'] or 0 for r in rows))} raw · "
          f"{money(sum(r['weighted_value'] or 0 for r in rows))} weighted\n")

def cmd_deal(con, a):
    d = resolve_deal(con, a.ref)
    if a.json:
        print(json.dumps(dict(d), indent=2))
        return
    print(f"\n  #{d['id']}  {d['title']}")
    print(f"  {d['organization_name'] or '—'}"
          + (f"  ·  {d['primary_contact_name']}" if d["primary_contact_name"] else ""))
    print(f"\n  stage      {d['stage']}  ({d['status']})")
    print(f"  value      {money(d['value'])} {d['currency']} × {d['probability']:.2f} "
          f"= {money(d['weighted_value'])}")
    print(f"  close      expected {d['expected_close_date'] or '—'}"
          + (f"  actual {d['actual_close_date']}" if d["actual_close_date"] else ""))
    print(f"  next step  {d['next_step'] or '—'}")
    if d["notes"]:
        print(f"  notes      {d['notes']}")
    print(f"  touched    {d['updated_at']}")

    def section(title, rows, cols):
        if rows:
            print(f"\n  {title}")
            table(rows, cols)

    section("CUSTOM FIELDS",
            con.execute("""SELECT field_name, field_value FROM custom_fields
                           WHERE entity_type='deal' AND entity_id=? ORDER BY field_name""",
                        (d["id"],)).fetchall(),
            [("FIELD", "field_name", "l"), ("VALUE", "field_value", "l")])
    section("TASKS",
            con.execute("""SELECT id, title, status, priority, due_date FROM tasks
                           WHERE deal_id=? AND status NOT IN ('done','cancelled')
                           ORDER BY due_date IS NULL, due_date""",
                        (d["id"],)).fetchall(),
            [("ID", "id", "r"), ("TITLE", "title", "l"), ("PRI", "priority", "l"),
             ("STATUS", "status", "l"), ("DUE", "due_date", "l")])
    section("ACTIVITY",
            con.execute("""SELECT activity_date, activity_type, subject FROM activities
                           WHERE deal_id=? ORDER BY activity_date DESC LIMIT 15""",
                        (d["id"],)).fetchall(),
            [("DATE", "activity_date", "l"), ("TYPE", "activity_type", "l"),
             ("SUBJECT", "subject", "l")])
    section("NOTES",
            con.execute("SELECT id, title, body FROM notes WHERE deal_id=? ORDER BY id",
                        (d["id"],)).fetchall(),
            [("ID", "id", "r"), ("TITLE", "title", "l"), ("BODY", "body", "l")])
    section("ATTACHMENTS",
            con.execute("""SELECT file_path FROM attachments
                           WHERE entity_type='deal' AND entity_id=?""", (d["id"],)).fetchall(),
            [("PATH", "file_path", "l")])
    print()

def cmd_tasks(con, a):
    """Top-level `tasks` — the open list, same as `task list`."""
    for k, v in dict(deal=None, org=None, status=None, all=False,
                     overdue=False, json=False).items():
        if not hasattr(a, k):
            setattr(a, k, v)
    task_list(con, a)

def cmd_activity(con, a):
    rows = con.execute("SELECT * FROM v_recent_activity LIMIT ?", (a.limit,)).fetchall()
    print()
    table(rows, [("DATE", "activity_date", "l"), ("TYPE", "activity_type", "l"),
                 ("SUBJECT", "subject", "l"), ("ORG", "organization_name", "l"),
                 ("DEAL", "deal_title", "l")])
    print()

def cmd_orgs(con, a):
    rows = con.execute("""SELECT o.id, o.name, o.status, COUNT(d.id) AS deals,
                                 COALESCE(SUM(d.value), 0) AS pipeline
                          FROM organizations o
                          LEFT JOIN deals d ON d.organization_id = o.id AND d.status='open'
                          GROUP BY o.id ORDER BY pipeline DESC, o.name""").fetchall()
    rows = [dict(r) for r in rows]
    for r in rows:
        r["pipeline"] = money(r["pipeline"])
    print()
    table(rows, [("ID", "id", "r"), ("NAME", "name", "l"), ("STATUS", "status", "l"),
                 ("OPEN", "deals", "r"), ("PIPELINE", "pipeline", "r")])
    print()

def cmd_contacts(con, a):
    q = "SELECT * FROM v_contacts_enriched"
    p = []
    if a.org:
        q += " WHERE organization_name LIKE ?"
        p.append(f"%{a.org}%")
    q += " ORDER BY organization_name, full_name"
    print()
    table(con.execute(q, p).fetchall(),
          [("ID", "id", "r"), ("NAME", "full_name", "l"), ("TITLE", "title", "l"),
           ("ORG", "organization_name", "l"), ("EMAIL", "email", "l")])
    print()

WRITE_RE = re.compile(r"\b(insert|update|delete|drop|alter|create|replace)\b", re.I)

def cmd_sql(con, a):
    if WRITE_RE.search(a.query) and not a.write:
        sys.exit("Refusing a write statement without --write.")
    cur = con.execute(a.query)
    rows = cur.fetchall()
    if a.write:
        con.commit()
        print(f"ok — {cur.rowcount} row(s) affected")
    if rows:
        if a.json:
            print(json.dumps([dict(r) for r in rows], indent=2, ensure_ascii=False))
        else:
            cols = [(c, c, "l") for c in rows[0].keys()]
            print()
            table(rows, cols)
            print()

# ---------------------------------------------------------------- write

def cmd_add_deal(con, a):
    org_id = resolve_org(con, a.org, create=a.create_org)
    contact_id = None
    if a.contact:
        row = con.execute("SELECT id FROM contacts WHERE full_name LIKE ?",
                          (f"%{a.contact}%",)).fetchone()
        if row:
            contact_id = row["id"]
        else:
            cur = con.execute("""INSERT INTO contacts (full_name, organization_id, owner, status)
                                 VALUES (?, ?, ?, 'new')""", (a.contact, org_id, OWNER))
            contact_id = cur.lastrowid
            print(f"+ contact {a.contact!r} (id {contact_id})")
    prob = a.probability if a.probability is not None else POLICY[a.stage]
    cur = con.execute("""INSERT INTO deals
        (title, organization_id, primary_contact_id, stage, status, value, currency,
         probability, expected_close_date, source, owner, next_step, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (a.title, org_id, contact_id, a.stage, "open", a.value, a.currency, prob,
         a.close, a.source, OWNER, a.next, a.notes))
    con.commit()
    print(f"+ deal #{cur.lastrowid}  {a.title!r} — {a.stage} — {money(a.value)} × {prob:.2f}")

def cmd_stage(con, a):
    d = resolve_deal(con, a.ref)
    prob = a.probability if a.probability is not None else POLICY[a.stage]
    sets = ["stage = ?", "probability = ?"]
    vals = [a.stage, prob]
    if a.stage in CLOSING:
        sets += ["status = ?", "actual_close_date = ?", "next_step = NULL"]
        vals += [CLOSING[a.stage], a.date or today()]
    if a.next:
        sets.append("next_step = ?")
        vals.append(a.next)
    con.execute(f"UPDATE deals SET {', '.join(sets)} WHERE id = ?", vals + [d["id"]])
    con.commit()
    print(f"#{d['id']} {d['title']!r}: {d['stage']} → {a.stage} (p={prob:.2f})")

def cmd_close(con, a):
    a.stage = "closed_won" if a.outcome == "won" else "closed_lost"
    a.probability = 1.0 if a.outcome == "won" else 0.0
    a.next = None
    if a.value is not None:
        d = resolve_deal(con, a.ref)
        con.execute("UPDATE deals SET value = ? WHERE id = ?", (a.value, d["id"]))
    cmd_stage(con, a)

def cmd_next(con, a):
    d = resolve_deal(con, a.ref)
    con.execute("UPDATE deals SET next_step = ? WHERE id = ?", (a.text, d["id"]))
    con.commit()
    print(f"#{d['id']} next step → {a.text!r}")

def cmd_value(con, a):
    d = resolve_deal(con, a.ref)
    con.execute("UPDATE deals SET value = ? WHERE id = ?", (a.amount, d["id"]))
    con.commit()
    print(f"#{d['id']} value {money(d['value'])} → {money(a.amount)} "
          f"(weighted {money(a.amount * d['probability'])})")

def cmd_field(con, a):
    d = resolve_deal(con, a.ref)
    if a.delete:
        con.execute("""DELETE FROM custom_fields
                       WHERE entity_type='deal' AND entity_id=? AND field_name=?""",
                    (d["id"], a.name))
        print(f"#{d['id']} − {a.name}")
    else:
        con.execute("""INSERT INTO custom_fields (entity_type, entity_id, field_name, field_value)
                       VALUES ('deal', ?, ?, ?)
                       ON CONFLICT(entity_type, entity_id, field_name)
                       DO UPDATE SET field_value = excluded.field_value""",
                    (d["id"], a.name, a.value))
        print(f"#{d['id']} {a.name} = {a.value}")
    con.commit()

def cmd_attach(con, a):
    d = resolve_deal(con, a.ref)
    path = os.path.abspath(os.path.expanduser(a.path))
    if not os.path.exists(path):
        print(f"warning: {path} does not exist", file=sys.stderr)
    con.execute("""INSERT INTO attachments (entity_type, entity_id, file_path, file_name, description)
                   VALUES ('deal', ?, ?, ?, ?)""",
                (d["id"], path, os.path.basename(path), a.desc))
    con.commit()
    print(f"#{d['id']} + {path}")

PRIORITY_RANK = "CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END"

TASK_SELECT = f"""
    SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
           t.completed_at, t.owner, t.created_at, t.updated_at,
           t.organization_id, o.name AS organization_name,
           t.contact_id, c.full_name AS contact_name,
           t.deal_id, d.title AS deal_title, d.stage AS deal_stage
    FROM tasks t
    LEFT JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN contacts      c ON c.id = t.contact_id
    LEFT JOIN deals         d ON d.id = t.deal_id
"""

def resolve_task(con, ref):
    if str(ref).isdigit():
        row = con.execute(TASK_SELECT + " WHERE t.id = ?", (int(ref),)).fetchone()
        if not row:
            sys.exit(f"No task with id {ref}")
        return row
    rows = con.execute(TASK_SELECT + """ WHERE t.title LIKE ?
                                         ORDER BY t.status IN ('done','cancelled'), t.id""",
                       (f"%{ref}%",)).fetchall()
    if not rows:
        sys.exit(f"No task matching {ref!r}")
    if len(rows) > 1:
        print(f"{len(rows)} tasks match {ref!r} — pick an id:", file=sys.stderr)
        table(rows, [("ID", "id", "r"), ("TITLE", "title", "l"),
                     ("STATUS", "status", "l"), ("ORG", "organization_name", "l")])
        sys.exit(1)
    return rows[0]

def task_add(con, a):
    """Create a todo. Links to a deal when one is named — an unlinked task is a
    last resort, because a todo with no project is a todo nobody reviews."""
    deal_id = org_id = contact_id = None
    if a.deal:
        d = resolve_deal(con, a.deal)
        deal_id, org_id, contact_id = d["id"], d["organization_id"], d["primary_contact_id"]
    if a.org:
        org_id = resolve_org(con, a.org, create=False)
    if a.contact:
        contact_id = resolve_contact(con, a.contact) or contact_id
    due = parse_due(a.due)
    cur = con.execute("""INSERT INTO tasks (title, description, status, priority, due_date,
                                            deal_id, organization_id, contact_id, owner)
                         VALUES (?,?,?,?,?,?,?,?,?)""",
                      (a.title, a.desc, a.status, a.priority, due,
                       deal_id, org_id, contact_id, OWNER))
    tid = cur.lastrowid
    meta = parse_meta(a.meta)
    if meta:
        set_meta(con, "task", tid, meta)
    if a.set_next:
        if not deal_id:
            sys.exit("--set-next needs a --deal")
        con.execute("UPDATE deals SET next_step = ? WHERE id = ?", (a.title, deal_id))
    con.commit()

    bits = [a.priority]
    if due:
        bits.append(f"due {due}")
    if deal_id:
        bits.append(f"deal #{deal_id}")
    elif org_id:
        bits.append(con.execute("SELECT name FROM organizations WHERE id=?", (org_id,)).fetchone()[0])
    else:
        bits.append("UNLINKED")
    print(f"+ task #{tid}  {a.title!r}  [{' · '.join(bits)}]")
    for k, v in meta.items():
        print(f"    {k} = {v}")
    if a.set_next:
        print(f"    deal #{deal_id} next_step ← {a.title!r}")

def task_list(con, a):
    q, p = TASK_SELECT, []
    where = []
    if not a.all and not a.status:
        where.append("t.status NOT IN ('done','cancelled')")
    if a.status:
        where.append("t.status = ?")
        p.append(a.status)
    if a.deal:
        where.append("t.deal_id = ?")
        p.append(resolve_deal(con, a.deal)["id"])
    if a.org:
        where.append("o.name LIKE ?")
        p.append(f"%{a.org}%")
    if a.overdue:
        where.append("t.due_date IS NOT NULL AND t.due_date < date('now')")
    if where:
        q += " WHERE " + " AND ".join(where)
    q += f" ORDER BY t.due_date IS NULL, t.due_date, {PRIORITY_RANK}"
    rows = [dict(r) for r in con.execute(q, p).fetchall()]
    if a.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return
    stamp = datetime.now().strftime("%Y-%m-%d")
    for r in rows:
        due = r["due_date"] or ""
        r["due_f"] = due + ("  !" if due and due < stamp and r["status"] not in ("done", "cancelled") else "")
        r["ctx"] = r["deal_title"] or r["organization_name"] or ""
        r["ctx"] = r["ctx"][:34]
    print()
    table(rows, [("ID", "id", "r"), ("DUE", "due_f", "l"), ("PRI", "priority", "l"),
                 ("STATUS", "status", "l"), ("TITLE", "title", "l"),
                 ("ORG", "organization_name", "l"), ("DEAL", "ctx", "l")])
    late = sum(1 for r in rows if r["due_date"] and r["due_date"] < stamp
               and r["status"] not in ("done", "cancelled"))
    print(f"\n  {len(rows)} task(s)" + (f" · {late} overdue (!)" if late else "") + "\n")

def task_show(con, a):
    t = resolve_task(con, a.ref)
    if a.json:
        row = dict(t)
        row["meta"] = {m["field_name"]: m["field_value"] for m in get_meta(con, "task", t["id"])}
        print(json.dumps(row, indent=2, ensure_ascii=False))
        return
    print(f"\n  #{t['id']}  {t['title']}")
    print(f"\n  status     {t['status']}  ·  {t['priority']}")
    print(f"  due        {t['due_date'] or '—'}"
          + (f"   completed {t['completed_at']}" if t["completed_at"] else ""))
    link = t["deal_title"] and f"#{t['deal_id']} {t['deal_title']} ({t['deal_stage']})" or "—"
    print(f"  deal       {link}")
    print(f"  org        {t['organization_name'] or '—'}"
          + (f"  ·  {t['contact_name']}" if t["contact_name"] else ""))
    if t["description"]:
        print(f"\n  context\n    " + t["description"].replace("\n", "\n    "))
    meta = get_meta(con, "task", t["id"])
    if meta:
        print()
        table(meta, [("META", "field_name", "l"), ("VALUE", "field_value", "l")])
    print()

def task_edit(con, a):
    t = resolve_task(con, a.ref)
    sets, vals = [], []
    for col, val in (("title", a.title), ("description", a.desc),
                     ("priority", a.priority), ("status", a.status)):
        if val is not None:
            sets.append(f"{col} = ?")
            vals.append(val)
    if a.due is not None:
        sets.append("due_date = ?")
        vals.append(parse_due(a.due) if a.due else None)
    if a.deal:
        d = resolve_deal(con, a.deal)
        sets += ["deal_id = ?", "organization_id = ?"]
        vals += [d["id"], d["organization_id"]]
    if sets:
        con.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", vals + [t["id"]])
    meta = parse_meta(a.meta)
    if meta:
        set_meta(con, "task", t["id"], meta)
    if not sets and not meta:
        sys.exit("Nothing to change.")
    con.commit()
    print(f"#{t['id']} updated")
    task_show(con, argparse.Namespace(ref=t["id"], json=False))

def task_status(con, a, status):
    t = resolve_task(con, a.ref)
    done = status in ("done", "cancelled")
    con.execute(f"""UPDATE tasks SET status = ?,
                        completed_at = {"datetime('now')" if done else "NULL"}
                    WHERE id = ?""", (status, t["id"]))
    con.commit()
    print(f"task #{t['id']} {t['title']!r}: {t['status']} → {status}")
    if status == "done" and t["deal_id"]:
        d = con.execute("SELECT next_step FROM deals WHERE id = ?", (t["deal_id"],)).fetchone()
        if d and d["next_step"] and d["next_step"].strip() == (t["title"] or "").strip():
            print(f"  note: deal #{t['deal_id']} next_step still reads {d['next_step']!r} "
                  f"— set the new one with:  crm.py next {t['deal_id']} \"...\"")

def cmd_task(con, a):
    sub = a.task_cmd
    if sub == "add":
        return task_add(con, a)
    if sub == "list":
        return task_list(con, a)
    if sub == "show":
        return task_show(con, a)
    if sub == "edit":
        return task_edit(con, a)
    return task_status(con, a, {"done": "done", "start": "in_progress",
                                "wait": "waiting", "cancel": "cancelled"}[sub])

def cmd_log(con, a):
    deal_id = org_id = contact_id = None
    if a.deal:
        d = resolve_deal(con, a.deal)
        deal_id, org_id, contact_id = d["id"], d["organization_id"], d["primary_contact_id"]
    cur = con.execute("""INSERT INTO activities (activity_type, subject, body, activity_date,
                                                 direction, outcome, organization_id,
                                                 contact_id, deal_id, owner)
                         VALUES (?,?,?,?,?,?,?,?,?,?)""",
                      (a.type, a.subject, a.body, a.date or today(), a.direction, a.outcome,
                       org_id, contact_id, deal_id, OWNER))
    con.commit()
    print(f"+ {a.type} #{cur.lastrowid} {a.subject!r}"
          + (f" (deal #{deal_id})" if deal_id else ""))

def cmd_note(con, a):
    deal_id = org_id = None
    if a.deal:
        d = resolve_deal(con, a.deal)
        deal_id, org_id = d["id"], d["organization_id"]
    cur = con.execute("""INSERT INTO notes (title, body, deal_id, organization_id, owner)
                         VALUES (?,?,?,?,?)""", (a.title, a.body, deal_id, org_id, OWNER))
    con.commit()
    print(f"+ note #{cur.lastrowid}")

# ---------------------------------------------------------------- derived artifacts

def build_funnel(con, db_path):
    """The funnel.json payload. Same shape as ClawDoc's crm.js getFunnel()."""
    rows = con.execute("""
        SELECT d.id, d.title, d.stage, d.status, d.value, d.currency, d.probability,
               d.expected_close_date, d.actual_close_date, d.owner, d.next_step,
               d.organization_id, o.name AS organization_name,
               d.primary_contact_id, c.full_name AS primary_contact_name,
               d.created_at, d.updated_at
        FROM deals d
        LEFT JOIN organizations o ON o.id = d.organization_id
        LEFT JOIN contacts      c ON c.id = d.primary_contact_id
        ORDER BY d.id""").fetchall()

    def as_deal(r):
        val = float(r["value"] or 0)
        prob = r["probability"] if r["probability"] is not None else POLICY.get(r["stage"], 0)
        d = {k: r[k] for k in r.keys()}
        d["value"] = val
        d["probability"] = prob
        d["weighted_value"] = round(val * prob, 2)
        return d

    deals = [as_deal(r) for r in rows]
    stages = []
    for s in STAGES:
        ds = [d for d in deals if d["stage"] == s]
        stages.append({"stage": s, "count": len(ds),
                       "total_value": sum(d["value"] for d in ds),
                       "weighted_value": round(sum(d["weighted_value"] for d in ds), 2),
                       "deals": ds})

    def group(status):
        ds = [d for d in deals if d["status"] == status]
        return {"count": len(ds),
                "total_value": sum(d["value"] for d in ds) if ds else 0,
                "weighted_value": round(sum(d["weighted_value"] for d in ds), 2) if ds else 0}

    return {
        "generated_at": now_iso(),
        "source_db": db_path,
        "currencies_present": sorted({d["currency"] for d in deals if d["currency"]}),
        "probability_policy": POLICY,
        "summary": {
            "open": group("open"), "won": group("won"),
            "lost": group("lost"), "abandoned": group("abandoned"),
            "all": {"count": len(deals),
                    "total_value": sum(d["value"] for d in deals),
                    "weighted_value": round(sum(d["weighted_value"] for d in deals), 2)},
        },
        "stages": stages,
    }

def cmd_funnel(con, a):
    out = a.out or os.path.join(APP_DIR, "funnel.json")
    if a.stdout:
        print(json.dumps(build_funnel(con, a.db), indent=2, ensure_ascii=False))
        return
    # Archiving rule: the previous snapshot is stamped with ITS OWN generated_at,
    # not the copy time, and archive/ is append-only.
    if os.path.exists(out) and not a.no_archive:
        try:
            prev = json.load(open(out))
            stamp = re.sub(r"[^0-9T]", "", prev.get("generated_at", "")).replace("T", "-")[:15]
        except Exception:
            stamp = ""
        if not stamp:
            stamp = datetime.fromtimestamp(os.path.getmtime(out)).strftime("%Y%m%d-%H%M%S")
        # archive/ is a sibling of the output file's folder, so --out to a
        # scratch path archives beside it rather than into the real repo.
        archive_dir = os.path.normpath(os.path.join(os.path.dirname(out), "..", "archive"))
        os.makedirs(archive_dir, exist_ok=True)
        dest = os.path.join(archive_dir, f"funnel_{stamp}.json")
        if os.path.exists(dest):
            print(f"  archive already holds {os.path.basename(dest)} — not overwriting")
        else:
            shutil.copy2(out, dest)
            print(f"  archived → {dest}")
    payload = build_funnel(con, a.db)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    s = payload["summary"]
    print(f"  wrote    → {out}")
    print(f"  {payload['generated_at']} · {s['all']['count']} deals · "
          f"{s['open']['count']} open · {money(s['open']['weighted_value'])} weighted")

def cmd_serve(con, a):
    import http.server, socketserver, functools
    os.chdir(APP_DIR)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=APP_DIR)
    with socketserver.TCPServer(("", a.port), handler) as httpd:
        print(f"  dashboard  http://localhost:{a.port}/")
        print(f"  report     http://localhost:{a.port}/report.html")
        print("  ctrl-c to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()

def cmd_init(con, a):
    with open(SCHEMA_SQL) as f:
        con.executescript(f.read())
    con.commit()
    n = con.execute("""SELECT COUNT(*) FROM sqlite_master
                       WHERE type='table' AND name NOT LIKE 'sqlite_%'""").fetchone()[0]
    print(f"  schema applied to {a.db} ({n} tables)")

def cmd_doctor(con, a):
    print(f"\n  db          {a.db}  "
          f"({os.path.getsize(a.db) // 1024} KB, modified {datetime.fromtimestamp(os.path.getmtime(a.db)):%Y-%m-%d %H:%M})")
    live = con.execute("SELECT MAX(updated_at) FROM deals").fetchone()[0]
    print(f"  last write  {live}")

    snap = os.path.join(APP_DIR, "funnel.json")
    if os.path.exists(snap):
        try:
            prev = json.load(open(snap))
            gen = prev["generated_at"]
            stale = (live or "") > gen.replace("T", " ")[:19]
            print(f"  snapshot    {gen}  {'STALE — run: crm.py funnel' if stale else 'current'}")
        except Exception as e:
            print(f"  snapshot    unreadable ({e})")
    else:
        print(f"  snapshot    missing ({snap})")

    print(f"  config      {CONFIG_PATH}"
          + ("" if CONFIG else "  (absent — using env vars and defaults)"))
    print(f"  app dir     {APP_DIR}")

    if os.path.exists(CLAWDOC_JSON):
        try:
            cfg = (json.load(open(CLAWDOC_JSON)) or {}).get("crm") or {}
            resolved = os.path.expanduser(cfg.get("dbPath") or "~/crm.sqlite")
            same = os.path.abspath(resolved) == os.path.abspath(a.db)
            print(f"  clawdoc     enabled={cfg.get('enabled')} dbPath={cfg.get('dbPath')}"
                  + ("" if same else "  ← DIFFERENT DB THAN THIS ONE"))
        except Exception as e:
            print(f"  clawdoc     settings unreadable ({e})")
    else:
        print(f"  clawdoc     settings not found ({CLAWDOC_JSON})")

    bad = con.execute("""SELECT COUNT(*) FROM deals
                         WHERE (stage IN ('closed_won','closed_lost') AND status = 'open')
                            OR (stage NOT IN ('closed_won','closed_lost') AND status != 'open')""").fetchone()[0]
    orphan = con.execute("SELECT COUNT(*) FROM deals WHERE organization_id IS NULL").fetchone()[0]
    nonext = con.execute("SELECT COUNT(*) FROM deals WHERE status='open' AND (next_step IS NULL OR next_step='')").fetchone()[0]
    novalue = con.execute("SELECT COUNT(*) FROM deals WHERE status='open' AND (value IS NULL OR value=0)").fetchone()[0]
    stalest = con.execute("""SELECT COUNT(*) FROM deals WHERE status='open'
                             AND julianday('now') - julianday(updated_at) > 30""").fetchone()[0]
    print(f"\n  stage/status mismatch  {bad}")
    print(f"  deals with no org      {orphan}")
    print(f"  open, no next_step     {nonext}")
    print(f"  open, no value         {novalue}")
    print(f"  open, untouched 30d+   {stalest}\n")

# ---------------------------------------------------------------- cli

def main():
    p = argparse.ArgumentParser(prog="crm.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=DEFAULT_DB)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_, **kw):
        s = sub.add_parser(name, help=help_, **kw)
        s.set_defaults(fn=fn)
        return s

    s = add("status", cmd_status, "counts + totals by status and stage")
    s.add_argument("--json", action="store_true")

    s = add("pipeline", cmd_pipeline, "open deals, weighted, ranked")
    s.add_argument("--stage", choices=STAGES)
    s.add_argument("--org")
    s.add_argument("--json", action="store_true")

    s = add("deal", cmd_deal, "everything about one deal (id, org name, or title)")
    s.add_argument("ref")
    s.add_argument("--json", action="store_true")

    s = add("tasks", cmd_tasks, "open todos by due date (alias for `task list`)")
    s.add_argument("--overdue", action="store_true")
    s.add_argument("--json", action="store_true")
    s = add("activity", cmd_activity, "recent activity log")
    s.add_argument("-n", "--limit", type=int, default=20)

    add("orgs", cmd_orgs, "organizations with open pipeline")
    s = add("contacts", cmd_contacts, "contacts, optionally by org")
    s.add_argument("--org")

    s = add("sql", cmd_sql, "raw SQL (read-only unless --write)")
    s.add_argument("query")
    s.add_argument("--write", action="store_true")
    s.add_argument("--json", action="store_true")

    s = add("add-deal", cmd_add_deal, "create an organization/contact/deal in one go")
    s.add_argument("--org", required=True)
    s.add_argument("--title", required=True)
    s.add_argument("--contact")
    s.add_argument("--value", type=float, default=0)
    s.add_argument("--currency", default="USD")
    s.add_argument("--stage", choices=STAGES, default="qualification")
    s.add_argument("--probability", type=float)
    s.add_argument("--close", help="expected close date YYYY-MM-DD")
    s.add_argument("--next", help="next step")
    s.add_argument("--source")
    s.add_argument("--notes")
    s.add_argument("--create-org", action="store_true", default=True)

    s = add("stage", cmd_stage, "move a deal; probability follows the policy unless overridden")
    s.add_argument("ref")
    s.add_argument("stage", choices=STAGES)
    s.add_argument("--probability", type=float)
    s.add_argument("--next")
    s.add_argument("--date", help="actual close date when moving to a closed stage")

    s = add("close", cmd_close, "close a deal won or lost")
    s.add_argument("ref")
    s.add_argument("outcome", choices=["won", "lost"])
    s.add_argument("--date")
    s.add_argument("--value", type=float, help="final contract value")

    s = add("next", cmd_next, "set next_step")
    s.add_argument("ref")
    s.add_argument("text")

    s = add("value", cmd_value, "set deal value")
    s.add_argument("ref")
    s.add_argument("amount", type=float)

    s = add("field", cmd_field, "upsert a custom field on a deal (pricing breakdown etc.)")
    s.add_argument("ref")
    s.add_argument("name")
    s.add_argument("value", nargs="?")
    s.add_argument("--delete", action="store_true")

    s = add("attach", cmd_attach, "link a proposal/term sheet path to a deal")
    s.add_argument("ref")
    s.add_argument("path")
    s.add_argument("--desc")

    # --- todos / actions ------------------------------------------------
    PRIORITIES = ["low", "medium", "high", "urgent"]
    STATUSES   = ["todo", "in_progress", "waiting", "done", "cancelled"]

    def add_todo_args(x, editing=False):
        x.add_argument("--deal", help="deal id, org name, or deal title to link to")
        x.add_argument("--due", metavar="WHEN", help=DUE_FORMS)
        x.add_argument("--priority", choices=PRIORITIES, default=None if editing else "medium")
        x.add_argument("--desc", metavar="TEXT",
                       help="context: why it matters, what is blocking, what to say")
        x.add_argument("--meta", action="append", metavar="K=V",
                       help="extra metadata, repeatable (channel=whatsapp, blocked_by=...)")

    def add_create_args(x):
        x.add_argument("title")
        x.add_argument("--org", help="link to an organization without a specific deal")
        x.add_argument("--contact")
        x.add_argument("--status", choices=STATUSES, default="todo")
        x.add_argument("--set-next", action="store_true",
                       help="also set the linked deal's next_step to this title")
        add_todo_args(x)

    tp = sub.add_parser("task", help="todos and actions, linked to a deal")
    tp.set_defaults(fn=cmd_task)
    tsub = tp.add_subparsers(dest="task_cmd", required=True)

    add_create_args(tsub.add_parser("add", help="create a todo"))

    tl = tsub.add_parser("list", help="open todos; filter by deal, org, status")
    tl.add_argument("--deal")
    tl.add_argument("--org")
    tl.add_argument("--status", choices=STATUSES)
    tl.add_argument("--all", action="store_true", help="include done and cancelled")
    tl.add_argument("--overdue", action="store_true")
    tl.add_argument("--json", action="store_true")

    tsh = tsub.add_parser("show", help="one todo in full, with its metadata")
    tsh.add_argument("ref")
    tsh.add_argument("--json", action="store_true")

    te = tsub.add_parser("edit", help="retitle, reschedule, reprioritise, relink")
    te.add_argument("ref")
    te.add_argument("--title")
    te.add_argument("--status", choices=STATUSES)
    add_todo_args(te, editing=True)

    for nm, hlp in (("done", "mark done"), ("start", "→ in_progress"),
                    ("wait", "→ waiting"), ("cancel", "→ cancelled")):
        x = tsub.add_parser(nm, help=hlp)
        x.add_argument("ref")

    # `todo` is the capture shorthand — identical to `task add`.
    td = sub.add_parser("todo", help="shorthand for `task add`")
    td.set_defaults(fn=task_add)
    add_create_args(td)

    s = add("log", cmd_log, "record an email/call/meeting/demo/whatsapp against a deal")
    s.add_argument("type", choices=["note", "email", "call", "meeting", "demo",
                                    "linkedin", "whatsapp", "task", "follow_up", "other"])
    s.add_argument("subject")
    s.add_argument("--deal")
    s.add_argument("--body")
    s.add_argument("--date")
    s.add_argument("--direction", choices=["inbound", "outbound", "internal"])
    s.add_argument("--outcome")

    s = add("note", cmd_note, "attach a free-form note to a deal")
    s.add_argument("body")
    s.add_argument("--title")
    s.add_argument("--deal")

    s = add("funnel", cmd_funnel, "regenerate funnel.json (archives the previous snapshot)")
    s.add_argument("--out")
    s.add_argument("--stdout", action="store_true", help="print instead of writing")
    s.add_argument("--no-archive", action="store_true")

    s = add("serve", cmd_serve, "serve the standalone dashboard + report over HTTP")
    s.add_argument("--port", type=int, default=8000)

    add("init", cmd_init, "create/upgrade the schema (idempotent)")
    add("doctor", cmd_doctor, "health check: snapshot drift, ClawDoc config, data hygiene")

    a = p.parse_args()
    con = connect(a.db, create=(a.cmd == "init"))
    a.fn(con, a)
    con.close()

if __name__ == "__main__":
    main()
