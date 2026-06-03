#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// ClawDoc index generator — walks the workspace and produces index.json
// Run: node index.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
// Writable data directory — overridable so packaged apps can redirect to userData.
const DATA_DIR = process.env.CLAWDOC_DATA_DIR || SCRIPT_DIR;
// Index file stays alongside the ClawDoc scripts, regardless of workspace.
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
// Full-body search payload (#29). Kept separate from index.json so the doc
// list stays lean — index.json ships short previews, search.json the full text.
const SEARCH_PATH = path.join(DATA_DIR, 'search.json');

// Parse one or more -p / --path flags from argv. Returns absolute paths.
// Falls back to settings.json (written by serve.js / the UI), then
// CLAWDOC_ROOT, then process.cwd().
function parseRootPaths(argv) {
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
  if (out.length) return out;
  // Try settings.json
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (s && Array.isArray(s.workspaces) && s.workspaces.length) {
        return s.workspaces.map(p => path.resolve(p));
      }
    } catch {}
  }
  return [path.resolve(process.env.CLAWDOC_ROOT || process.cwd())];
}

// Assign a unique display name to each workspace, derived from basename.
// Collisions get a numeric suffix: Business, Business-2, ...
function namedRoots(paths) {
  const used = new Map();
  return paths.map(p => {
    let base = path.basename(p) || p;
    let name = base;
    let n = 2;
    while (used.has(name)) name = base + '-' + n++;
    used.set(name, true);
    return { name, path: p };
  });
}

const ROOTS = namedRoots(parseRootPaths(process.argv));

const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  '.DS_Store',
  '.vscode',
  '.idea',
  'archive',
  'Downloads',
];

// File classification. Every file is indexed and shown in the tree; `kind`
// tells the UI how to render it (rich markdown/html, inline pdf/image,
// editable spreadsheet, monospace text, or a graceful "no preview" card for
// everything else).
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);
const PDF_EXTS = new Set(['.pdf']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);
// Spreadsheets (#24): rendered/edited in the Univer grid. .csv is also text,
// so its body is indexed for search; .xlsx is binary.
const SHEET_EXTS = new Set(['.csv', '.xlsx']);
// Word documents (#27): rendered/edited in the SuperDoc editor. Binary.
const DOCX_EXTS = new Set(['.docx']);
// Plain-text-ish files: rendered as monospace, body extracted so search works.
const TEXT_EXTS = new Set([
  '.txt', '.text', '.tsv', '.json', '.jsonc', '.yaml', '.yml', '.xml',
  '.toml', '.ini', '.cfg', '.conf', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.r', '.lua', '.pl',
  '.swift', '.kt', '.dart', '.vue', '.svelte',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // only read text bodies for files <= 2 MB
const MAX_PDF_BYTES = 25 * 1024 * 1024; // extract PDF text for files <= 25 MB
// Full body text is indexed for search (#29). docs[] carries only a short
// preview (the doc list is iterated everywhere and held in memory); the full
// body lives in search.json and powers the in-browser MiniSearch index.
const BODY_PREVIEW = 300;

function fileKind(ext) {
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (HTML_EXTS.has(ext)) return 'html';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (SHEET_EXTS.has(ext)) return 'sheet';
  if (DOCX_EXTS.has(ext)) return 'docx';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

function readIgnoreFile() {
  const p = path.join(SCRIPT_DIR, '.clawdocignore');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function shouldIgnore(relPath, name, ignores) {
  for (const pat of ignores) {
    if (!pat) continue;
    if (name === pat) return true;
    if (relPath === pat) return true;
    if (relPath.startsWith(pat + '/')) return true;
  }
  return false;
}

function extractTitleMd(content) {
  // Try YAML front-matter title first
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end > 0) {
      const fm = content.slice(3, end);
      const m = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      if (m) return m[1].trim();
    }
  }
  const lines = content.split('\n');
  for (const l of lines) {
    const m = l.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

function extractTitleHtml(content) {
  const m = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  const h1 = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return null;
}

function stripFrontMatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return content;
  return content.slice(end + 4);
}

function plainTextFromMd(content) {
  let s = stripFrontMatter(content);
  s = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>*\-+]+\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function plainTextFromHtml(content) {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// PDF text extraction at index time (#29). Uses the system `pdftotext`
// (poppler) when present; without it, PDFs fall back to metadata-only indexing.
let _pdftotext = null;
function hasPdftotext() {
  if (_pdftotext !== null) return _pdftotext;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); _pdftotext = true; }
  catch { _pdftotext = false; }
  return _pdftotext;
}

function plainTextFromPdf(full) {
  try {
    const out = execFileSync('pdftotext', ['-q', '-enc', 'UTF-8', full, '-'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    return out.toString('utf8').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

function extractLinksMd(content) {
  const out = [];
  const reLink = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = reLink.exec(content)) !== null) {
    let href = m[1].split(/\s+/)[0];
    href = href.replace(/^["']|["']$/g, '');
    if (href) out.push(href);
  }
  return out;
}

function extractLinksHtml(content) {
  const out = [];
  const reLink = /<a[^>]+href=["']([^"']+)["']/gi;
  let m;
  while ((m = reLink.exec(content)) !== null) out.push(m[1]);
  return out;
}

function parseFilename(name) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})[_-]([^_]+)[_-](.+)\.[a-zA-Z]+$/);
  if (m) return { date: m[1], project: m[2], docType: m[3].replace(/[_-]+/g, ' ') };
  const m2 = name.match(/^(\d{4}-\d{2}-\d{2})[_-](.+)\.[a-zA-Z]+$/);
  if (m2) return { date: m2[1], project: null, docType: m2[2].replace(/[_-]+/g, ' ') };
  return { date: null, project: null, docType: null };
}

function isExternalOrAnchor(href) {
  return /^([a-z][a-z0-9+.-]*:|#|mailto:|tel:)/i.test(href);
}

function walk(dir, ignores, docs, folders, root, fullBodies) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root.path, full);
    if (shouldIgnore(rel, e.name, ignores)) continue;
    // Workspace-prefixed path used everywhere in the index. The server uses
    // doc.root + doc.relPath to resolve back to disk.
    const prefixed = root.name + '/' + rel;
    if (e.isDirectory()) {
      folders.add(prefixed);
      walk(full, ignores, docs, folders, root, fullBodies);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const kind = fileKind(ext);
      // markdown/html/text carry searchable body text. .csv is a 'sheet' but
      // also plain text, so its raw contents are indexed too. Images, PDFs,
      // .xlsx and unknown binaries are indexed for the tree but never read.
      const textual = kind === 'markdown' || kind === 'html' || kind === 'text'
        || (kind === 'sheet' && ext === '.csv');
      let title = null, body = '', links = [];
      if (textual && stat.size <= MAX_FILE_BYTES) {
        let content = '';
        try { content = fs.readFileSync(full, 'utf8'); } catch { content = ''; }
        if (kind === 'markdown') {
          title = extractTitleMd(content);
          body = plainTextFromMd(content);
          links = extractLinksMd(content).filter(l => !isExternalOrAnchor(l));
        } else if (kind === 'html') {
          title = extractTitleHtml(content);
          body = plainTextFromHtml(content);
          links = extractLinksHtml(content).filter(l => !isExternalOrAnchor(l));
        } else {
          // text + .csv: index the raw contents so cell/source text is searchable.
          body = content.replace(/\s+/g, ' ').trim();
        }
      } else if (kind === 'pdf' && stat.size <= MAX_PDF_BYTES && hasPdftotext()) {
        // PDFs are now searchable by their extracted text, not just filename (#29).
        body = plainTextFromPdf(full);
      }
      // Full body powers search.json; index.json keeps only a short preview.
      if (body) fullBodies.set(prefixed, body);
      const parsed = parseFilename(e.name);
      docs.push({
        path: prefixed,
        root: root.name,
        relPath: rel,
        name: e.name,
        folder: path.dirname(prefixed),
        ext: ext.slice(1),
        kind,
        title: title || e.name.replace(/\.[^.]+$/, ''),
        date: parsed.date || stat.mtime.toISOString().slice(0, 10),
        mdate: stat.mtime.toISOString().slice(0, 10),
        project: parsed.project,
        docType: parsed.docType,
        size: stat.size,
        mtime: stat.mtimeMs,
        body: body.slice(0, BODY_PREVIEW),
        bodyLen: body.length,
        links,
      });
    }
  }
}

function buildBacklinks(docs) {
  const byPath = new Map(docs.map(d => [d.path, d]));
  const backlinks = new Map();
  for (const d of docs) {
    for (const l of d.links) {
      const clean = l.split('#')[0].split('?')[0];
      if (!clean) continue;
      const target = path.normalize(path.join(d.folder, clean));
      if (byPath.has(target)) {
        if (!backlinks.has(target)) backlinks.set(target, []);
        backlinks.get(target).push(d.path);
      }
    }
  }
  for (const d of docs) d.backlinks = Array.from(new Set(backlinks.get(d.path) || []));
}

function main() {
  const ignores = [...DEFAULT_IGNORES, ...readIgnoreFile()];
  const docs = [];
  const folders = new Set();
  const fullBodies = new Map();
  const t0 = Date.now();

  for (const root of ROOTS) {
    // Skip ClawDoc's own folder if it happens to live inside this workspace.
    const rootIgnores = ignores.slice();
    const scriptRel = path.relative(root.path, SCRIPT_DIR);
    if (scriptRel && !scriptRel.startsWith('..') && !path.isAbsolute(scriptRel)) {
      rootIgnores.push(scriptRel);
    }
    walk(root.path, rootIgnores, docs, folders, root, fullBodies);
  }

  buildBacklinks(docs);
  docs.sort((a, b) => a.path.localeCompare(b.path));
  const index = {
    roots: ROOTS,
    generatedAt: new Date().toISOString(),
    folders: Array.from(folders).sort(),
    docs,
    stats: {
      docCount: docs.length,
      folderCount: folders.size,
      md: docs.filter(d => d.kind === 'markdown').length,
      html: docs.filter(d => d.kind === 'html').length,
      pdf: docs.filter(d => d.kind === 'pdf').length,
      xls: docs.filter(d => d.kind === 'sheet').length,
      docx: docs.filter(d => d.kind === 'docx').length,
      image: docs.filter(d => d.kind === 'image').length,
      text: docs.filter(d => d.kind === 'text').length,
      binary: docs.filter(d => d.kind === 'binary').length,
      pdfText: docs.filter(d => d.kind === 'pdf' && d.bodyLen > 0).length,
      durationMs: Date.now() - t0,
    },
  };
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));

  // search.json: full body text keyed by path, consumed by the in-browser
  // MiniSearch index. Kept out of index.json so the doc list stays lean.
  const texts = {};
  for (const [p, b] of fullBodies) texts[p] = b;
  fs.writeFileSync(SEARCH_PATH, JSON.stringify({ generatedAt: index.generatedAt, texts }));

  const rootSummary = ROOTS.map(r => r.name + ' → ' + r.path).join(', ');
  const s = index.stats;
  console.log(`clawdoc: indexed ${docs.length} docs (${s.md} md, ${s.html} html, ${s.pdf} pdf, ${s.xls} sheets, ${s.docx} docx, ${s.image} image, ${s.text} text, ${s.binary} other) across ${folders.size} folders in ${s.durationMs}ms`);
  console.log(`        roots: ${rootSummary}`);
  console.log(`        full-text bodies: ${fullBodies.size} (incl. ${s.pdfText} pdf)${hasPdftotext() ? '' : ' — pdftotext not found; PDFs indexed by metadata only'}`);
  console.log(`        -> ${INDEX_PATH}`);
  console.log(`        -> ${SEARCH_PATH}`);
}

main();
