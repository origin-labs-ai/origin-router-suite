# OriginRouter Tests

The OriginRouter test suite — unit, translator, auth and baseline-regression tests for the gateway engine (`open-sse/`) and dashboard (`src/`).

## Setup

Install test dependencies (the suite is an independent package so it can run
against the repo root without installing root devDependencies):

```bash
cd tests/ && npm install
```

## Running Tests

From the repo root:

```bash
npm test          # runs the full suite via vitest
```

From the `tests/` directory:

```bash
npm test                      # full suite
npm run test:verbose          # verbose reporter
npx vitest run unit           # a directory subset
npx vitest run unit/foo.test.js
```

## Layout

| Path | What it covers |
|------|----------------|
| `unit/` | Gateway engine + dashboard unit tests (providers, strategies, compression, oauth, handlers) |
| `translator/` | Wire-format translation tests with golden snapshots |
| `auth/` | Auth / API-key / token-refresh tests |
| `__baseline__/` | Regression gate: `verify-no-regression.mjs`, `verify-providers.mjs`, `verify-alias.mjs`, `verify-oauth-urls.mjs` + committed snapshots (`providers-baseline.json`, `alias-baseline.json`, `oauth-urls-baseline.json`) |
| `vitest.config.js` | Aliases `open-sse/` and `@/` to the repo root |

## Known-fails catalog

`__baseline__/known-fails.txt` catalogs tests that were allowed to fail at the
time it was written. As of v0.6.000 the suite target is **zero unexpected
failures**: every test either passes or is an explicitly-skipped live test
(`*.live.test.js` requiring real credentials). Fixes land as product code or
test updates — not by growing the known-fails list.
