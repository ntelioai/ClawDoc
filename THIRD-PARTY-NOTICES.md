# Third-Party Notices

ClawDoc (AGPL-3.0-only) bundles the following third-party components for the
in-app spreadsheet and document viewers. They are vendored under
`app/vendor/` and served locally. Each is distributed under a license
compatible with ClawDoc's AGPL-3.0 distribution.

| Component | Version | License | Source |
|-----------|---------|---------|--------|
| Univer (`@univerjs/presets`, `@univerjs/preset-sheets-core`) | 0.25.0 | Apache-2.0 | https://github.com/dream-num/univer |
| SheetJS Community Edition (`xlsx`) | 0.20.3 | Apache-2.0 | https://git.sheetjs.com/sheetjs/sheetjs |
| React (`react`, `react-dom`) | 18.3.1 | MIT | https://github.com/facebook/react |
| RxJS (`rxjs`) | 7.8.1 | Apache-2.0 | https://github.com/ReactiveX/rxjs |
| SuperDoc community edition (`@harbour-enterprises/superdoc`) | 1.38.0 | AGPL-3.0 | https://github.com/superdoc-dev/superdoc |
| pandoc (via `pandoc-wasm`) | pandoc 3.9 / wrapper 1.0.1 | GPL-2.0-or-later | https://github.com/pandoc/pandoc-wasm |
| browser_wasi_shim (`@bjorn3/browser_wasi_shim`) | 0.4.2 | MIT OR Apache-2.0 | https://github.com/bjorn3/browser_wasi_shim |
| MiniSearch (`minisearch`) | 7.1.2 | MIT | https://github.com/lucaong/minisearch |

Apache-2.0 is one-way compatible into AGPL-3.0; MIT is permissive and likewise
compatible. The full Apache-2.0 and MIT license texts are available at the
sources above. React and RxJS are loaded as Univer's required peer
dependencies. SheetJS is used to parse `.csv`/`.xlsx` into rows on the client.
SuperDoc (vendored under `app/vendor/superdoc/`, AGPL-3.0 community edition —
same license as ClawDoc) renders and round-trips `.docx` entirely client-side.

pandoc-wasm (vendored under `app/vendor/pandoc/`) is the official Pandoc
WebAssembly build wrapped by the `pandoc-wasm` package. It powers the in-app
"Export → Word" action and a bundled `pandoc` CLI shim placed on the embedded
terminal's PATH (so the in-app Claude Code can convert documents with no native
install). Pandoc is GPL-2.0-or-later; the "or later" lets it be used under
GPL-3.0, which is compatible with ClawDoc's AGPL-3.0 distribution. The unmodified
`pandoc.wasm` binary is bundled with attribution. `@bjorn3/browser_wasi_shim`
(MIT/Apache-2.0) is its required WASI runtime.

MiniSearch (vendored under `app/vendor/minisearch/`, MIT) is the in-browser
full-text search engine — stemming, fuzzy/prefix matching and BM25 ranking over
the locally-built index. PDF body text is extracted at index time with the
system `pdftotext` (poppler) when present; poppler is not bundled.
