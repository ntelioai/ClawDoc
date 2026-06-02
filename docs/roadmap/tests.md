# Tests

No tests exist. A smoke test for [`index.js`](../../index.js) (the indexer) and [`git.js`](../../git.js) would catch a lot.

## Suggested stack

Vitest or plain `node --test`. `node --test` is zero-dep and fits the rest of the repo's minimal-tooling posture; Vitest is friendlier if/when a renderer-side test surface grows.

## First targets

- `index.js` — happy path: index a small fixture directory, assert the resulting index shape.
- `git.js` — read-only operations against a fixture repo (status, log). Avoid wiring up write paths in the first pass.
- Wire into [`.github/workflows/lint.yml`](../../.github/workflows/lint.yml) (or a new `test.yml`) once a baseline exists.
