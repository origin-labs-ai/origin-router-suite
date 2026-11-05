# Release log

The long-form record of each cut: what changed, why it was done that way, and what was
actually run to verify it. `CHANGELOG.md` is the short user-facing list; this is the
working log, including the parts that went wrong.

Verification numbers quoted below come from runs on the build machine
(Windows, Node 24, gateway on `127.0.0.1:20128`, PandaOrchestrator on `127.0.0.1:8765`).

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
- **Repository slug**: stays `origin-router-suite`. `origin-labs-ai/origin-router` was
  requested and GitHub refused it — `name has been retired and cannot be reused` — because
  the shorter name had been used before. Everything user-facing says OriginRouter; only the
  git URL carries the suffix.
- **`GET /api/version` reads the release feed, not npm.** It queried
  `registry.npmjs.org/originrouter/latest`, which is 404 — the package has never been
  published — so the sidebar's update banner could never light up, while still offering
  `npm i -g originrouter` as the fix. Both now point at the GitHub release.
- **`release.yml` rewritten.** It used `setup-node`'s `cache: npm` plus `npm ci`, and
  lockfiles are ignored, so every CI release died in 18s with
  `Dependencies lock file is not found`. It now installs with `npm install` and a single
  Windows job publishes what the release actually needs: gateway installer, desktop
  installer, CLI tarball, each with its `.sha256`, plus `checksums.sha256`. Mac/Linux keep
  producing portable zips.
- **Lockfiles stay ignored, deliberately.** The only ones in the tree came from upstream —
  the root `package-lock.json` is still named `9router-app` at `0.5.111` — and this
  machine cannot regenerate them (npm refuses the `@tailwindcss/oxide-wasm32-wasi` remote
  tarball with `EALLOWREMOTE`). Committing them would pin a graph that is not ours.
- **Docker**: `docker-compose.yml` still started a service called `9router` pulling
  `decolua/9router:latest`; it now builds `origin-router:local` from this repo with an
  `origin-router-data` volume. `docker-publish.yml` decided Docker Hub publishing by
  comparing the repository against upstream's name, so a fork could never publish yet still
  attempted it — the decision is now credential-based (`DOCKERHUB_USERNAME` +
  `DOCKERHUB_TOKEN` present ⇒ publish), and GHCR publishing is unaffected.
- **Docs**: `README.md`, `docs/INSTALL.md`, `docs/UPDATES.md`, `DOCKER.md` rewritten — no
  absolute machine paths (they pointed at a folder this repo has not lived in for two
  moves), no hard-coded versions, and the npm-install instructions replaced by the release
  tarball. `CLAUDE.md` corrected: data lives in `~/.or` (not `~/.originrouter`), usage and
  request details are SQLite tables that follow `DATA_DIR`, and the CLI is not published to
  npm. Gitbook branding (`9Router Documentation`, `9router.com`, upstream GitHub URL,
  `9router-docs` project) is now OriginRouter, and `gitbook-pages.yml` — which deployed to
  someone else's Pages site with a key this repo does not have — is deleted.
- **Attribution kept**: `LICENSE` still carries the upstream MIT copyright notice. That is
  a legal condition of using the code, not branding, so it stays.

### Verified
- `git grep -i "9router|decolua"` over docs, README, gitbook, CLAUDE.md and package
  metadata: no product-level hits left. Remaining `9router` strings are wire-protocol
  constants (`X-Msh-Platform: 9router`, `x-9router-*` response headers, the legacy
  `~/.9router` data-migration path) — renaming those breaks the providers that check them,
  which is a functional regression dressed up as a cosmetic one.
- i18n README sweep: 10 files, one token each; the first attempt was a scripting bug
  (a collapsed PowerShell array turned a string pair into `Replace('o','r')` and mangled
  the non-ASCII files). Caught on inspection, restored with `git checkout -- i18n`, redone
  with a literal per-file replace, and confirmed by diffing a Persian and a Japanese file.

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

## v0.5.113 — honest health, and Panda actually starting

Two features existed on paper and not in practice:

1. **A model test lied.** `ping.js` compared the echoed model id by substring, so
   `gpt-4o-mini` answering a `gpt-4o` test counted as the same model — the one mismatch an
   owner acts on was the one the rule hid. It now compares `modelGroupKey()`, the repo's
   canonical identity: release stamps, quant tags and vendor suffixes fold away
   (`gpt-4o-2024-11-20` **is** `gpt-4o`), a different model in the same family does not.
   Pinned from both directions, including a test that a dated build must stay silent.
2. **`merged` brain ran Jev-only.** The desktop app started PandaOrchestrator by handing a
   script to a detached PowerShell whose every failure path was swallowed, looking for one
   hardcoded absolute path. When the spawn did not take, nothing said so: port 8765 stayed
   dark and the setting still read `merged`. Panda is now started the way the gateway is —
   a direct hidden child, output to `~/.or/panda/panda.log`, errors to `panda.err.log` —
   and resolved from `OR_PANDA_SERVE`, the per-user Tools folder, `%LOCALAPPDATA%`, or a
   shipped copy.

   Evidence after install: kill Panda, start the app, `:8765/health` → `200` with
   `OnnxProfiler(panda-router-v4/model.int8.onnx)` and `cards: 170`, and
   `panda-router-serve.exe` has `OriginRouter Desktop` as its parent process.

Also in this cut: the combo stall rule (a member that has produced **no SSE frame** within
`seatSilenceMs` is replaced, max two cuts per turn; a member that produced any frame is
waited out for the full 7200s budget, so a live answer is never truncated and the prompt is
never paid twice — keepalive `:` comments are not counted as life, which is exactly what a
queued free lane emits); the golden header test made host-independent; upstream's
`v0.5.111..v0.5.112` change set (46 files) taken as a delta with `git apply -3`; and the
`skills/` docs that told agents to install from upstream's raw URLs removed.

**Measured:** 8-agent burst wall time 253s → 22.5s with 9 upstream attempts for 8 requests.
Suite went 90 → 83 failing tests against the pre-merge baseline with **zero** regressions —
the 83 are Windows-environment reds (Linux home paths, `NextResponse is not a constructor`
in a mock, LAN-disabled 403 vs 401) that were equally red before any of this work.

---

## How to verify a build like this was verified

```powershell
# honest model test: a bogus id must be refused, a real one must name who answered
Invoke-RestMethod -Method Post http://127.0.0.1:20128/api/models/test `
  -ContentType application/json -Body '{"model":"zznotaprovider/jhgsdca"}'

# brain health (needs dashboard auth; the settings panel shows the same thing)
Invoke-WebRequest http://127.0.0.1:8765/health          # panda offline -> merged reports partial

node tests\tmp-name-rules.mjs        # naming contract
node tests\tmp-stall-rule.mjs        # stall/replace contract
node tests\tmp-eight-agents.mjs      # 8 agents x 4 turns against the installed gateway
node tests\__baseline__\verify-providers.mjs
node tests\__baseline__\verify-alias.mjs
npm run brand:audit
```

Releasing: see [UPDATES.md](UPDATES.md). Installer behaviour: see [INSTALL.md](INSTALL.md).
