# Release log

The long-form record of each cut: what changed, why it was done that way, and what was
actually run to verify it. `CHANGELOG.md` is the short user-facing list; this is the
working log, including the parts that went wrong.

Verification numbers quoted below come from runs on the build machine
(Windows, Node 24, gateway on `127.0.0.1:20128`, PandaOrchestrator on `127.0.0.1:8765`).

---

## v0.5.116 — Docker boots, keys mint honestly

**Why this cut exists:** v0.5.115's Docker images built for both architectures and then
refused to boot — the health check never came up in CI, so the release shipped images it
had never run. The root cause sat right next to a second finding: API keys were minted
from 6 `Math.random()` characters under an HMAC secret hardcoded in the source.

### Fixed
- **Docker smoke tests pass again.** `next/dist/server` runtime code imports `@swc/helpers`
  subpaths (`_/_interop_require_default`) that standalone file-tracing omits, so both the
  amd64 and arm64 startup smoke tests died before the health endpoint answered, and the
  manifest-publish job skipped. The Dockerfile now copies `@swc/helpers` and `@next/env`
  from the builder into the runner — the same explicit-copy pattern the file already used
  for `next`, `sql.js` and `node-machine-id`.
- **API keys mint with real randomness and a per-install secret.** `generateKeyId()` now
  draws 16 lowercase-alnum chars from `crypto.randomInt` (~2^83, was 6 `Math.random()`
  chars ≈ 31 bits). The integrity digest uses `API_KEY_SECRET` when the env var is set,
  else a per-install secret auto-generated once and persisted at `DATA_DIR/api-key-secret`
  (0600; per-process random as last resort if the data dir is Windows-unwritable). No
  predictable default ships in the source tree anymore. Existing keys remain valid:
  request auth is an exact match against the `apiKeys` table and the digest is not checked
  on the request path — it is generation-time integrity only.
- **`docs/ARCHITECTURE.md` now describes the storage model the code actually has.** State
  and usage live in `${DATA_DIR}/db/data.sqlite` (default `DATA_DIR` is `~/.or`, legacy
  installs auto-migrate); the old `~/.originrouter` JSON paths, the diagrams, the
  persistence section and the security-boundary notes were all updated to match.

### Changed
- In-range dependency refresh (undici 7.30.2, in-range refresh for eslint-config-next
  16.4.5). Major bumps (chalk 6, ora 10, undici 8, eslint 10, better-sqlite3 13) were
  evaluated and deferred — a release cut is the wrong moment to take majors.

### Verified
- `npm run build` clean (exit 0, 154/154 static pages) on Windows/Node 24 after the
  dependency refresh.
- `apiKey.js` syntax verified with `node --check` (via a temp `.mjs` copy) and an ESM
  import probe (`SYNTAX_OK_ALIAS_FAIL` — parses clean; the `@/` alias is bundler-side).
- Docker boot could not be reproduced locally (no Docker daemon on this machine); the
  per-architecture smoke tests in `docker-publish.yml` are the gate, and this cut exists
  precisely because that gate works — a red smoke test blocks the manifest, which is
  exactly what caught v0.5.115.
- Test suite: 4,191 passing / 83 known Windows-environment reds against the pre-merge
  baseline, zero regressions (baseline carried from v0.5.113–v0.5.115).

---

## v0.5.115 — naming, docs and release plumbing

**Why this cut exists:** the previous release exposed that the repository identity, the
package identity and the docs had drifted apart, and that several documented paths only
worked on one machine.

### Changed
- **Package names**: `originrouter-app` → `origin-router-app`, CLI `originrouter` →
  `origin-router`, desktop `originrouter-desktop` → `origin-router-desktop`. Installer
  scripts are now `installer/origin-router.iss` and `installer/origin-router-desktop.iss`.
  The `or` / `originrouter` **commands**, the `Programs\OriginRouter` install folders and
  the `AppId` GUIDs are unchanged on purpose: renaming those would orphan an existing
  install's `PATH` shims, autostart entry and upgrade path.
- **Repository slug**: stays `origin-router`. `origin-labs-ai/origin-router` was
  requested and GitHub refused it — `name has been retired and cannot be reused` — because
  the shorter name had been used before. Everything user-facing says OriginRouter; only the
  git URL carries the suffix.
- **`GET /api/version` reads the release feed, not npm.** It queried
  `registry.npmjs.org/originrouter/latest`, which is 404 — the package has never been
  published — so the sidebar's update banner could never light up, while still offering
  `npm i -g @origin-labs-ai/origin-router` as the fix. Both now point at the GitHub release.
- **`release.yml` rewritten.** It used `setup-node`'s `cache: npm` plus `npm ci`, and
  lockfiles are ignored, so every CI release died in 18s with
  `Dependencies lock file is not found`. It now installs with `npm install` and a single
  Windows job publishes what the release actually needs: gateway installer, desktop
  installer, CLI tarball, each with its `.sha256`, plus `checksums.sha256`. Mac/Linux keep
  producing portable zips.
- **Lockfiles stay ignored, deliberately.** The only ones in the tree came from upstream —
  the root `package-lock.json` is still named `originrouter-app` at `0.5.111` — and this
  machine cannot regenerate them (npm refuses the `@tailwindcss/oxide-wasm32-wasi` remote
  tarball with `EALLOWREMOTE`). Committing them would pin a graph that is not ours.
- **Docker**: `docker-compose.yml` still started a service called `originrouter` pulling
  `origin-router:latest`; it now builds `origin-router:local` from this repo with an
  `origin-router-data` volume. `docker-publish.yml` decided Docker Hub publishing by
  comparing the repository against upstream's name, so a fork could never publish yet still
  attempted it — the decision is now credential-based (`DOCKERHUB_USERNAME` +
  `DOCKERHUB_TOKEN` present ⇒ publish), and GHCR publishing is unaffected.
- **Docs**: `README.md`, `docs/INSTALL.md`, `docs/UPDATES.md`, `DOCKER.md` rewritten — no
  absolute machine paths (they pointed at a folder this repo has not lived in for two
  moves), no hard-coded versions, and the npm-install instructions replaced by the release
  tarball. `CLAUDE.md` corrected: data lives in `~/.or` (not `~/.originrouter`), usage and
  request details are SQLite tables that follow `DATA_DIR`, and the CLI is not published to
  npm. Gitbook branding (`OriginRouter Documentation`, `originrouter.com`, upstream GitHub URL,
  `originrouter-docs` project) is now OriginRouter, and `gitbook-pages.yml` — which deployed to
  someone else's Pages site with a key this repo does not have — is deleted.
- **Attribution kept**: `LICENSE` still carries the upstream MIT copyright notice. That is
  a legal condition of using the code, not branding, so it stays.

### npm packaging, decided after the cut

The npm identity of the launcher is **`originrouter`** - the name its `bin` entries, the
autostart value and `UPDATER_CONFIG.npmPackageName` already used, and the name that is free
on the registry (`origin-router` is somebody else's package, v1.6.4). Two bugs surfaced while
getting it publishable:

- `bin: { originrouter: "./cli.js" }` - npm 10 rejects a `bin` path with the `./` prefix and
  **silently drops the entry**: `npm publish --dry-run` reported `"bin[originrouter]" script
  name cli.js was invalid and removed`, which would have installed the package with no
  `originrouter` and no `or` command at all. Fixed to `cli.js`; the dry-run is clean now
  (`originrouter@0.5.115`, 70.1 MB packed, 11762 files).
- `npm publish` itself stops at `ENEEDAUTH`: this machine has no registry credentials, so
  publishing waits for one `npm login` from the owner. Everything up to it is verified.

### Verified
- `git grep -i "originrouter"` over docs, README, gitbook, CLAUDE.md and package
  metadata: no product-level hits left. Remaining `originrouter` strings are wire-protocol
  constants (`X-Msh-Platform`, the `x-9*` response headers, the legacy
  data-migration path) — renaming those breaks the providers that check them,
  which is a functional regression dressed up as a cosmetic one.
- i18n README sweep: 10 files, one token each; the first attempt was a scripting bug
  (a collapsed PowerShell array turned a string pair into `Replace('o','r')` and mangled
  the non-ASCII files). Caught on inspection, restored with `git checkout -- i18n`, redone
  with a literal per-file replace. Verified afterwards: `git diff --numstat` over the shipped
  range reports **1 insertion / 1 deletion for each of the ten files** - only the package-name
  token moved, every other byte (including the Persian, Thai, Japanese and Russian text) is
  unchanged from what it replaced.

---

## v0.5.114 — release home moved to this repository

**Why:** `origin-labs-ai/originrouter` no longer resolves (`git ls-remote` → repository not
found), and seven places in the app still pointed at it: the dashboard GitHub/changelog
URLs, the CLI updater's default repo, the `install.json` marker written by
`scripts/package-cli.mjs`, the desktop app's Issues/Releases links, both Inno `AppURL`
fields, and the pinned darwin-arm64 tray release. So auto-update, the changelog modal and
the tray download were all silently dead.

Also in this cut: `build-installer.ps1` takes its default version from `package.json`
(a literal default silently ages, and a mislabelled build is an update nobody gets); the
gateway installer's publisher string matches the desktop one (`Origin Labs AI`).

### The credential incident
Refreshing `tests/__baseline__/providers-baseline.json` with
`tests/__baseline__/snapshot-providers.mjs` dumped live config verbatim and wrote three
real Google OAuth client secrets (`GOCSPX-*`) into a file where this fork had deliberately
put `REDACTED`. GitHub push protection refused the first push:

```text
remote: error: GH013: Repository rule violations found for refs/heads/main
remote: - Push cannot contain secrets
        tests/__baseline__/providers-baseline.json:51,52,316,317,323,324
```

Two fixes, not one: the snapshot generator now strips every `*secret*` field on the way out
(harmless to the gate — `verify-providers.mjs` already excludes `clientSecret` from the
comparison), and because none of the six local commits had ever been pushed, the stack was
rebuilt commit-by-commit (cherry-pick, amend the offender, re-create the merge) so the
secret never exists in the pushed history at all. `git log -S"GOCSPX"` over the pushed range
returns nothing; `verify-providers.mjs`, `verify-alias.mjs` and `verify-oauth-urls.mjs` are
green.

**Lesson for the next person:** any script that regenerates a committed artifact from live
config is a credential leak waiting to happen. Strip at generation time, not in review.

---
