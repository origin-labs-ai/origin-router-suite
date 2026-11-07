// GitHub-backed skill catalog source for the Skills page.
//
// The pipeline (index.js) reads the owner's catalog from a LOCAL payloads
// folder; this module reads the SAME catalog shape from the cloud repo
// (origin-labs-ai/revolt-fusion, skills/), so the page can browse either.
//
// HOUSE RULES (the repo's, and the reason behind each):
//   - Two hosts, and only two, are ever fetched: api.github.com (repo tree)
//     and raw.githubusercontent.com (SKILL.md contents). The host is part of
//     the URL we build ourselves; settings only ever fill validated path
//     segments (owner/repo/branch/path charset-checked below), so a tampered
//     settings row cannot point the fetch at a private host, a loopback
//     address or an attacker server — the allow-list IS the SSRF guard, not
//     an afterthought.
//   - Plain fetch + AbortController with a hard timeout. No shell, no child
//     processes, no undici plumbing — skill content is DATA, we read bytes.
//   - redirect: "error" — a redirect could bounce an https URL somewhere the
//     allow-list never saw. GitHub answers 404 for missing things, it does
//     not need to redirect us.
//   - Everything is cached in memory for 10 minutes (CACHE_TTL_MS): one tree
//     call per source per 10 min, and each SKILL.md preview is fetched once
//     per 10 min no matter how many cards mount. This keeps us far inside the
//     unauthenticated GitHub rate limit (60 req/h on api.github.com; raw is a
//     CDN but we stay polite anyway).
//   - Fail-open: this module THROWS on failure and lets the catalog layer
//     (catalog.js) fall back to the local source with a note. One dead repo
//     must never 500 the page.

const GITHUB_API_HOST = "api.github.com";
const GITHUB_RAW_HOST = "raw.githubusercontent.com";

// The complete set of hosts this module will ever open a socket to. Anything
// else — http, an IP literal, .internal, localhost — is refused before fetch.
const ALLOWED_HOSTS = new Set([GITHUB_API_HOST, GITHUB_RAW_HOST]);

// Hard network timeout per request. GitHub answers well inside 1s normally;
// 10s covers a cold CDN edge without letting a hung request pin the route.
const FETCH_TIMEOUT_MS = 10_000;

// In-memory cache TTL (ms). 10 minutes: fresh enough to pick up repo changes
// during a working session, long enough that scrolling the whole catalog
// costs one tree call + one fetch per actually-previewed skill.
export const CACHE_TTL_MS = 10 * 60 * 1000;

// Settings-driven repo source, mirrored from DEFAULT_SETTINGS.skillsSource in
// settingsRepo.js (the same defaults, restated here so the fetch layer stays
// import-light and does not pull the DB driver into pure-logic tests).
export const DEFAULT_SKILLS_SOURCE = {
  owner: "origin-labs-ai",
  repo: "revolt-fusion",
  branch: "main",
  path: "skills",
};

// Optional token — never required, but an authenticated api.github.com call
// gets 5,000 req/h instead of 60. Only ever sent to the allow-listed hosts.
function githubToken() {
  return String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
}

// ─── Source config resolution & validation ───────────────────────────────────

// Segment charset for owner/repo/branch/path. Deliberately narrow: letters,
// digits, dot, dash, underscore (and slash for multi-segment values). No
// whitespace, no `?`, `#`, `@`, `\`, `%`… — none of the characters that could
// alter URL structure or smuggle a second host/credential into the path.
// `..` segments are refused separately (path traversal inside the repo tree).
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const PATH_RE = /^[A-Za-z0-9._\-/]+$/;

function assertSegment(kind, value, { allowSlash = false } = {}) {
  const v = String(value ?? "").trim();
  const re = allowSlash ? PATH_RE : SEGMENT_RE;
  if (!re.test(v)) throw new Error(`invalid skillsSource.${kind}: ${JSON.stringify(String(value))}`);
  if (v.includes("..")) throw new Error(`invalid skillsSource.${kind}: ".." segments are not allowed`);
  if (v.startsWith("/") || v.endsWith("/")) throw new Error(`invalid skillsSource.${kind}: no leading/trailing slash`);
  return v;
}

// Validate + normalize a repo source block. Throws on anything that could
// bend a URL — callers up the stack treat that as "github source unavailable"
// and fall back to local (fail-open).
export function normalizeSkillsSource(cfg) {
  const c = { ...DEFAULT_SKILLS_SOURCE, ...(cfg || {}) };
  return {
    owner: assertSegment("owner", c.owner),
    repo: assertSegment("repo", c.repo),
    branch: assertSegment("branch", c.branch),
    path: assertSegment("path", c.path, { allowSlash: true }),
  };
}

// Resolve the configured source: settings key skillsSource.github, else the
// defaults above. Fail-open — any settings problem (tests, first boot) falls
// back to the default repo rather than breaking the page.
export async function resolveSkillsSource() {
  try {
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    return normalizeSkillsSource(settings?.skillsSource?.github);
  } catch {
    return normalizeSkillsSource(DEFAULT_SKILLS_SOURCE);
  }
}

// ─── URL building (validate first, build second) ─────────────────────────────

// Final gate before any fetch: https + an exact allow-listed host + no
// explicit non-443 port + no embedded credentials. Every URL this module
// fetches passes through here, so a future call site cannot skip the guard.
export function assertGithubUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`refusing to fetch unparseable URL: ${JSON.stringify(String(rawUrl))}`);
  }
  if (url.protocol !== "https:") throw new Error(`refusing non-https URL: ${url.protocol}`);
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`refusing non-GitHub host: ${url.hostname}`);
  if (url.port && url.port !== "443") throw new Error(`refusing unexpected port: ${url.port}`);
  if (url.username || url.password) throw new Error("refusing URL with embedded credentials");
  return url.toString();
}

// Repo tree — one recursive call lists every file under the whole repo, which
// is how we learn which folders carry a SKILL.md without one request per dir.
function treeUrl(cfg) {
  return assertGithubUrl(
    `https://${GITHUB_API_HOST}/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`,
  );
}

// Raw content — the CDN host, no rate-limit budget to worry about.
function rawUrl(cfg, filePath) {
  // path segments are charset-validated; encodeURIComponent keeps any legal
  // space/oddity byte-exact without letting `?` or `#` into the URL.
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return assertGithubUrl(`https://${GITHUB_RAW_HOST}/${cfg.owner}/${cfg.repo}/${encodeURIComponent(cfg.branch)}/${encoded}`);
}

// ─── The one fetch primitive ─────────────────────────────────────────────────

async function fetchText(url, { accept = "application/vnd.github+json" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = {
    Accept: accept,
    // GitHub API requires a UA; a stable, honest one helps debugging.
    "User-Agent": "origin-router-skills-catalog",
    // Only sent to allow-listed hosts (assertGithubUrl ran before we got here).
    ...(githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {}),
  };
  try {
    const res = await fetch(url, { headers, redirect: "error", signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403 && String(res.headers?.get?.("x-ratelimit-remaining") ?? "") === "0") {
        throw new Error("GitHub API rate limit reached (set GITHUB_TOKEN to raise it)");
      }
      throw new Error(`GitHub request failed: ${res.status} ${res.statusText || ""}`.trim());
    }
    return text;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`GitHub request timed out after ${FETCH_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── In-memory cache ─────────────────────────────────────────────────────────
// Module-level Map survives across requests in the Next.js server process
// (same trick driver.js uses with globalThis for the DB adapter, minus the
// hot-reload concern — route modules reload wholesale anyway).

const treeCache = new Map(); // cacheKey → { at, expiresAt, value }
const previewCache = new Map(); // cacheKey → { at, expiresAt, text }

function cacheGet(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(cache, key, value, ttl = CACHE_TTL_MS) {
  // Bound the caches: previews are the unbounded one (one key per skill file).
  // 5,000 entries ≈ every skill of a very large catalog × a couple of
  // branches — past that, oldest entries expire first (Map keeps insert order).
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), expiresAt: Date.now() + ttl, value });
}

// ─── Tree → skill list ───────────────────────────────────────────────────────

// How much of a SKILL.md the preview cache keeps. The Read modal may ask for
// more than a card does; caching this slice serves both without refetching.
const PREVIEW_CACHE_CHARS = 4000;

/**
 * List the catalog's skills from the GitHub repo tree.
 *
 * A skill is a directory containing a SKILL.md — the same contract
 * index.js documents for the payloads folder, applied to the repo tree:
 * every blob `<path>/<dir>/SKILL.md` contributes one entry, keyed by its
 * parent dir. Deeper nesting works (the parent dir is still the skill);
 * a bare `<path>/SKILL.md` with no dir is NOT a skill dir and is skipped,
 * matching scanSourceDir's dirs-only rule.
 *
 * Identity note: the local scanner prefers frontmatter `name` and falls back
 * to dirName; here content is not fetched yet (one tree call must stay one
 * call), so dirName is the identity — which the payloads README explicitly
 * blesses as a legitimate spelling of the name.
 *
 * @param {{source?:object}} opts optional source override (tests)
 * @returns {Promise<{skills:Array, truncated:boolean, notes:string[]}>}
 */
export async function listGithubSkills(opts = {}) {
  const cfg = normalizeSkillsSource(opts.source || (await resolveSkillsSource()));
  const cacheKey = `${cfg.owner}/${cfg.repo}@${cfg.branch}:${cfg.path}`;
  const hit = cacheGet(treeCache, cacheKey);
  const tree = hit
    ? hit.value
    : await (async () => {
        const parsed = JSON.parse(await fetchText(treeUrl(cfg)));
        cacheSet(treeCache, cacheKey, parsed);
        return parsed;
      })();

  const notes = [];
  if (tree?.truncated) {
    // GitHub cuts huge trees; say so rather than silently showing a subset.
    notes.push("GitHub returned a truncated tree — the catalog may be incomplete.");
  }

  const prefix = `${cfg.path}/`;
  const byDir = new Map(); // skill dir path → entry (first blob wins, dirs are unique anyway)
  for (const node of Array.isArray(tree?.tree) ? tree.tree : []) {
    if (node?.type !== "blob" || !node.path) continue;
    if (!node.path.startsWith(prefix)) continue;
    if (!node.path.endsWith("/SKILL.md")) continue;
    const dir = node.path.slice(0, -"/SKILL.md".length);
    if (!dir.startsWith(prefix) || dir === cfg.path) continue; // no dir → not a skill
    const dirName = dir.slice(dir.lastIndexOf("/") + 1);
    if (!dirName || byDir.has(dir)) continue;
    byDir.set(dir, {
      dirName,
      name: dirName,
      description: "", // filled by previews, never authored here
      path: node.path, // repo-relative SKILL.md blob path — the preview endpoint's key
      sha: String(node.sha || ""),
    });
  }

  const skills = [...byDir.values()].sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
  return { skills, truncated: !!tree?.truncated, notes };
}

/**
 * Fetch the opening text of one SKILL.md from raw.githubusercontent.com.
 * Cached per file for CACHE_TTL_MS; truncated to `limit` chars by the shared
 * preview helpers so github and local previews behave identically.
 *
 * @param {{source?:object}} opts optional source override (tests)
 * @param {string} filePath repo-relative blob path, must be a SKILL.md under
 *        the configured path (least privilege: this endpoint previews the
 *        catalog, it is not a general repo file proxy)
 * @param {number} limit max preview chars
 * @returns {Promise<{preview:string, truncated:boolean}>}
 */
export async function fetchGithubPreview(opts, filePath, limit) {
  const cfg = normalizeSkillsSource(opts?.source || (await resolveSkillsSource()));
  const file = assertSegment("path", String(filePath ?? ""), { allowSlash: true });
  if (!file.startsWith(`${cfg.path}/`) || !file.endsWith("/SKILL.md")) {
    throw new Error(`preview path must be a SKILL.md under "${cfg.path}/": ${JSON.stringify(file)}`);
  }
  const cacheKey = `${cfg.owner}/${cfg.repo}@${cfg.branch}:${file}`;
  const hit = cacheGet(previewCache, cacheKey);
  const { text: raw, fileTruncated } = hit
    ? hit.value
    : await (async () => {
        // Cache a fixed slice, not the whole file: bounded memory per key, and
        // any legal request limit (≤ PREVIEW_MAX_CHARS) fits inside it. The
        // "file had more than the slice" fact is cached alongside so the
        // truncated flag stays honest even at the max limit.
        const full = await fetchText(rawUrl(cfg, file), { accept: "text/plain" });
        const entry = {
          text: full.slice(0, PREVIEW_CACHE_CHARS),
          fileTruncated: full.length > PREVIEW_CACHE_CHARS,
        };
        cacheSet(previewCache, cacheKey, entry);
        return entry;
      })();
  // Local import (not top-level) keeps this module import-light for pure tests.
  // previewWithEllipsis: display-ready, "…" baked in — identical behavior to
  // the local catalog's inline previews (see catalog.js), so both sources end
  // with "…" exactly when content was cut. fileTruncated covers the max-limit
  // case where the cut happened at the cache slice, below preview's radar.
  const { previewWithEllipsis } = await import("./preview.js");
  const rendered = previewWithEllipsis(raw, limit);
  return { preview: rendered, truncated: rendered.endsWith("…") || !!fileTruncated };
}
