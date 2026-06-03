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

Apache-2.0 is one-way compatible into AGPL-3.0; MIT is permissive and likewise
compatible. The full Apache-2.0 and MIT license texts are available at the
sources above. React and RxJS are loaded as Univer's required peer
dependencies. SheetJS is used to parse `.csv`/`.xlsx` into rows on the client.
SuperDoc (vendored under `app/vendor/superdoc/`, AGPL-3.0 community edition —
same license as ClawDoc) renders and round-trips `.docx` entirely client-side.
