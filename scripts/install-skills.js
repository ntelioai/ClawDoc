#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Installs the skills bundled under skills/ into ~/.claude/skills/ so the
// embedded Claude agent (and the CLI outside ClawDoc) can use them.
//
//   node scripts/install-skills.js            # symlink all bundled skills
//   node scripts/install-skills.js crm        # just one
//   node scripts/install-skills.js --copy     # copy instead of symlink
//   node scripts/install-skills.js --list     # show what's bundled + current state
//
// Symlink is the default and the point: a later `git pull` updates the skill in
// place with no reinstall. --copy exists for Windows without Developer Mode,
// where creating a symlink needs elevation.
//
// An existing real directory at the target is never deleted — it is moved to
// ~/.claude/skills-backup/ first, so a pre-existing local copy is recoverable.
// The backup deliberately lands OUTSIDE ~/.claude/skills, or Claude Code would
// load it as a second, stale copy of the same skill.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC_ROOT = path.join(__dirname, '..', 'skills');
const DEST_ROOT = path.join(os.homedir(), '.claude', 'skills');
const BACKUP_ROOT = path.join(os.homedir(), '.claude', 'skills-backup');

const args = process.argv.slice(2);
const copy = args.includes('--copy');
const list = args.includes('--list');
const names = args.filter((a) => !a.startsWith('-'));

function bundled() {
  if (!fs.existsSync(SRC_ROOT)) return [];
  return fs
    .readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SRC_ROOT, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

function describe(name) {
  const dest = path.join(DEST_ROOT, name);
  const src = path.join(SRC_ROOT, name);
  let state = 'not installed';
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) {
      const target = fs.realpathSync(dest);
      state = target === fs.realpathSync(src) ? 'linked to this repo' : `linked elsewhere → ${target}`;
    } else {
      state = 'local copy (not linked)';
    }
  } catch { /* not installed */ }
  return state;
}

function backup(dest, name) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  let bak = path.join(BACKUP_ROOT, name);
  for (let i = 2; fs.existsSync(bak); i++) bak = path.join(BACKUP_ROOT, `${name}.${i}`);
  fs.renameSync(dest, bak);
  return bak;
}

function install(name) {
  const src = path.join(SRC_ROOT, name);
  const dest = path.join(DEST_ROOT, name);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    console.error(`  ${name}: no such bundled skill`);
    return false;
  }
  fs.mkdirSync(DEST_ROOT, { recursive: true });

  let existing = null;
  try {
    existing = fs.lstatSync(dest);
  } catch { /* nothing there */ }

  if (existing) {
    if (existing.isSymbolicLink()) {
      fs.unlinkSync(dest); // a link we can safely replace
    } else {
      const bak = backup(dest, name);
      console.log(`  ${name}: existing directory moved to ${bak}`);
    }
  }

  if (copy) {
    fs.cpSync(src, dest, { recursive: true, filter: (p) => !p.includes('__pycache__') });
    console.log(`  ${name}: copied → ${dest}`);
  } else {
    try {
      fs.symlinkSync(src, dest, 'dir');
      console.log(`  ${name}: linked → ${dest}`);
    } catch (e) {
      console.error(`  ${name}: symlink failed (${e.code}); retry with --copy`);
      return false;
    }
  }
  return true;
}

const all = bundled();
if (!all.length) {
  console.error('No skills found under skills/');
  process.exit(1);
}

if (list) {
  console.log('Bundled skills:');
  for (const n of all) console.log(`  ${n.padEnd(16)} ${describe(n)}`);
  process.exit(0);
}

const targets = names.length ? names : all;
console.log(`Installing ${targets.length} skill(s) into ${DEST_ROOT}`);
const ok = targets.map(install).every(Boolean);
if (!copy && ok) console.log('A later `git pull` now updates these in place.');
process.exit(ok ? 0 : 1);
