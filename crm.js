// SPDX-License-Identifier: AGPL-3.0-only
// ClawDoc CRM adapter — opens the personal sales-pipeline sqlite DB, creates
// the schema on first use, and produces the funnel JSON payload consumed by
// the bundled Dashboard/Report views.
//
// The DB path defaults to ~/crm.sqlite but is configurable in Settings (stored
// under settings.crm.dbPath). Everything here is lazy: the sqlite driver is
// only required when the CRM feature is actually enabled + used, so users who
// never turn it on don't pay any startup cost.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Pipeline stage order and default per-stage probability. Mirrors §5 of the
// CRM-implementation reference so the dashboards see the same policy as the
// standalone Python regen script did.
const STAGES = [
  'qualification', 'discovery', 'proposal', 'negotiation',
  'verbal_commit', 'closed_won', 'closed_lost',
];
const PROBABILITY_POLICY = {
  qualification: 0.10,
  discovery:     0.20,
  proposal:      0.40,
  negotiation:   0.60,
  verbal_commit: 0.80,
  closed_won:    1.00,
  closed_lost:   0.00,
};

// Full DDL, captured verbatim from a live ~/crm.sqlite on 2026-09-01. Used
// only on first init — if the file already exists, nothing here runs.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crm_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'mattermost',
    platform_user_id TEXT NOT NULL,
    username TEXT COLLATE NOCASE,
    display_name TEXT,
    email TEXT COLLATE NOCASE,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(platform, platform_user_id),
    UNIQUE(platform, username)
);

CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE,
    legal_name TEXT,
    website TEXT,
    domain TEXT COLLATE NOCASE,
    industry TEXT,
    size_range TEXT,
    annual_revenue REAL,
    status TEXT NOT NULL DEFAULT 'prospect'
        CHECK (status IN ('lead','prospect','customer','partner','vendor','inactive')),
    source TEXT,
    owner TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT NOT NULL COLLATE NOCASE,
    title TEXT,
    email TEXT COLLATE NOCASE,
    phone TEXT,
    linkedin_url TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','active','warm','cold','do_not_contact','inactive')),
    source TEXT,
    owner TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    UNIQUE(email)
);

CREATE TABLE IF NOT EXISTS contact_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('contact','organization')),
    entity_id INTEGER NOT NULL,
    method_type TEXT NOT NULL CHECK (method_type IN ('email','phone','linkedin','twitter','website','whatsapp','telegram','signal','other')),
    value TEXT NOT NULL,
    label TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id, method_type, value)
);

CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    primary_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    pipeline TEXT NOT NULL DEFAULT 'default',
    stage TEXT NOT NULL DEFAULT 'qualification'
        CHECK (stage IN ('qualification','discovery','proposal','negotiation','verbal_commit','closed_won','closed_lost')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','won','lost','abandoned')),
    value REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    probability REAL NOT NULL DEFAULT 0.10 CHECK (probability >= 0 AND probability <= 1),
    expected_close_date TEXT,
    actual_close_date TEXT,
    source TEXT,
    owner TEXT,
    next_step TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('note','email','call','meeting','demo','linkedin','whatsapp','task','follow_up','other')),
    subject TEXT NOT NULL,
    body TEXT,
    activity_date TEXT NOT NULL DEFAULT (datetime('now')),
    due_date TEXT,
    completed_at TEXT,
    direction TEXT CHECK (direction IN ('inbound','outbound','internal')),
    outcome TEXT,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    owner TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo','in_progress','waiting','done','cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high','urgent')),
    due_date TEXT,
    completed_at TEXT,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    owner TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    body TEXT NOT NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    owner TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('organization','contact','deal','activity','task','note')),
    entity_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tag_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('organization','contact','deal','activity','task','note')),
    entity_id INTEGER NOT NULL,
    field_name TEXT NOT NULL COLLATE NOCASE,
    field_value TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    UNIQUE(entity_type, entity_id, field_name)
);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('organization','contact','deal','activity','task','note')),
    entity_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT,
    mime_type TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    description TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count INTEGER,
    notes TEXT,
    created_by_user_id INTEGER REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);
CREATE INDEX IF NOT EXISTS idx_organizations_domain ON organizations(domain);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_contacts_full_name ON contacts(full_name);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contact_methods_entity ON contact_methods(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_contact_methods_value ON contact_methods(value);
CREATE INDEX IF NOT EXISTS idx_deals_status_stage ON deals(status, stage);
CREATE INDEX IF NOT EXISTS idx_deals_expected_close ON deals(expected_close_date);
CREATE INDEX IF NOT EXISTS idx_deals_org ON deals(organization_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(primary_contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(activity_date);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_org ON activities(organization_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities(deal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_custom_fields_entity_field ON custom_fields(entity_type, entity_id, field_name);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_crm_users_platform_user_id ON crm_users(platform, platform_user_id);
CREATE INDEX IF NOT EXISTS idx_crm_users_username ON crm_users(platform, username);
CREATE INDEX IF NOT EXISTS idx_organizations_owner_user_id ON organizations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner_user_id ON deals(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_activities_owner_user_id ON activities(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_user_id ON tasks(owner_user_id);

CREATE VIEW IF NOT EXISTS v_contacts_enriched AS
SELECT c.id, c.full_name, c.first_name, c.last_name, c.title, c.email, c.phone,
       c.linkedin_url, c.location, c.status, c.source, c.owner,
       c.organization_id, o.name AS organization_name, o.domain AS organization_domain,
       c.notes, c.created_at, c.updated_at
FROM contacts c
LEFT JOIN organizations o ON o.id = c.organization_id;

CREATE VIEW IF NOT EXISTS v_deals_enriched AS
SELECT d.id, d.title, d.pipeline, d.stage, d.status, d.value, d.currency,
       d.probability, ROUND(d.value * d.probability, 2) AS weighted_value,
       d.expected_close_date, d.actual_close_date, d.source, d.owner, d.next_step,
       d.organization_id, o.name AS organization_name,
       d.primary_contact_id, c.full_name AS primary_contact_name,
       d.notes, d.created_at, d.updated_at
FROM deals d
LEFT JOIN organizations o ON o.id = d.organization_id
LEFT JOIN contacts c ON c.id = d.primary_contact_id;

CREATE VIEW IF NOT EXISTS v_open_pipeline AS
SELECT * FROM v_deals_enriched
WHERE status = 'open'
ORDER BY expected_close_date IS NULL, expected_close_date, weighted_value DESC;

CREATE VIEW IF NOT EXISTS v_upcoming_tasks AS
SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.completed_at,
       t.owner, t.organization_id, o.name AS organization_name,
       t.contact_id, c.full_name AS contact_name,
       t.deal_id, d.title AS deal_title, t.created_at, t.updated_at
FROM tasks t
LEFT JOIN organizations o ON o.id = t.organization_id
LEFT JOIN contacts c ON c.id = t.contact_id
LEFT JOIN deals d ON d.id = t.deal_id
WHERE t.status NOT IN ('done','cancelled')
ORDER BY t.due_date IS NULL, t.due_date,
         CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END;

CREATE VIEW IF NOT EXISTS v_recent_activity AS
SELECT a.id, a.activity_type, a.subject, a.body, a.activity_date, a.due_date,
       a.completed_at, a.direction, a.outcome, a.owner,
       a.organization_id, o.name AS organization_name,
       a.contact_id, c.full_name AS contact_name,
       a.deal_id, d.title AS deal_title, a.created_at, a.updated_at
FROM activities a
LEFT JOIN organizations o ON o.id = a.organization_id
LEFT JOIN contacts c ON c.id = a.contact_id
LEFT JOIN deals d ON d.id = a.deal_id
ORDER BY a.activity_date DESC;

CREATE TRIGGER IF NOT EXISTS trg_organizations_updated_at AFTER UPDATE ON organizations
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE organizations SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_contacts_updated_at AFTER UPDATE ON contacts
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE contacts SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_deals_updated_at AFTER UPDATE ON deals
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE deals SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_activities_updated_at AFTER UPDATE ON activities
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE activities SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at AFTER UPDATE ON tasks
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_notes_updated_at AFTER UPDATE ON notes
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE notes SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_custom_fields_updated_at AFTER UPDATE ON custom_fields
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE custom_fields SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_crm_users_updated_at AFTER UPDATE ON crm_users
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE crm_users SET updated_at = datetime('now') WHERE id = NEW.id; END;
`;

function defaultDbPath() {
  return path.join(os.homedir(), 'crm.sqlite');
}

// Expand a user-supplied path (allow leading ~, env vars) and resolve it.
function resolveDbPath(p) {
  let s = String(p || '').trim();
  if (!s) return defaultDbPath();
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

// Cache one Database handle per absolute path. Re-opening on every request
// would be wasteful; better-sqlite3 handles are cheap to keep around and
// concurrent reads/writes on a single handle are safe.
const openHandles = new Map(); // absPath -> Database

function closeAll() {
  for (const db of openHandles.values()) {
    try { db.close(); } catch {}
  }
  openHandles.clear();
}

function openDb(absPath, { create } = {}) {
  const cached = openHandles.get(absPath);
  if (cached) return cached;
  const dir = path.dirname(absPath);
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!create && !fs.existsSync(absPath)) {
    const err = new Error('CRM database not found at ' + absPath);
    err.code = 'ENOENT';
    throw err;
  }
  // Lazy require: only pull in the native binding when we actually need it.
  const Database = require('better-sqlite3');
  const db = new Database(absPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  openHandles.set(absPath, db);
  return db;
}

// Create the DB file (if missing) and apply the schema. Idempotent: safe to
// call against an existing DB — every CREATE uses IF NOT EXISTS.
function initDb(absPath) {
  const db = openDb(absPath, { create: true });
  db.exec(SCHEMA_SQL);
  return { path: absPath, ok: true };
}

// Assemble the funnel.json payload directly from sqlite — same shape as the
// standalone Python regen script (CRM-implementation.md §6/§7).
function getFunnel(absPath) {
  const db = openDb(absPath);
  const rows = db.prepare(`
    SELECT d.id, d.title, d.stage, d.status, d.value, d.currency, d.probability,
           d.expected_close_date, d.actual_close_date, d.owner, d.next_step,
           d.organization_id, o.name AS organization_name,
           d.primary_contact_id, c.full_name AS primary_contact_name,
           d.created_at, d.updated_at
    FROM deals d
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN contacts      c ON c.id = d.primary_contact_id
    ORDER BY d.id
  `).all();

  const round2 = (n) => Math.round(n * 100) / 100;
  const deals = rows.map(r => {
    const val = Number(r.value) || 0;
    const prob = r.probability != null ? Number(r.probability) : (PROBABILITY_POLICY[r.stage] || 0);
    return {
      id: r.id, title: r.title, stage: r.stage, status: r.status,
      value: val, currency: r.currency, probability: prob,
      expected_close_date: r.expected_close_date,
      actual_close_date:  r.actual_close_date,
      owner: r.owner, next_step: r.next_step,
      organization_id: r.organization_id, organization_name: r.organization_name,
      primary_contact_id: r.primary_contact_id, primary_contact_name: r.primary_contact_name,
      created_at: r.created_at, updated_at: r.updated_at,
      weighted_value: round2(val * prob),
    };
  });

  const stages = STAGES.map(s => {
    const ds = deals.filter(d => d.stage === s);
    return {
      stage: s,
      count: ds.length,
      total_value: ds.reduce((a, d) => a + d.value, 0),
      weighted_value: round2(ds.reduce((a, d) => a + d.weighted_value, 0)),
      deals: ds,
    };
  });

  const group = (status) => {
    const ds = deals.filter(d => d.status === status);
    return {
      count: ds.length,
      total_value: ds.length ? ds.reduce((a, d) => a + d.value, 0) : 0,
      weighted_value: ds.length ? round2(ds.reduce((a, d) => a + d.weighted_value, 0)) : 0,
    };
  };

  const summary = {
    open: group('open'), won: group('won'),
    lost: group('lost'), abandoned: group('abandoned'),
    all: {
      count: deals.length,
      total_value: deals.reduce((a, d) => a + d.value, 0),
      weighted_value: round2(deals.reduce((a, d) => a + d.weighted_value, 0)),
    },
  };

  const currencies = Array.from(new Set(deals.map(d => d.currency).filter(Boolean))).sort();

  return {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    source_db: absPath,
    currencies_present: currencies,
    probability_policy: PROBABILITY_POLICY,
    summary,
    stages,
  };
}

// Read open tasks from v_upcoming_tasks (non-done/cancelled, sorted by due
// date then priority). The view already joins in the linked org/contact/deal,
// so a single query is enough for the Todo screen.
function getOpenTasks(absPath) {
  const db = openDb(absPath);
  const rows = db.prepare(`
    SELECT id, title, description, status, priority, due_date, completed_at,
           owner, organization_id, organization_name,
           contact_id, contact_name, deal_id, deal_title,
           created_at, updated_at
    FROM v_upcoming_tasks
  `).all();
  return {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    source_db: absPath,
    count: rows.length,
    tasks: rows,
  };
}

// Fields the Todo UI is allowed to write. Anything outside this set is
// silently ignored so a rogue payload can't rewrite server-managed columns
// (timestamps, ids, audit user FKs).
const TASK_STATUS   = new Set(['todo', 'in_progress', 'waiting', 'done', 'cancelled']);
const TASK_PRIORITY = new Set(['low', 'medium', 'high', 'urgent']);

// Turn a picker's "" or missing value into SQL NULL; leave real ids alone.
function nullableInt(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function nullableStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function buildTaskWrite(patch, forCreate) {
  const cols = [];
  const values = [];
  if (patch.title !== undefined) {
    const t = String(patch.title || '').trim();
    if (forCreate && !t) throw new Error('title is required');
    if (t || !forCreate) { cols.push('title'); values.push(t || null); }
  }
  if (patch.description !== undefined) { cols.push('description'); values.push(nullableStr(patch.description)); }
  if (patch.status !== undefined) {
    const s = String(patch.status);
    if (!TASK_STATUS.has(s)) throw new Error('invalid status: ' + s);
    cols.push('status'); values.push(s);
    cols.push('completed_at');
    values.push(s === 'done' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null);
  }
  if (patch.priority !== undefined) {
    const p = String(patch.priority);
    if (!TASK_PRIORITY.has(p)) throw new Error('invalid priority: ' + p);
    cols.push('priority'); values.push(p);
  }
  if (patch.due_date !== undefined) { cols.push('due_date'); values.push(nullableStr(patch.due_date)); }
  if (patch.organization_id !== undefined) { cols.push('organization_id'); values.push(nullableInt(patch.organization_id)); }
  if (patch.contact_id      !== undefined) { cols.push('contact_id');      values.push(nullableInt(patch.contact_id)); }
  if (patch.deal_id         !== undefined) { cols.push('deal_id');         values.push(nullableInt(patch.deal_id)); }
  if (patch.owner           !== undefined) { cols.push('owner');           values.push(nullableStr(patch.owner)); }
  return { cols, values };
}

// Update a task. Only whitelisted fields are writable; see buildTaskWrite.
function updateTask(absPath, id, patch) {
  const db = openDb(absPath);
  const { cols, values } = buildTaskWrite(patch, false);
  if (!cols.length) return { ok: true, changed: 0 };
  values.push(Number(id));
  const set = cols.map(c => `${c} = ?`).join(', ');
  const info = db.prepare(`UPDATE tasks SET ${set} WHERE id = ?`).run(...values);
  return { ok: true, changed: info.changes };
}

// Insert a new task. title is required; every other field is optional with
// sensible defaults from the schema (status 'todo', priority 'medium', etc).
function createTask(absPath, data) {
  const db = openDb(absPath);
  const { cols, values } = buildTaskWrite(data, true);
  if (!cols.includes('title')) throw new Error('title is required');
  const placeholders = cols.map(() => '?').join(', ');
  const info = db.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(...values);
  return { ok: true, id: info.lastInsertRowid };
}

function deleteTask(absPath, id) {
  const db = openDb(absPath);
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id));
  return { ok: true, changed: info.changes };
}

// ---------- Activities (calls, emails, meetings, notes, …) ----------
// The Activity screen shows a reverse-chronological feed with optional
// attached file paths (via the attachments table, entity_type='activity').

const ACTIVITY_TYPES = new Set([
  'note', 'email', 'call', 'meeting', 'demo',
  'linkedin', 'whatsapp', 'task', 'follow_up', 'other',
]);
const ACTIVITY_DIRECTIONS = new Set(['inbound', 'outbound', 'internal']);

function buildActivityWrite(patch, forCreate) {
  const cols = [];
  const values = [];
  if (patch.activity_type !== undefined) {
    const t = String(patch.activity_type);
    if (!ACTIVITY_TYPES.has(t)) throw new Error('invalid activity_type: ' + t);
    cols.push('activity_type'); values.push(t);
  } else if (forCreate) {
    throw new Error('activity_type is required');
  }
  if (patch.subject !== undefined) {
    const s = String(patch.subject || '').trim();
    if (forCreate && !s) throw new Error('subject is required');
    cols.push('subject'); values.push(s || null);
  } else if (forCreate) {
    throw new Error('subject is required');
  }
  if (patch.body !== undefined)          { cols.push('body');           values.push(nullableStr(patch.body)); }
  if (patch.activity_date !== undefined) { cols.push('activity_date');  values.push(nullableStr(patch.activity_date) || new Date().toISOString().slice(0, 19).replace('T', ' ')); }
  if (patch.direction !== undefined) {
    if (patch.direction === null || patch.direction === '') {
      cols.push('direction'); values.push(null);
    } else {
      const d = String(patch.direction);
      if (!ACTIVITY_DIRECTIONS.has(d)) throw new Error('invalid direction: ' + d);
      cols.push('direction'); values.push(d);
    }
  }
  if (patch.outcome !== undefined)         { cols.push('outcome');         values.push(nullableStr(patch.outcome)); }
  if (patch.organization_id !== undefined) { cols.push('organization_id'); values.push(nullableInt(patch.organization_id)); }
  if (patch.contact_id !== undefined)      { cols.push('contact_id');      values.push(nullableInt(patch.contact_id)); }
  if (patch.deal_id !== undefined)         { cols.push('deal_id');         values.push(nullableInt(patch.deal_id)); }
  if (patch.owner !== undefined)           { cols.push('owner');           values.push(nullableStr(patch.owner)); }
  return { cols, values };
}

// Read the recent activity feed. Joins in attachments so each row carries
// its associated file paths (rendered as clickable links in the UI).
function getActivities(absPath, opts) {
  opts = opts || {};
  const db = openDb(absPath);
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  const params = [];
  const where = [];
  if (opts.type && ACTIVITY_TYPES.has(opts.type)) {
    where.push('a.activity_type = ?');
    params.push(opts.type);
  }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  // v_recent_activity already sorts DESC; wrap in a subquery so LEFT JOIN +
  // GROUP BY doesn't disturb the ordering.
  const rows = db.prepare(`
    SELECT a.*, GROUP_CONCAT(att.file_path, '|') AS attachment_paths
    FROM v_recent_activity a
    LEFT JOIN attachments att ON att.entity_type = 'activity' AND att.entity_id = a.id
    ${whereSql}
    GROUP BY a.id
    ORDER BY a.activity_date DESC
    LIMIT ?
  `).all(...params, limit);
  // Split the GROUP_CONCAT back into an array of file paths per row.
  for (const r of rows) {
    r.attachments = r.attachment_paths ? r.attachment_paths.split('|').filter(Boolean) : [];
    delete r.attachment_paths;
  }
  return {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    source_db: absPath,
    count: rows.length,
    activities: rows,
  };
}

// Replace all attachment file_paths for an activity with the provided list.
// Attachments carry entity_type='activity', entity_id=<activity id>. The
// simple replace strategy avoids drift between what the UI shows and what's
// in the DB — the whole set is authoritative on every save.
function replaceActivityAttachments(db, activityId, files) {
  const list = Array.isArray(files) ? files.map(f => String(f || '').trim()).filter(Boolean) : [];
  const del = db.prepare(`DELETE FROM attachments WHERE entity_type='activity' AND entity_id=?`);
  const ins = db.prepare(`INSERT INTO attachments (entity_type, entity_id, file_path, file_name) VALUES ('activity', ?, ?, ?)`);
  db.transaction(() => {
    del.run(activityId);
    for (const fp of list) {
      const base = fp.split('/').pop() || fp;
      ins.run(activityId, fp, base);
    }
  })();
}

function createActivity(absPath, data) {
  const db = openDb(absPath);
  const { cols, values } = buildActivityWrite(data, true);
  const placeholders = cols.map(() => '?').join(', ');
  const info = db.prepare(
    `INSERT INTO activities (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(...values);
  const id = Number(info.lastInsertRowid);
  if (Array.isArray(data.attachments)) replaceActivityAttachments(db, id, data.attachments);
  return { ok: true, id };
}

function updateActivity(absPath, id, patch) {
  const db = openDb(absPath);
  const { cols, values } = buildActivityWrite(patch, false);
  if (cols.length) {
    values.push(Number(id));
    const set = cols.map(c => `${c} = ?`).join(', ');
    db.prepare(`UPDATE activities SET ${set} WHERE id = ?`).run(...values);
  }
  if (Array.isArray(patch.attachments)) replaceActivityAttachments(db, Number(id), patch.attachments);
  return { ok: true };
}

function deleteActivity(absPath, id) {
  const db = openDb(absPath);
  const aid = Number(id);
  db.transaction(() => {
    db.prepare(`DELETE FROM attachments WHERE entity_type='activity' AND entity_id=?`).run(aid);
    db.prepare('DELETE FROM activities WHERE id = ?').run(aid);
  })();
  return { ok: true };
}

// Picker data for the Todo edit dialog: org/contact/deal names + ids. Capped
// so a huge database can't turn the picker into a MB of payload — if the CRM
// ever grows past these caps we'll swap to a typeahead search endpoint.
function getLookups(absPath) {
  const db = openDb(absPath);
  const organizations = db.prepare(`
    SELECT id, name FROM organizations
    WHERE status != 'inactive'
    ORDER BY name COLLATE NOCASE
    LIMIT 500
  `).all();
  const contacts = db.prepare(`
    SELECT c.id, c.full_name, o.name AS organization_name
    FROM contacts c
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE c.status NOT IN ('do_not_contact', 'inactive')
    ORDER BY c.full_name COLLATE NOCASE
    LIMIT 1000
  `).all();
  const deals = db.prepare(`
    SELECT d.id, d.title, d.status, d.stage, o.name AS organization_name
    FROM deals d
    LEFT JOIN organizations o ON o.id = d.organization_id
    ORDER BY (CASE d.status WHEN 'open' THEN 0 ELSE 1 END), d.updated_at DESC
    LIMIT 500
  `).all();
  return { organizations, contacts, deals };
}

module.exports = {
  defaultDbPath,
  resolveDbPath,
  initDb,
  getFunnel,
  getOpenTasks,
  createTask,
  updateTask,
  deleteTask,
  getLookups,
  getActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  closeAll,
};
