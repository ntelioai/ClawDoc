#!/usr/bin/env node
/* ClawDoc-bundled pandoc CLI (pandoc-wasm).
 *
 * A small command-line front-end over the vendored pandoc WebAssembly build so
 * the embedded Claude Code terminal — or anything else on PATH — can run
 * `pandoc` without a native install. Supports the common forms an agent reaches
 * for: `pandoc in.md -o out.docx`, `pandoc -f docx -t markdown in.docx`,
 * stdin→stdout pipelines, and `pandoc --version`.
 *
 * It is NOT a 100% drop-in for native pandoc (no PDF engine, no Lua filters,
 * no network resources), but covers md/html/docx/odt/rtf/rst/latex/epub/…
 * text⇄binary conversions, which is the bulk of what document workflows need.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Extension → pandoc format. Anything not listed falls back to 'markdown'.
const EXT_FORMAT = {
  md: 'markdown', markdown: 'markdown', txt: 'markdown',
  html: 'html', htm: 'html', xhtml: 'html',
  docx: 'docx', odt: 'odt', rtf: 'rtf', epub: 'epub',
  tex: 'latex', latex: 'latex', rst: 'rst', org: 'org',
  json: 'json', man: 'man', rdf: 'rst', textile: 'textile',
  csv: 'csv', ipynb: 'ipynb', adoc: 'asciidoc', asciidoc: 'asciidoc',
  pptx: 'pptx', wiki: 'mediawiki',
};
// Formats pandoc reads/writes as binary (must be passed/saved as bytes).
const BINARY_FORMATS = new Set(['docx', 'odt', 'epub', 'pptx', 'xlsx']);

function fmtFromPath(p) { return p ? EXT_FORMAT[extname(p).slice(1).toLowerCase()] : null; }

function parseArgs(argv) {
  const o = { from: null, to: null, output: null, inputs: [], standalone: false, version: false, listFormats: null, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--version' || a === '-v') o.version = true;
    else if (a === '-f' || a === '-r' || a === '--from' || a === '--read') o.from = next();
    else if (a.startsWith('--from=')) o.from = a.slice(7);
    else if (a.startsWith('--read=')) o.from = a.slice(7);
    else if (a === '-t' || a === '-w' || a === '--to' || a === '--write') o.to = next();
    else if (a.startsWith('--to=')) o.to = a.slice(5);
    else if (a.startsWith('--write=')) o.to = a.slice(8);
    else if (a === '-o' || a === '--output') o.output = next();
    else if (a.startsWith('--output=')) o.output = a.slice(9);
    else if (a.startsWith('-o') && a.length > 2) o.output = a.slice(2);
    else if (a === '-s' || a === '--standalone') o.standalone = true;
    else if (a === '--list-output-formats') o.listFormats = 'output-formats';
    else if (a === '--list-input-formats') o.listFormats = 'input-formats';
    else if (a === '-') o.inputs.push('-'); // explicit stdin
    else if (a.startsWith('-')) { /* unsupported flag — ignore so we don't choke */ }
    else o.inputs.push(a);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { createPandocInstance } = await import(join(HERE, 'core.js'));
  const wasm = readFileSync(join(HERE, 'pandoc.wasm'));
  const pandoc = await createPandocInstance(wasm);

  if (opts.version) {
    const v = await pandoc.query({ query: 'version' });
    process.stdout.write(`pandoc ${v}\n(pandoc-wasm bundled with ClawDoc — client-side WebAssembly build)\n`);
    return 0;
  }
  if (opts.listFormats) {
    const list = await pandoc.query({ query: opts.listFormats });
    process.stdout.write((Array.isArray(list) ? list.join('\n') : String(list)) + '\n');
    return 0;
  }

  const realInputs = opts.inputs.filter(p => p && p !== '-');
  const from = opts.from || fmtFromPath(realInputs[0]) || 'markdown';
  const to = opts.to || fmtFromPath(opts.output) || 'html';

  const options = { from, to };
  if (opts.standalone || BINARY_FORMATS.has(to)) options.standalone = true;

  // Build the in-wasm file set. Inputs are passed by basename and referenced
  // via `input-files` (binary inputs MUST go this route — they can't ride
  // stdin). Text-only stdin pipelines pass `stdin` instead.
  const files = {};
  let stdin = null;
  if (realInputs.length) {
    const names = [];
    for (const p of realInputs) {
      const name = basename(p);
      const buf = readFileSync(p);
      files[name] = new Blob([buf]);
      names.push(name);
    }
    options['input-files'] = names;
  } else {
    stdin = readFileSync(0, 'utf8'); // stdin
  }

  let outName = null;
  if (opts.output) { outName = basename(opts.output); options['output-file'] = outName; }

  const result = await pandoc.convert(options, stdin, files);
  if (result.stderr && result.stderr.trim()) process.stderr.write(result.stderr.trimEnd() + '\n');

  if (outName) {
    const blob = result.files[outName];
    if (!blob) { process.stderr.write('pandoc: no output produced\n'); return 1; }
    const bytes = Buffer.from(await blob.arrayBuffer());
    writeFileSync(opts.output, bytes);
  } else {
    process.stdout.write(result.stdout || '');
  }
  // Treat a hard pandoc ERROR with no output as failure.
  if (result.stderr && /^\s*ERROR/m.test(result.stderr) && !result.stdout && !outName) return 1;
  return 0;
}

main().then(code => process.exit(code || 0)).catch(err => {
  process.stderr.write('pandoc (clawdoc): ' + (err && err.message || err) + '\n');
  process.exit(1);
});
