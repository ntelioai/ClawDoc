#!/usr/bin/env node
// mdown local server — serves the UI and proxies workspace file reads.
// Run: node Utils/mdown/serve.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const chokidar = require('chokidar');
const gitOps = require('./git');
const github = require('./github');

const SCRIPT_DIR = __dirname;
const APP_DIR = path.join(SCRIPT_DIR, 'app');
// Writable data directory — overridable so packaged apps can redirect to userData.
const DATA_DIR = process.env.MDOWN_DATA_DIR || SCRIPT_DIR;
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const PORT = Number(process.env.MDOWN_PORT || 7878);

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

// Returns array of absolute paths from -p/--path flags, or null if none given.
function parseCliRootPaths(argv) {
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-p' || a === '--path') && argv[i + 1]) {
      out.push(path.resolve(argv[i + 1]));
      i++;
    } else if (a.startsWith('--path=')) {
      out.push(path.resolve(a.slice('--path='.length)));
    } else if (a.startsWith('-p=')) {
      out.push(path.resolve(a.slice('-p='.length)));
    }
  }
  return out.length ? out : null;
}

function loadSettingsFile() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (s && Array.isArray(s.workspaces)) return s;
  } catch {}
  return null;
}

function saveSettingsFile(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

// Read the full settings object (workspaces + git config + token). Always
// returns a normalized shape; callers shouldn't have to defend against missing
// keys.
function readSettings() {
  let s = null;
  try {
    if (fs.existsSync(SETTINGS_PATH)) s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {}
  s = s || {};
  s.workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
  s.github = s.github && typeof s.github === 'object' ? s.github : {};
  s.git = s.git && typeof s.git === 'object' ? s.git : {};
  s.git.perWorkspace = s.git.perWorkspace && typeof s.git.perWorkspace === 'object'
    ? s.git.perWorkspace : {};
  return s;
}

function writeSettings(s) {
  // Keep workspaces in sync with the live ROOTS so a UI workspace edit and a
  // git-settings change don't trample each other.
  saveSettingsFile(s);
}

function getGitSettingsFor(absPath) {
  const s = readSettings();
  return s.git.perWorkspace[absPath] || null;
}

function setGitSettingsFor(absPath, cfg) {
  const s = readSettings();
  if (cfg === null) delete s.git.perWorkspace[absPath];
  else s.git.perWorkspace[absPath] = { ...(s.git.perWorkspace[absPath] || {}), ...cfg };
  writeSettings(s);
}

function getGithubToken() {
  const s = readSettings();
  return s.github.token || null;
}

function setGithubToken(token, profile) {
  const s = readSettings();
  if (token) s.github = { ...s.github, token, login: profile && profile.login, name: profile && profile.name };
  else s.github = {};
  writeSettings(s);
}

// Determine the initial workspace list using this priority:
//   1. CLI -p flags win for this session (don't overwrite settings.json)
//   2. settings.json if it exists
//   3. MDOWN_ROOT env or process.cwd() as the final default (and persist it)
function resolveInitialRootPaths() {
  const cli = parseCliRootPaths(process.argv);
  const settings = loadSettingsFile();
  if (cli) {
    // Only persist if no settings file exists yet, so the user's saved
    // workspaces aren't blown away by a one-off CLI launch.
    if (!settings) {
      try { saveSettingsFile({ ...readSettings(), workspaces: cli }); } catch {}
    }
    return cli;
  }
  if (settings) return settings.workspaces.map(w => path.resolve(typeof w === 'string' ? w : w.path));
  const def = [path.resolve(process.env.MDOWN_ROOT || process.cwd())];
  try { saveSettingsFile({ ...readSettings(), workspaces: def }); } catch {}
  return def;
}

function namedRoots(paths) {
  const used = new Map();
  return paths.map(p => {
    const base = path.basename(p) || p;
    let name = base;
    let n = 2;
    while (used.has(name)) name = base + '-' + n++;
    used.set(name, true);
    return { name, path: p };
  });
}

// `let` because the user can edit workspaces from the UI at runtime — no
// server restart needed when the list changes.
let ROOTS = namedRoots(resolveInitialRootPaths());
let ROOT_BY_NAME = new Map(ROOTS.map(r => [r.name, r]));

// Convert a workspace-prefixed path like "Business/Products/foo.md" into an
// absolute filesystem path. Returns null if the prefix doesn't match any
// known workspace or the resolved path escapes its root.
function resolveWorkspacePath(prefixed) {
  if (!prefixed) return null;
  const i = prefixed.indexOf('/');
  const rootName = i < 0 ? prefixed : prefixed.slice(0, i);
  const rel = i < 0 ? '' : prefixed.slice(i + 1);
  const root = ROOT_BY_NAME.get(rootName);
  if (!root) return null;
  const fp = path.join(root.path, rel);
  if (!safeInside(root.path, fp)) return null;
  return { fp, root, rel };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safeInside(root, target) {
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function sendText(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendFile(res, fp) {
  let stat;
  try { stat = fs.statSync(fp); } catch { return sendText(res, 404, 'Not found'); }
  if (!stat.isFile()) return sendText(res, 404, 'Not found');
  const ext = path.extname(fp).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(fp).pipe(res);
}

function handleReindex(res) {
  // Pass the same -p flags to index.js so a Reindex button click rescans the
  // same workspaces we're currently serving.
  const args = [path.join(SCRIPT_DIR, 'index.js')];
  for (const r of ROOTS) { args.push('-p', r.path); }
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let out = '', err = '';
  child.stdout.on('data', d => out += d.toString());
  child.stderr.on('data', d => err += d.toString());
  child.on('close', code => {
    sendText(res, code === 0 ? 200 : 500,
      JSON.stringify({ code, stdout: out, stderr: err }),
      'application/json; charset=utf-8');
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  let query;
  try {
    const u = url.parse(req.url, true);
    pathname = decodeURIComponent(u.pathname);
    query = u.query;
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendFile(res, path.join(APP_DIR, 'index.html'));
  }

  if (req.method === 'GET' && pathname.startsWith('/app/')) {
    const fp = path.join(APP_DIR, pathname.slice('/app/'.length));
    if (!safeInside(APP_DIR, fp)) return sendText(res, 403, 'Forbidden');
    return sendFile(res, fp);
  }

  if (req.method === 'GET' && pathname === '/api/index') {
    if (!fs.existsSync(INDEX_PATH)) {
      return sendText(res, 404, '{"error":"no index yet"}', 'application/json; charset=utf-8');
    }
    return sendFile(res, INDEX_PATH);
  }

  if (req.method === 'POST' && pathname === '/api/reindex') {
    return handleReindex(res);
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    return handleEventsStream(req, res);
  }

  if (req.method === 'GET' && (pathname === '/file' || pathname === '/asset')) {
    const prefixed = (query && query.path) || '';
    if (!prefixed) return sendText(res, 400, 'missing path');
    const r = resolveWorkspacePath(prefixed);
    if (!r) return sendText(res, 403, 'Forbidden or unknown workspace');
    return sendFile(res, r.fp);
  }

  // Path-shaped raw file endpoint. Used for HTML iframes so that relative
  // refs like `assets/foo.png` inside a deck resolve against the document's
  // folder. The first segment is the workspace name; the rest is relative
  // to that workspace's root on disk.
  if (req.method === 'GET' && pathname.startsWith('/raw/')) {
    const prefixed = pathname.slice('/raw/'.length);
    if (!prefixed) return sendText(res, 400, 'missing path');
    const r = resolveWorkspacePath(prefixed);
    if (!r) return sendText(res, 403, 'Forbidden or unknown workspace');
    return sendFile(res, r.fp);
  }

  if (req.method === 'GET' && pathname === '/api/open') {
    // Reveal a file in the OS Finder (macOS).
    const prefixed = (query && query.path) || '';
    const r = resolveWorkspacePath(prefixed);
    if (!r) return sendText(res, 403, 'Forbidden or unknown workspace');
    spawn('open', ['-R', r.fp], { detached: true, stdio: 'ignore' }).unref();
    return sendText(res, 200, '{"ok":true}', 'application/json; charset=utf-8');
  }

  if (req.method === 'POST' && pathname === '/api/save') {
    return handleSave(req, res, query);
  }

  if (req.method === 'POST' && pathname === '/api/delete') {
    return readJsonBody(req, res, (b) => handleDelete(res, b));
  }

  if (req.method === 'POST' && pathname === '/api/rename') {
    return readJsonBody(req, res, (b) => handleRename(res, b));
  }

  if (req.method === 'POST' && pathname === '/api/move') {
    return readJsonBody(req, res, (b) => handleMove(res, b));
  }

  if (req.method === 'POST' && pathname === '/api/mkdir') {
    return readJsonBody(req, res, (b) => handleMkdir(res, b));
  }

  if (req.method === 'POST' && pathname === '/api/touch') {
    return readJsonBody(req, res, (b) => handleTouch(res, b));
  }

  if (req.method === 'POST' && pathname === '/api/copy') {
    return readJsonBody(req, res, (b) => handleCopy(res, b));
  }

  if (req.method === 'GET' && pathname === '/api/settings') {
    return sendText(res, 200,
      JSON.stringify({ workspaces: ROOTS.map(r => ({ name: r.name, path: r.path })) }),
      'application/json; charset=utf-8');
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    return handleSaveSettings(req, res);
  }

  // ---- git / github routes ----
  if (req.method === 'GET' && pathname === '/api/git/status') {
    return handleGitStatus(res, query);
  }
  if (req.method === 'POST' && pathname === '/api/git/init') {
    return readJsonBody(req, res, (b) => handleGitInit(res, b));
  }
  if (req.method === 'POST' && pathname === '/api/git/commit') {
    return readJsonBody(req, res, (b) => handleGitCommit(res, b));
  }
  if (req.method === 'POST' && pathname === '/api/git/push') {
    return readJsonBody(req, res, (b) => handleGitPush(res, b));
  }
  if (req.method === 'POST' && pathname === '/api/git/pull') {
    return readJsonBody(req, res, (b) => handleGitPull(res, b));
  }
  if (req.method === 'POST' && pathname === '/api/git/configure') {
    return readJsonBody(req, res, (b) => handleGitConfigure(res, b));
  }
  if (req.method === 'GET' && pathname === '/api/git/log') {
    return handleGitLog(res, query);
  }
  if (req.method === 'GET' && pathname === '/api/git/diff') {
    return handleGitDiff(res, query);
  }
  if (req.method === 'GET' && pathname === '/api/github/me') {
    return handleGithubMe(res);
  }
  if (req.method === 'POST' && pathname === '/api/github/connect') {
    return readJsonBody(req, res, (b) => handleGithubConnect(res, b));
  }
  if (req.method === 'POST' && pathname === '/api/github/disconnect') {
    return handleGithubDisconnect(res);
  }
  if (req.method === 'POST' && pathname === '/api/github/device/start') {
    return handleGithubDeviceStart(res);
  }
  if (req.method === 'GET' && pathname === '/api/github/device/poll') {
    return handleGithubDevicePoll(res, query);
  }
  if (req.method === 'POST' && pathname === '/api/github/repo/create') {
    return readJsonBody(req, res, (b) => handleGithubCreateRepo(res, b));
  }

  if (req.method === 'GET' && pathname === '/api/pick-folder') {
    // macOS-only convenience — show a native folder picker via osascript.
    const child = spawn('osascript', ['-e', 'POSIX path of (choose folder)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', () => {
      const p = out.trim();
      sendText(res, 200,
        JSON.stringify(p ? { path: p } : { cancelled: true }),
        'application/json; charset=utf-8');
    });
    child.on('error', () => {
      sendText(res, 500, JSON.stringify({ error: 'osascript not available' }), 'application/json; charset=utf-8');
    });
    return;
  }

  sendText(res, 404, 'Not found');
});

// ---------- settings (workspaces) endpoint ----------
function handleSaveSettings(req, res) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 64 * 1024) req.destroy();
  });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch {
      return sendText(res, 400, '{"error":"bad json"}', 'application/json; charset=utf-8');
    }
    const incoming = Array.isArray(data.workspaces) ? data.workspaces : null;
    if (!incoming || !incoming.length) {
      return sendText(res, 400, '{"error":"need at least one workspace"}', 'application/json; charset=utf-8');
    }
    const seen = new Set();
    const resolved = [];
    for (const raw of incoming) {
      const s = String(raw || '').trim();
      if (!s) continue;
      const abs = path.resolve(s);
      if (seen.has(abs)) continue; // dedupe
      let stat;
      try { stat = fs.statSync(abs); } catch {
        return sendText(res, 400,
          JSON.stringify({ error: 'Not found: ' + abs }),
          'application/json; charset=utf-8');
      }
      if (!stat.isDirectory()) {
        return sendText(res, 400,
          JSON.stringify({ error: 'Not a directory: ' + abs }),
          'application/json; charset=utf-8');
      }
      seen.add(abs);
      resolved.push(abs);
    }
    if (!resolved.length) {
      return sendText(res, 400, '{"error":"no valid paths"}', 'application/json; charset=utf-8');
    }
    try {
      saveSettingsFile({ ...readSettings(), workspaces: resolved });
    } catch (err) {
      return sendText(res, 500,
        JSON.stringify({ error: 'Failed to write settings.json: ' + err.message }),
        'application/json; charset=utf-8');
    }
    // Hot-swap the in-memory workspace list.
    ROOTS = namedRoots(resolved);
    ROOT_BY_NAME = new Map(ROOTS.map(r => [r.name, r]));
    // Re-attach watchers to the new root set.
    startWatchers();
    sendText(res, 200,
      JSON.stringify({ ok: true, workspaces: ROOTS.map(r => ({ name: r.name, path: r.path })) }),
      'application/json; charset=utf-8');
  });
  req.on('error', () => {
    try { sendText(res, 500, '{"error":"request error"}', 'application/json'); } catch {}
  });
}

// ---------- save endpoint ----------
function handleSave(req, res, query) {
  const prefixed = (query && query.path) || '';
  if (!prefixed) return sendText(res, 400, '{"error":"missing path"}', 'application/json');
  const r = resolveWorkspacePath(prefixed);
  if (!r) return sendText(res, 403, '{"error":"forbidden or unknown workspace"}', 'application/json');
  const fp = r.fp;
  const ext = path.extname(fp).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    return sendText(res, 400, '{"error":"only .md / .markdown files can be saved"}', 'application/json');
  }

  const MAX = 10 * 1024 * 1024; // 10 MB cap
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > MAX) {
      return sendText(res, 413, '{"error":"file too large"}', 'application/json');
    }
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      // Write atomically: temp file in the same dir + rename.
      const tmp = fp + '.mdown-tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, fp);
      const stat = fs.statSync(fp);
      sendText(res, 200,
        JSON.stringify({ ok: true, size: stat.size, mtime: stat.mtimeMs }),
        'application/json; charset=utf-8'
      );
      // Trigger debounced auto-commit (no-ops silently if not a git repo or
      // autoCommit is off).
      try { scheduleAutoCommit(r.root.name, r.rel); } catch {}
    } catch (err) {
      sendText(res, 500,
        JSON.stringify({ error: err.message }),
        'application/json; charset=utf-8'
      );
    }
  });
  req.on('error', () => {
    try { sendText(res, 500, '{"error":"request error"}', 'application/json'); } catch {}
  });
}

// ---------- delete / rename ----------
// Deletion goes through Finder's "move to Trash" on macOS so the user can
// Cmd+Z it back — much safer than fs.rm for documents the user cares about.
// Falls back to fs.rm on other platforms or if osascript is unavailable.
//
// Rename is a same-directory operation: the new name can't escape its parent
// folder. Cross-folder moves aren't supported here (do those by drag-and-drop
// in Finder, or in a future revision).
//
// We don't broadcast SSE manually — chokidar will see the change and the
// existing debounced reindex pipeline will push `index-changed` to clients.

function isWorkspaceRoot(resolved) {
  // resolved is { fp, root, rel }. Empty rel means the user targeted the root
  // itself; don't let them blow away an entire workspace via the context menu.
  return !resolved.rel || resolved.rel === '.';
}

// Move a path into the user's Trash by renaming. Doesn't need any special
// macOS permissions (unlike the osascript→Finder route, which requires
// Automation access). Drawback: Finder won't show a "Put Back" option since
// the move bypasses Finder's bookkeeping — the file is still recoverable by
// the user dragging it out of Trash manually.
function moveToUserTrash(absPath) {
  const home = process.env.HOME || '';
  const trashDir = process.platform === 'darwin'
    ? path.join(home, '.Trash')
    : path.join(home, '.local', 'share', 'Trash', 'files'); // XDG; best-effort on Linux
  if (!home || !fs.existsSync(trashDir)) {
    return { ok: false, error: 'trash directory not found at ' + trashDir };
  }
  const base = path.basename(absPath);
  let dest = path.join(trashDir, base);
  // Avoid clobbering an existing entry in Trash with the same name.
  if (fs.existsSync(dest)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', ' ').slice(0, 19);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    dest = path.join(trashDir, `${stem} ${ts}${ext}`);
  }
  try {
    fs.renameSync(absPath, dest);
    return { ok: true, dest };
  } catch (err) {
    if (err.code !== 'EXDEV') return { ok: false, error: err.message };
    // Cross-volume (e.g. external drive → home Trash) — fall back to
    // copy + delete so the move still appears atomic to the caller.
    try {
      const isDir = fs.statSync(absPath).isDirectory();
      if (isDir) fs.cpSync(absPath, dest, { recursive: true, force: false });
      else fs.copyFileSync(absPath, dest);
      if (isDir) fs.rmSync(absPath, { recursive: true, force: false });
      else fs.unlinkSync(absPath);
      return { ok: true, dest };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }
}

async function handleDelete(res, body) {
  const prefixed = String((body && body.path) || '');
  if (!prefixed) return sendJson(res, 400, { error: 'missing path' });
  const r = resolveWorkspacePath(prefixed);
  if (!r) return sendJson(res, 403, { error: 'forbidden or unknown workspace' });
  if (isWorkspaceRoot(r)) return sendJson(res, 400, { error: 'cannot delete a workspace root' });
  let stat;
  try { stat = fs.statSync(r.fp); } catch { return sendJson(res, 404, { error: 'not found' }); }
  const kind = stat.isDirectory() ? 'folder' : 'file';

  const t = moveToUserTrash(r.fp);
  if (t.ok) return sendJson(res, 200, { ok: true, trashed: true, kind, dest: t.dest });

  // Fall back to permanent delete only if the caller explicitly opted in.
  if (!body.force) return sendJson(res, 500, { error: 'move to Trash failed: ' + t.error });
  try {
    if (kind === 'folder') fs.rmSync(r.fp, { recursive: true, force: false });
    else fs.unlinkSync(r.fp);
    return sendJson(res, 200, { ok: true, trashed: false, kind });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

function validateRenameName(name) {
  if (!name || typeof name !== 'string') return 'name required';
  const trimmed = name.trim();
  if (!trimmed) return 'name required';
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'name cannot contain a slash';
  if (trimmed === '.' || trimmed === '..') return 'invalid name';
  if (trimmed.length > 255) return 'name too long';
  return null;
}

async function handleRename(res, body) {
  const prefixed = String((body && body.path) || '');
  const newName = String((body && body.newName) || '').trim();
  if (!prefixed) return sendJson(res, 400, { error: 'missing path' });
  const validation = validateRenameName(newName);
  if (validation) return sendJson(res, 400, { error: validation });

  const r = resolveWorkspacePath(prefixed);
  if (!r) return sendJson(res, 403, { error: 'forbidden or unknown workspace' });
  if (isWorkspaceRoot(r)) return sendJson(res, 400, { error: 'cannot rename a workspace root' });
  try { fs.statSync(r.fp); } catch { return sendJson(res, 404, { error: 'not found' }); }

  const parentDir = path.dirname(r.fp);
  const destFp = path.join(parentDir, newName);
  // Defense in depth: the joined path must still live inside the workspace.
  if (!safeInside(r.root.path, destFp)) return sendJson(res, 400, { error: 'destination escapes workspace' });
  if (destFp === r.fp) return sendJson(res, 200, { ok: true, unchanged: true });
  if (fs.existsSync(destFp)) return sendJson(res, 409, { error: 'a file or folder with that name already exists' });

  try {
    fs.renameSync(r.fp, destFp);
    const newRel = path.relative(r.root.path, destFp).split(path.sep).join('/');
    return sendJson(res, 200, {
      ok: true,
      oldPath: prefixed,
      newPath: r.root.name + '/' + newRel,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

// ---------- move (drag-drop within a workspace) ----------
// Moves a file or folder into a destination folder, both expressed as
// workspace-prefixed paths. Same workspace only — cross-workspace moves are
// rejected because the two roots may be different git repos or volumes and
// the user almost never wants the implicit history rewrite that comes with
// crossing them.

async function handleMove(res, body) {
  const srcPrefixed = String((body && body.srcPath) || '');
  const destPrefixed = String((body && body.destFolder) || '');
  if (!srcPrefixed) return sendJson(res, 400, { error: 'missing srcPath' });
  // Empty destPrefixed is allowed — it means "the root of the source's
  // workspace" (i.e. drag a file to the workspace top level).

  const src = resolveWorkspacePath(srcPrefixed);
  if (!src) return sendJson(res, 403, { error: 'forbidden or unknown source workspace' });
  if (isWorkspaceRoot(src)) return sendJson(res, 400, { error: 'cannot move a workspace root' });

  let dest;
  if (destPrefixed) {
    dest = resolveWorkspacePath(destPrefixed);
    if (!dest) return sendJson(res, 403, { error: 'forbidden or unknown destination workspace' });
  } else {
    // Drop on a pane's blank area: assume same workspace, dest = root.
    dest = { fp: src.root.path, root: src.root, rel: '' };
  }

  let srcStat, destStat;
  try { srcStat = fs.statSync(src.fp); } catch { return sendJson(res, 404, { error: 'source not found' }); }
  try { destStat = fs.statSync(dest.fp); } catch { return sendJson(res, 404, { error: 'destination folder not found' }); }
  if (!destStat.isDirectory()) return sendJson(res, 400, { error: 'destination is not a folder' });

  // No-op: dragging onto its own parent.
  if (path.dirname(src.fp) === dest.fp) {
    return sendJson(res, 200, { ok: true, unchanged: true });
  }
  // Don't move a folder into itself or into one of its own descendants
  // (would orphan the tree).
  if (srcStat.isDirectory()) {
    const relInsideSrc = path.relative(src.fp, dest.fp);
    if (relInsideSrc === '' || (!relInsideSrc.startsWith('..') && !path.isAbsolute(relInsideSrc))) {
      return sendJson(res, 400, { error: 'cannot move a folder into itself' });
    }
  }

  const finalFp = path.join(dest.fp, path.basename(src.fp));
  // Defense in depth: the result must still live inside the destination
  // workspace (cross-workspace moves are allowed; cross-workspace *escapes*
  // via "../" parts are not).
  if (!safeInside(dest.root.path, finalFp)) {
    return sendJson(res, 400, { error: 'destination escapes workspace' });
  }
  if (fs.existsSync(finalFp)) {
    return sendJson(res, 409, { error: 'a file or folder with that name already exists at the destination' });
  }

  try {
    fs.renameSync(src.fp, finalFp);
  } catch (err) {
    if (err.code !== 'EXDEV') return sendJson(res, 500, { error: err.message });
    // Cross-volume — copy then delete.
    try {
      if (srcStat.isDirectory()) fs.cpSync(src.fp, finalFp, { recursive: true, force: false });
      else fs.copyFileSync(src.fp, finalFp);
      if (srcStat.isDirectory()) fs.rmSync(src.fp, { recursive: true, force: false });
      else fs.unlinkSync(src.fp);
    } catch (e2) {
      return sendJson(res, 500, { error: e2.message });
    }
  }

  const newRel = path.relative(dest.root.path, finalFp).split(path.sep).join('/');
  return sendJson(res, 200, {
    ok: true,
    oldPath: srcPrefixed,
    newPath: dest.root.name + (newRel ? '/' + newRel : ''),
    kind: srcStat.isDirectory() ? 'folder' : 'file',
  });
}

// ---------- copy (clipboard paste) ----------
// Same shape as /api/move but copies instead of renaming. On name collision
// at the destination, auto-renames with the Finder convention:
//   foo.md → foo copy.md → foo copy 2.md → …

function nextCopyName(destDir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  // First try "stem copy.ext", then "stem copy 2.ext", "stem copy 3.ext", …
  const baseCopy = stem + ' copy' + ext;
  if (!fs.existsSync(path.join(destDir, baseCopy))) return baseCopy;
  for (let n = 2; n < 1000; n++) {
    const candidate = stem + ' copy ' + n + ext;
    if (!fs.existsSync(path.join(destDir, candidate))) return candidate;
  }
  // Last-resort timestamp suffix — should never realistically hit this.
  return stem + ' copy ' + Date.now() + ext;
}

async function handleCopy(res, body) {
  const srcPrefixed = String((body && body.srcPath) || '');
  const destPrefixed = String((body && body.destFolder) || '');
  if (!srcPrefixed) return sendJson(res, 400, { error: 'missing srcPath' });

  const src = resolveWorkspacePath(srcPrefixed);
  if (!src) return sendJson(res, 403, { error: 'forbidden or unknown source workspace' });
  if (isWorkspaceRoot(src)) return sendJson(res, 400, { error: 'cannot copy a workspace root' });

  let dest;
  if (destPrefixed) {
    dest = resolveWorkspacePath(destPrefixed);
    if (!dest) return sendJson(res, 403, { error: 'forbidden or unknown destination workspace' });
  } else {
    dest = { fp: src.root.path, root: src.root, rel: '' };
  }

  let srcStat, destStat;
  try { srcStat = fs.statSync(src.fp); } catch { return sendJson(res, 404, { error: 'source not found' }); }
  try { destStat = fs.statSync(dest.fp); } catch { return sendJson(res, 404, { error: 'destination folder not found' }); }
  if (!destStat.isDirectory()) return sendJson(res, 400, { error: 'destination is not a folder' });

  // Don't recursively copy a folder into itself or one of its descendants —
  // would infinitely nest until we ran out of name budget.
  if (srcStat.isDirectory()) {
    const relInsideSrc = path.relative(src.fp, dest.fp);
    if (relInsideSrc === '' || (!relInsideSrc.startsWith('..') && !path.isAbsolute(relInsideSrc))) {
      return sendJson(res, 400, { error: 'cannot copy a folder into itself' });
    }
  }

  const origName = path.basename(src.fp);
  // Auto-rename on conflict. Pasting "foo.md" into a folder that already has
  // it produces "foo copy.md", matching Finder.
  const destName = fs.existsSync(path.join(dest.fp, origName))
    ? nextCopyName(dest.fp, origName)
    : origName;
  const finalFp = path.join(dest.fp, destName);
  if (!safeInside(dest.root.path, finalFp)) {
    return sendJson(res, 400, { error: 'destination escapes workspace' });
  }

  try {
    if (srcStat.isDirectory()) {
      fs.cpSync(src.fp, finalFp, { recursive: true, force: false, errorOnExist: true });
    } else {
      fs.copyFileSync(src.fp, finalFp, fs.constants.COPYFILE_EXCL);
    }
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }

  const newRel = path.relative(dest.root.path, finalFp).split(path.sep).join('/');
  return sendJson(res, 200, {
    ok: true,
    srcPath: srcPrefixed,
    newPath: dest.root.name + (newRel ? '/' + newRel : ''),
    kind: srcStat.isDirectory() ? 'folder' : 'file',
    renamed: destName !== origName,
  });
}

// ---------- create folder / create markdown file ----------
// Both endpoints take {parent, name} where parent is a workspace-prefixed
// folder path (e.g. "Business/Misc") — the workspace name alone is allowed
// for creating at the workspace root. Name validation matches rename.

async function handleMkdir(res, body) {
  const parentPrefixed = String((body && body.parent) || '');
  const name = String((body && body.name) || '').trim();
  if (!parentPrefixed) return sendJson(res, 400, { error: 'missing parent' });
  const v = validateRenameName(name);
  if (v) return sendJson(res, 400, { error: v });

  const r = resolveWorkspacePath(parentPrefixed);
  if (!r) return sendJson(res, 403, { error: 'forbidden or unknown workspace' });
  let stat;
  try { stat = fs.statSync(r.fp); } catch { return sendJson(res, 404, { error: 'parent not found' }); }
  if (!stat.isDirectory()) return sendJson(res, 400, { error: 'parent is not a folder' });

  const destFp = path.join(r.fp, name);
  if (!safeInside(r.root.path, destFp)) return sendJson(res, 400, { error: 'destination escapes workspace' });
  if (fs.existsSync(destFp)) return sendJson(res, 409, { error: 'a file or folder with that name already exists' });

  try {
    fs.mkdirSync(destFp);
    const rel = path.relative(r.root.path, destFp).split(path.sep).join('/');
    return sendJson(res, 200, { ok: true, path: r.root.name + '/' + rel });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleTouch(res, body) {
  const parentPrefixed = String((body && body.parent) || '');
  let name = String((body && body.name) || '').trim();
  if (!parentPrefixed) return sendJson(res, 400, { error: 'missing parent' });
  if (!name) return sendJson(res, 400, { error: 'name required' });
  // Auto-append .md if no extension supplied. Be lenient about which markdown
  // extensions we accept.
  if (!/\.(md|markdown)$/i.test(name)) name = name + '.md';
  const v = validateRenameName(name);
  if (v) return sendJson(res, 400, { error: v });

  const r = resolveWorkspacePath(parentPrefixed);
  if (!r) return sendJson(res, 403, { error: 'forbidden or unknown workspace' });
  let stat;
  try { stat = fs.statSync(r.fp); } catch { return sendJson(res, 404, { error: 'parent not found' }); }
  if (!stat.isDirectory()) return sendJson(res, 400, { error: 'parent is not a folder' });

  const destFp = path.join(r.fp, name);
  if (!safeInside(r.root.path, destFp)) return sendJson(res, 400, { error: 'destination escapes workspace' });
  if (fs.existsSync(destFp)) return sendJson(res, 409, { error: 'a file with that name already exists' });

  // Default content: a minimal heading derived from the filename stem so the
  // new file isn't a blank slate. Caller can override via body.content.
  let content = (body && typeof body.content === 'string') ? body.content : '';
  if (!content) {
    const stem = name.replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim();
    const title = stem.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled';
    content = `# ${title}\n\n`;
  }
  try {
    // Atomic create: write to .mdown-tmp-* then rename. Matches the editor's
    // save path so chokidar's ignore filter still catches the temp.
    const tmp = destFp + '.mdown-tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, destFp);
    const rel = path.relative(r.root.path, destFp).split(path.sep).join('/');
    return sendJson(res, 200, { ok: true, path: r.root.name + '/' + rel });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

// ---------- live reindex (chokidar → SSE) ----------
// One watcher per workspace root. Filesystem events get debounced and
// coalesced into a single full reindex; on success we broadcast an
// `index-changed` SSE event with the set of paths that triggered it so the
// client can decide what to refresh (tree always; current doc if affected).
//
// Atomic-write-then-rename (the pattern editors and Claude both use) is
// handled by the simple act of "any event triggers a full reindex" — chokidar
// surfaces it as some combination of add/change/unlink and we don't need to
// disambiguate. The 250ms debounce absorbs the burst.

const REINDEX_DEBOUNCE_MS = 250;
const SSE_HEARTBEAT_MS = 25_000;

const sseClients = new Set();
const pendingChangedPaths = new Set(); // workspace-prefixed paths
let reindexTimer = null;
let reindexInFlight = false;
let reindexQueued = false; // a change arrived while we were reindexing
let watchers = [];

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

function handleEventsStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, SSE_HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

// Skip events for files mdown itself touches, dotfiles/build artifacts that
// can never be in the index, and the indexer's own output. Mirrors the spirit
// of .mdownignore without re-parsing it (chokidar's `ignored` runs per event,
// so this stays hot).
function shouldIgnoreEvent(absPath) {
  const base = path.basename(absPath);
  if (!base) return false;
  // Self-loops: index.json is rewritten on every reindex; the temp file from
  // our atomic save would otherwise fire a noisy add+unlink burst.
  if (base === 'index.json' || base === 'settings.json') return true;
  if (base.startsWith('.') && base !== '.') return true;     // dotfiles
  if (base.includes('.mdown-tmp-')) return true;             // our own atomic-write tmp
  if (base === 'node_modules' || base === '.git') return true;
  if (base === '__pycache__' || base.endsWith('.pyc')) return true;
  return false;
}

// Workspace-prefixed path the client uses as a key in docsByPath.
function workspacePrefixedPath(rootName, rootPath, absPath) {
  const rel = path.relative(rootPath, absPath);
  if (!rel || rel.startsWith('..')) return null;
  return rootName + (rel ? '/' + rel.split(path.sep).join('/') : '');
}

function scheduleReindex() {
  if (reindexInFlight) { reindexQueued = true; return; }
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(runReindex, REINDEX_DEBOUNCE_MS);
}

function runReindex() {
  reindexTimer = null;
  reindexInFlight = true;
  const paths = Array.from(pendingChangedPaths);
  pendingChangedPaths.clear();

  const args = [path.join(SCRIPT_DIR, 'index.js')];
  for (const r of ROOTS) { args.push('-p', r.path); }
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let errBuf = '';
  child.stderr.on('data', d => { errBuf += d.toString(); });
  child.on('close', (code) => {
    reindexInFlight = false;
    if (code === 0) {
      broadcastEvent('index-changed', { paths });
    } else {
      broadcastEvent('index-error', { code, stderr: errBuf.slice(0, 2000) });
    }
    if (reindexQueued) {
      reindexQueued = false;
      scheduleReindex();
    }
  });
}

function startWatchers() {
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];

  for (const root of ROOTS) {
    const watcher = chokidar.watch(root.path, {
      ignored: (p) => shouldIgnoreEvent(p),
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      // Wait for the file size to stop changing before firing — catches editors
      // that do progressive writes. Atomic rename appears as a new file at full
      // size, so this doesn't delay it.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      // Avoid the ENOSPC trap on tight inotify limits (Linux-only concern, but
      // harmless on macOS where FSEvents is used).
      usePolling: false,
    });

    const onEvent = (absPath) => {
      const p = workspacePrefixedPath(root.name, root.path, absPath);
      if (p) pendingChangedPaths.add(p);
      scheduleReindex();
      // Also nudge auto-commit for filesystem edits made outside mdown
      // (Claude writes, an external editor, etc).
      const rel = path.relative(root.path, absPath).split(path.sep).join('/');
      if (rel && !rel.startsWith('..')) {
        try { scheduleAutoCommit(root.name, rel); } catch {}
      }
    };
    watcher.on('add',       onEvent);
    watcher.on('change',    onEvent);
    watcher.on('unlink',    onEvent);
    watcher.on('addDir',    onEvent);
    watcher.on('unlinkDir', onEvent);
    watcher.on('error', (err) => {
      // Don't crash — log and keep going. A single watcher dying shouldn't
      // take down the server.
      console.error(`mdown watcher error (${root.name}):`, err && err.message || err);
    });

    watchers.push(watcher);
  }
}

// ---------- Claude Code embedded terminal ----------
// A WebSocket on /terminal binds a real pseudo-terminal to `claude`, so the
// browser-side xterm.js renders the actual TUI byte-for-byte (signals, alt
// screen buffer, colors, slash commands). Read/write capabilities and auth
// match whatever the user has in their normal shell — we just relay bytes.
//
// Wire protocol (text frames, JSON):
//   client → server: {t:'in', d:string}                 keyboard input
//                    {t:'resize', cols:number, rows:number}
//   server → client: {t:'out', d:string}                pty stdout
//                    {t:'exit', code:number|null, signal:string|null}
//                    {t:'error', message:string}
function findClaudeBinary() {
  // GUI launches (Spotlight, .app) often have a stripped PATH that misses
  // /opt/homebrew/bin and /usr/local/bin. Try PATH first, then common spots.
  const candidates = ['claude'];
  for (const p of [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(process.env.HOME || '', '.local/bin/claude'),
    path.join(process.env.HOME || '', '.claude/local/claude'),
  ]) {
    try { if (fs.existsSync(p)) candidates.push(p); } catch {}
  }
  return candidates;
}

function pickTerminalCwd(query) {
  const docPath = (query && query.docPath) || '';
  const folderPath = (query && query.folderPath) || '';
  if (docPath) {
    const r = resolveWorkspacePath(docPath);
    if (r) return r.root.path;
  }
  if (folderPath) {
    const r = resolveWorkspacePath(folderPath);
    if (r) return r.root.path;
  }
  return ROOTS[0].path;
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  let query;
  try {
    const u = url.parse(req.url, true);
    pathname = u.pathname;
    query = u.query;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/terminal') {
    socket.destroy();
    return;
  }
  // Loopback-only — same origin check as everything else on this server.
  const host = req.headers.host || '';
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachTerminal(ws, query);
  });
});

function attachTerminal(ws, query) {
  const cwd = pickTerminalCwd(query);
  const cols = Math.max(20, Math.min(500, parseInt((query && query.cols) || '100', 10) || 100));
  const rows = Math.max(5,  Math.min(200, parseInt((query && query.rows) || '32',  10) || 32));

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  let term;
  let lastErr;
  for (const bin of findClaudeBinary()) {
    try {
      term = pty.spawn(bin, [], {
        name: 'xterm-256color',
        cols, rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!term) {
    send({ t: 'error', message:
      'Could not start Claude Code. Tried: ' + findClaudeBinary().join(', ') +
      '. Install with `npm i -g @anthropic-ai/claude-code` or from claude.ai/download. ' +
      'Underlying error: ' + (lastErr && lastErr.message || 'unknown')
    });
    try { ws.close(); } catch {}
    return;
  }

  term.onData((d) => send({ t: 'out', d }));
  term.onExit((e) => {
    send({ t: 'exit', code: e.exitCode, signal: e.signal || null });
    try { ws.close(); } catch {}
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'in' && typeof msg.d === 'string') {
      try { term.write(msg.d); } catch {}
    } else if (msg.t === 'resize') {
      const c = Math.max(20, Math.min(500, parseInt(msg.cols, 10) || cols));
      const r = Math.max(5,  Math.min(200, parseInt(msg.rows, 10) || rows));
      try { term.resize(c, r); } catch {}
    }
  });

  ws.on('close', () => {
    try { term.kill(); } catch {}
  });
  ws.on('error', () => {
    try { term.kill(); } catch {}
  });
}

// ---------- git / github handlers ----------

function readJsonBody(req, res, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 256 * 1024) req.destroy();
  });
  req.on('end', () => {
    let data = {};
    if (body.length) {
      try { data = JSON.parse(body); }
      catch { return sendJson(res, 400, { error: 'bad json' }); }
    }
    cb(data);
  });
  req.on('error', () => sendJson(res, 500, { error: 'request error' }));
}

function sendJson(res, code, obj) {
  sendText(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function requireWorkspaceByName(name) {
  const root = ROOT_BY_NAME.get(name);
  if (!root) return null;
  return root;
}

function gitSettingsView(absPath) {
  const cfg = getGitSettingsFor(absPath) || {};
  return {
    autoCommit: cfg.autoCommit !== false,   // default on
    autoPush:   cfg.autoPush   !== false,   // default on (only matters if connected)
    repo:       cfg.repo || null,           // "owner/name"
    branch:     cfg.branch || 'main',
    identity:   cfg.identity || null,
  };
}

async function handleGitStatus(res, query) {
  const name = query && query.workspace;
  const root = requireWorkspaceByName(name);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  try {
    const st = await gitOps.status(root.path);
    const cfg = gitSettingsView(root.path);
    const gh = readSettings().github;
    sendJson(res, 200, {
      ok: true,
      workspace: { name: root.name, path: root.path },
      git: st,
      config: cfg,
      github: { connected: !!gh.token, login: gh.login || null, name: gh.name || null,
                deviceFlow: github.deviceFlowAvailable() },
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitInit(res, body) {
  const root = requireWorkspaceByName(body.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  try {
    if (!gitOps.isRepo(root.path)) {
      await gitOps.init(root.path, {
        branch: body.branch || 'main',
        name: body.identity && body.identity.name,
        email: body.identity && body.identity.email,
      });
    }
    if (body.repoUrl) await gitOps.addRemote(root.path, body.repoUrl);
    // Persist identity so future commits use it.
    if (body.identity) setGitSettingsFor(root.path, { identity: body.identity });
    const st = await gitOps.status(root.path);
    sendJson(res, 200, { ok: true, git: st });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitCommit(res, body) {
  const root = requireWorkspaceByName(body.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  try {
    const r = await gitOps.commitAll(root.path, body.message || 'Update from mdown');
    if (!r) return sendJson(res, 200, { ok: true, noop: true });
    broadcastEvent('git-changed', { workspace: root.name, sha: r.sha });
    sendJson(res, 200, { ok: true, sha: r.sha, staged: r.staged });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitPush(res, body) {
  const root = requireWorkspaceByName(body.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  const token = getGithubToken();
  if (!token) return sendJson(res, 401, { error: 'not connected to github' });
  try {
    await gitOps.push(root.path, token, { branch: body.branch });
    const st = await gitOps.status(root.path);
    broadcastEvent('git-pushed', { workspace: root.name });
    sendJson(res, 200, { ok: true, git: st });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitPull(res, body) {
  const root = requireWorkspaceByName(body.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  const token = getGithubToken();
  if (!token) return sendJson(res, 401, { error: 'not connected to github' });
  try {
    await gitOps.pull(root.path, token, { branch: body.branch });
    const st = await gitOps.status(root.path);
    sendJson(res, 200, { ok: true, git: st });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitConfigure(res, body) {
  const root = requireWorkspaceByName(body.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  const cur = getGitSettingsFor(root.path) || {};
  const next = {
    ...cur,
    autoCommit: body.autoCommit !== undefined ? !!body.autoCommit : cur.autoCommit,
    autoPush:   body.autoPush   !== undefined ? !!body.autoPush   : cur.autoPush,
    repo:       body.repo !== undefined ? body.repo : cur.repo,
    branch:     body.branch || cur.branch || 'main',
    identity:   body.identity || cur.identity,
  };
  setGitSettingsFor(root.path, next);
  sendJson(res, 200, { ok: true, config: gitSettingsView(root.path) });
}

async function handleGitLog(res, query) {
  const root = requireWorkspaceByName(query && query.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  if (!gitOps.isRepo(root.path)) return sendJson(res, 200, { ok: true, commits: [] });
  const filepath = (query && query.path) || '';
  if (!filepath) return sendJson(res, 400, { error: 'missing path' });
  const limit = Math.min(500, parseInt(query.limit, 10) || 100);
  try {
    const commits = await gitOps.logForFile(root.path, filepath, limit);
    sendJson(res, 200, { ok: true, commits });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitDiff(res, query) {
  const root = requireWorkspaceByName(query && query.workspace);
  if (!root) return sendJson(res, 404, { error: 'unknown workspace' });
  const filepath = query.path;
  if (!filepath) return sendJson(res, 400, { error: 'missing path' });
  const oid = query.oid || null;
  const parent = query.parent || null;
  const working = query.working === '1';
  try {
    let r;
    if (working) {
      r = await gitOps.fileDiffAgainstWorking(root.path, filepath, oid);
    } else {
      r = await gitOps.fileDiff(root.path, parent, oid, filepath);
    }
    sendJson(res, 200, { ok: true, ...r });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGithubMe(res) {
  const s = readSettings();
  if (!s.github.token) return sendJson(res, 200, { connected: false, deviceFlow: github.deviceFlowAvailable() });
  // Don't re-validate on every call — return what we cached. The user can hit
  // disconnect/reconnect if the token has rotted.
  sendJson(res, 200, {
    connected: true, login: s.github.login || null, name: s.github.name || null,
    deviceFlow: github.deviceFlowAvailable(),
  });
}

async function handleGithubConnect(res, body) {
  const token = body && body.token;
  if (!token || typeof token !== 'string') return sendJson(res, 400, { error: 'missing token' });
  try {
    const me = await github.whoami(token);
    setGithubToken(token, me);
    sendJson(res, 200, { ok: true, connected: true, login: me.login, name: me.name });
  } catch (err) {
    sendJson(res, 401, { error: 'token rejected: ' + err.message });
  }
}

function handleGithubDisconnect(res) {
  setGithubToken(null);
  sendJson(res, 200, { ok: true });
}

function handleGithubDeviceStart(res) {
  if (!github.deviceFlowAvailable()) {
    return sendJson(res, 400, { error: 'device flow disabled (set MDOWN_GITHUB_CLIENT_ID)' });
  }
  try {
    const s = github.startDeviceFlow();
    sendJson(res, 200, { ok: true, id: s.id });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGithubDevicePoll(res, query) {
  const id = query && query.id;
  if (!id) return sendJson(res, 400, { error: 'missing id' });
  const s = github.pollDeviceFlow(id);
  if (s.error) return sendJson(res, 500, { error: s.error });
  if (s.token) {
    try {
      const me = await github.whoami(s.token);
      setGithubToken(s.token, me);
      github.cancelDeviceFlow(id);
      return sendJson(res, 200, { ok: true, done: true, login: me.login, name: me.name });
    } catch (err) {
      return sendJson(res, 500, { error: 'token validation failed: ' + err.message });
    }
  }
  sendJson(res, 200, { ok: true, done: false, verification: s.verification || null });
}

async function handleGithubCreateRepo(res, body) {
  const token = getGithubToken();
  if (!token) return sendJson(res, 401, { error: 'not connected to github' });
  if (!body.name) return sendJson(res, 400, { error: 'missing name' });
  try {
    const repo = await github.createRepo(token, {
      name: body.name,
      owner: body.owner,
      isPrivate: body.private !== false,
      description: body.description,
    });
    sendJson(res, 200, {
      ok: true,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch || 'main',
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// ---------- auto-commit / auto-push ----------
// Debounced per-workspace. Coalesces many saves into one commit; an autoPush
// follows when configured and GitHub is connected. Errors are broadcast over
// SSE but never thrown to the saver — autosave must not break user flow.

const AUTOCOMMIT_DELAY_MS = 8000;
const autoCommitTimers = new Map();
const autoCommitPending = new Map();

function scheduleAutoCommit(rootName, relPath) {
  const root = requireWorkspaceByName(rootName);
  if (!root || !gitOps.isRepo(root.path)) return;
  const cfg = gitSettingsView(root.path);
  if (!cfg.autoCommit) return;
  let set = autoCommitPending.get(rootName);
  if (!set) { set = new Set(); autoCommitPending.set(rootName, set); }
  if (relPath) set.add(relPath);
  if (autoCommitTimers.has(rootName)) clearTimeout(autoCommitTimers.get(rootName));
  autoCommitTimers.set(rootName, setTimeout(() => runAutoCommit(rootName), AUTOCOMMIT_DELAY_MS));
}

async function runAutoCommit(rootName) {
  autoCommitTimers.delete(rootName);
  const root = requireWorkspaceByName(rootName);
  if (!root) return;
  const cfg = gitSettingsView(root.path);
  const files = Array.from(autoCommitPending.get(rootName) || []);
  autoCommitPending.delete(rootName);
  const msg = files.length === 1
    ? `mdown: edit ${files[0]}`
    : `mdown: edit ${files.length} files`;
  try {
    const r = await gitOps.commitAll(root.path, msg);
    if (!r) return;
    broadcastEvent('git-changed', { workspace: rootName, sha: r.sha, files });
    const token = getGithubToken();
    if (cfg.autoPush && token) {
      try {
        await gitOps.push(root.path, token);
        broadcastEvent('git-pushed', { workspace: rootName });
      } catch (err) {
        broadcastEvent('git-error', { workspace: rootName, op: 'push', message: err.message });
      }
    }
  } catch (err) {
    broadcastEvent('git-error', { workspace: rootName, op: 'commit', message: err.message });
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mdown: http://127.0.0.1:${PORT}/`);
  for (const r of ROOTS) console.log(`       workspace: ${r.name}  →  ${r.path}`);
  if (!fs.existsSync(INDEX_PATH)) {
    console.log(`       no index found — click "Reindex" in the UI or run: node ${path.relative(process.cwd(), path.join(SCRIPT_DIR, 'index.js'))}`);
  }
  startWatchers();
  console.log(`       watching ${ROOTS.length} workspace${ROOTS.length === 1 ? '' : 's'} for changes`);
});
