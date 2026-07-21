// Git operations for ClawDoc workspaces.
//
// Wraps isomorphic-git so we can ship Git inside the .app without requiring
// the user to install git(1). All operations are scoped to a single workspace
// (absolute directory path).

const fs = require('fs');
const path = require('path');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const { diffLines, createTwoFilesPatch } = require('diff');

const DEFAULT_AUTHOR = { name: 'clawdoc', email: 'clawdoc@local' };

// `isomorphic-git` wants `{ fs, dir }` everywhere; this trims the boilerplate.
//
// The `cache` matters as much as the path. Without one, isomorphic-git starts
// each call with an empty cache, so the first object it reads out of a packfile
// re-reads the entire .pack into memory and re-verifies its SHA-1. Once a
// workspace's pack has been gc'd into a single ~1GB file that costs seconds and
// gigabytes of allocation *per call* — and status() makes hundreds of calls via
// countAheadBehind. One cache per workspace, held for the process lifetime,
// collapses that to a single load.
const caches = new Map();
const ctx = (dir) => {
  let cache = caches.get(dir);
  if (!cache) { cache = {}; caches.set(dir, cache); }
  return { fs, dir, cache };
};

function isRepo(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isDirectory(); }
  catch { return false; }
}

async function status(dir) {
  const out = {
    isRepo: false, branch: null, remote: null,
    head: null, ahead: 0, behind: 0,
    dirty: false, changed: 0, untracked: 0, staged: 0,
  };
  if (!isRepo(dir)) return out;
  out.isRepo = true;
  try { out.branch = await git.currentBranch({ ...ctx(dir), fullname: false }) || null; } catch {}
  try {
    const remotes = await git.listRemotes(ctx(dir));
    const origin = remotes.find(r => r.remote === 'origin') || remotes[0];
    if (origin) out.remote = origin.url;
  } catch {}
  try { out.head = await git.resolveRef({ ...ctx(dir), ref: 'HEAD' }); } catch {}

  // Compute working-tree summary cheaply. statusMatrix returns one row per
  // tracked-or-untracked file: [filepath, head, workdir, stage]. Anything
  // where workdir !== head (or workdir !== stage) is "changed".
  try {
    const m = await git.statusMatrix(ctx(dir));
    for (const [, h, w, s] of m) {
      if (h === 0 && w === 2 && s === 0) out.untracked++;
      else if (w !== h) out.changed++;
      if (s !== h && s !== 0) out.staged++;
    }
    out.dirty = (out.changed + out.untracked + out.staged) > 0;
  } catch {}

  // ahead/behind vs origin/<branch>
  if (out.branch && out.head) {
    try {
      const tracked = await git.resolveRef({ ...ctx(dir), ref: `refs/remotes/origin/${out.branch}` });
      const { ahead, behind } = await countAheadBehind(dir, out.head, tracked);
      out.ahead = ahead;
      out.behind = behind;
    } catch {}
  }
  return out;
}

// Walk two histories and count divergence. isomorphic-git has no built-in
// "rev-list --count A..B", so walk out from each tip and stop the moment we
// reach the other one — the commits traversed before that *are* the divergence.
//
// Stopping early matters for more than speed. isomorphic-git reads an entire
// .pack into memory (and SHA-1 verifies it) the first time it wants a packed
// object. Recent commits are normally loose, so a walk that ends after a few
// steps never touches the pack at all, while one that runs to `cap` pins ~1GB
// for a workspace whose history has been gc'd into a single packfile. Histories
// that have genuinely diverged further than `cap` still report the capped
// number, exactly as before.
// Memoized on the tip pair: the answer can only change when one of the two refs
// moves, so a 60s status poll shouldn't re-walk history it already walked.
const aheadBehindMemo = new Map(); // dir -> { local, remote, ahead, behind }

async function countAheadBehind(dir, local, remote) {
  if (local === remote) return { ahead: 0, behind: 0 };
  const memo = aheadBehindMemo.get(dir);
  if (memo && memo.local === local && memo.remote === remote) {
    return { ahead: memo.ahead, behind: memo.behind };
  }

  // High enough that a workspace left unpushed for months still resolves to a
  // true ancestor count rather than a made-up "diverged both ways", low enough
  // to stay bounded. Only reached once per tip pair thanks to the memo above.
  const cap = 1000;
  // Commits traversed walking back from `start` before reaching `stop`, or null
  // if `stop` isn't an ancestor of `start` within `cap`.
  const distanceTo = async (start, stop) => {
    const seen = new Set();
    const stack = [start];
    let n = 0;
    while (stack.length && n < cap) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      if (oid === stop) return n;
      seen.add(oid);
      n++;
      let c;
      try { c = await git.readCommit({ ...ctx(dir), oid }); } catch { continue; }
      for (const p of c.commit.parent) stack.push(p);
    }
    return null;
  };

  // Nearly always one tip is simply an ancestor of the other ("N to push",
  // "N to pull"). Answering that takes one short walk, which on a synced repo
  // stays inside the loose objects and never faults in the packfile. Only a
  // genuine fork needs both walks.
  let out;
  const ahead = await distanceTo(local, remote);
  if (ahead !== null) out = { ahead, behind: 0 };
  else {
    const behind = await distanceTo(remote, local);
    out = behind !== null ? { ahead: 0, behind } : { ahead: cap, behind: cap };
  }
  aheadBehindMemo.set(dir, { local, remote, ...out });
  return out;
}

async function init(dir, opts = {}) {
  await git.init({ ...ctx(dir), defaultBranch: opts.branch || 'main' });
  if (opts.name || opts.email) {
    await git.setConfig({ ...ctx(dir), path: 'user.name',  value: opts.name  || DEFAULT_AUTHOR.name });
    await git.setConfig({ ...ctx(dir), path: 'user.email', value: opts.email || DEFAULT_AUTHOR.email });
  }
  ensureGitignore(dir);
}

// Default ignores so a ClawDoc user doesn't accidentally commit transient files
// from the workspace (.DS_Store, node_modules, ClawDoc's atomic-write temps, etc).
const DEFAULT_GITIGNORE = [
  '.DS_Store',
  'node_modules/',
  '.clawdoc-tmp-*',
].join('\n') + '\n';

function ensureGitignore(dir) {
  const gi = path.join(dir, '.gitignore');
  if (fs.existsSync(gi)) return;
  try { fs.writeFileSync(gi, DEFAULT_GITIGNORE, 'utf8'); } catch {}
}

async function addRemote(dir, url, name = 'origin') {
  // setRemote == add-or-update
  try { await git.deleteRemote({ ...ctx(dir), remote: name }); } catch {}
  await git.addRemote({ ...ctx(dir), remote: name, url, force: true });
}

async function getAuthor(dir) {
  let name, email;
  try { name  = await git.getConfig({ ...ctx(dir), path: 'user.name' }); } catch {}
  try { email = await git.getConfig({ ...ctx(dir), path: 'user.email' }); } catch {}
  return { name: name || DEFAULT_AUTHOR.name, email: email || DEFAULT_AUTHOR.email };
}

// Stage everything that's changed/untracked, then commit. Returns null if
// there's nothing to commit (so callers can no-op silently from autosave).
async function commitAll(dir, message) {
  const m = await git.statusMatrix(ctx(dir));
  let staged = 0;
  for (const [filepath, h, w] of m) {
    if (w === 0 && h !== 0) {
      // Deleted in workdir.
      await git.remove({ ...ctx(dir), filepath });
      staged++;
    } else if (w !== h) {
      await git.add({ ...ctx(dir), filepath });
      staged++;
    }
  }
  if (!staged) return null;
  const author = await getAuthor(dir);
  const sha = await git.commit({ ...ctx(dir), message, author });
  return { sha, staged };
}

function makeAuth(token) {
  // GitHub's HTTPS auth: any username + token as password works.
  return () => ({ username: 'x-access-token', password: token });
}

async function push(dir, token, opts = {}) {
  const branch = opts.branch || await git.currentBranch({ ...ctx(dir), fullname: false });
  const remote = opts.remote || 'origin';
  return git.push({
    ...ctx(dir), http, remote, ref: branch,
    onAuth: makeAuth(token),
    force: false,
  });
}

async function pull(dir, token, opts = {}) {
  const branch = opts.branch || await git.currentBranch({ ...ctx(dir), fullname: false });
  const author = await getAuthor(dir);
  return git.pull({
    ...ctx(dir), http, ref: branch, singleBranch: true,
    onAuth: makeAuth(token),
    author,
    fastForwardOnly: true,
  });
}

async function fetch(dir, token, opts = {}) {
  return git.fetch({
    ...ctx(dir), http, remote: opts.remote || 'origin',
    onAuth: makeAuth(token),
    tags: false,
  });
}

// History of commits that touched `filepath`, newest first. Walks HEAD and
// keeps a commit when the file's tree-oid differs from at least one parent.
async function logForFile(dir, filepath, limit = 100) {
  const commits = await git.log({ ...ctx(dir), depth: 1000 });
  const out = [];
  for (const entry of commits) {
    const oid = entry.oid;
    let curOid;
    try { curOid = await blobOidAt(dir, oid, filepath); } catch { curOid = null; }
    let changed = false;
    if (entry.commit.parent.length === 0) {
      changed = curOid !== null; // first commit introduces it
    } else {
      for (const p of entry.commit.parent) {
        let parentOid;
        try { parentOid = await blobOidAt(dir, p, filepath); } catch { parentOid = null; }
        if (parentOid !== curOid) { changed = true; break; }
      }
    }
    if (changed) {
      out.push({
        oid,
        message: entry.commit.message,
        author: entry.commit.author,
        committer: entry.commit.committer,
        parents: entry.commit.parent,
        present: curOid !== null,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function blobOidAt(dir, commitOid, filepath) {
  // git.resolveRef can take an oid; walk the tree manually with readTree.
  const { commit } = await git.readCommit({ ...ctx(dir), oid: commitOid });
  let treeOid = commit.tree;
  const parts = filepath.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const tree = (await git.readTree({ ...ctx(dir), oid: treeOid })).tree;
    const entry = tree.find(e => e.path === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      return entry.type === 'blob' ? entry.oid : null;
    }
    if (entry.type !== 'tree') return null;
    treeOid = entry.oid;
  }
  return null;
}

async function readFileAtCommit(dir, oid, filepath) {
  const blobOid = await blobOidAt(dir, oid, filepath);
  if (!blobOid) return null;
  const { blob } = await git.readBlob({ ...ctx(dir), oid: blobOid });
  return Buffer.from(blob).toString('utf8');
}

// Unified diff of `filepath` between two commits (either may be null/empty).
async function fileDiff(dir, oldOid, newOid, filepath) {
  const before = oldOid ? (await readFileAtCommit(dir, oldOid, filepath)) || '' : '';
  const after  = newOid ? (await readFileAtCommit(dir, newOid, filepath)) || '' : '';
  if (before === after) {
    return { unchanged: true, patch: '', before, after };
  }
  const patch = createTwoFilesPatch(
    filepath, filepath,
    before, after,
    oldOid ? oldOid.slice(0, 7) : 'empty',
    newOid ? newOid.slice(0, 7) : 'empty',
    { context: 3 }
  );
  return { unchanged: false, patch, before, after };
}

// Diff of working-tree vs HEAD (or vs a specific commit) for one file.
async function fileDiffAgainstWorking(dir, filepath, baseOid) {
  const base = baseOid || (await git.resolveRef({ ...ctx(dir), ref: 'HEAD' }).catch(() => null));
  const before = base ? (await readFileAtCommit(dir, base, filepath)) || '' : '';
  let after = '';
  try { after = fs.readFileSync(path.join(dir, filepath), 'utf8'); } catch {}
  if (before === after) return { unchanged: true, patch: '', before, after };
  const patch = createTwoFilesPatch(
    filepath, filepath, before, after,
    base ? base.slice(0, 7) : 'empty', 'working',
    { context: 3 }
  );
  return { unchanged: false, patch, before, after };
}

module.exports = {
  isRepo,
  status,
  init,
  addRemote,
  commitAll,
  push,
  pull,
  fetch,
  logForFile,
  readFileAtCommit,
  fileDiff,
  fileDiffAgainstWorking,
  getAuthor,
  ensureGitignore,
};
