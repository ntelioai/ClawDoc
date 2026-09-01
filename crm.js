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

module.exports = {
  defaultDbPath,
  resolveDbPath,
  initDb,
  getFunnel,
  closeAll,
};
