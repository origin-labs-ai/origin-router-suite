// GitHub-backed skill catalog source for the Skills page and the installer.
//
// The pipeline used to read the owner's catalog from a LOCAL payloads folder
// (C:\Users\thaku\…\code-fusion\payloads\skills). That path exists on exactly
// one machine, so every other install showed "not found" and an empty catalog.
// This module reads the SAME catalog shape from the GitHub repo instead
// (origin-labs-ai/code, payloads/skills): one directory per skill, each with a
// SKILL.md. The local source stays available as an explicit opt-in.
//
// HOUSE RULES (the repo's, and the reason behind each):
//   - Three hosts, and only three, are ever fetched: api.github.com (repo
//     tree), raw.githubusercontent.com (SKILL.md contents) and cdn.jsdelivr.net
//     (the same file through a CDN, only when raw is unreachable). The host is
//     part of the URL we build ourselves; settings only ever fill validated
//     path segments (owner/repo/branch/path charset-checked below), so a
//     tampered settings row cannot point the fetch at a private host, a
//     loopback address or an attacker server — the allow-list IS the SSRF
//     guard, not an afterthought.
//   - The CDN is not trusted on faith: every installed file is hashed as a Git
//     blob and compared with the sha in the api.github.com tree before a byte
//     lands on disk. A mirror that serves different content is rejected.
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
//     must never 500 the page. A 404 from a stale settings row gets one retry
//     against the built-in catalog before it is treated as a failure.

import { createHash } from "node:crypto";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_RAW_HOST = "raw.githubusercontent.com";
// jsDelivr mirrors GitHub over its own CDN. On networks where the
// raw.githubusercontent.com IP range is black-holed (Node reports
// UND_ERR_CONNECT_TIMEOUT while curl works), this is the difference between a
// working install and "fetch failed". Used ONLY as a fallback for SKILL.md
// bytes, and the content is verified against the GitHub tree sha.
const GITHUB_CDN_HOST = "cdn.jsdelivr.net";

// The complete set of hosts this module will ever open a socket to. Anything
// else — http, an IP literal, .internal, localhost — is refused before fetch.
const ALLOWED_HOSTS = new Set([GITHUB_API_HOST, GITHUB_RAW_HOST, GITHUB_CDN_HOST]);

// Hard network timeout per request. GitHub normally answers well inside 1s,
// but a COLD raw.githubusercontent.com DNS+TLS handshake on Windows measured
// 6.5s here and >10s on the first attempt from Node — the old 10s cap turned
// that into a "timed out" install failure. 20s covers the cold path; the
// catalog itself is cached, so this only ever bites a genuinely dead network.
const FETCH_TIMEOUT_MS = 20_000;

// In-memory cache TTL (ms). 10 minutes: fresh enough to pick up repo changes
// during a working session, long enough that scrolling the whole catalog
// costs one tree call + one fetch per actually-previewed skill.
export const CACHE_TTL_MS = 10 * 60 * 1000;

// The catalog this app ships against: the mono-repo that carries the full
// payloads catalog. Mirrored in DEFAULT_SETTINGS.skillsSource (settingsRepo.js)
// and restated here so the fetch layer stays import-light for pure tests.
export const DEFAULT_SKILLS_SOURCE = {
  owner: "origin-labs-ai",
  repo: "code",
  branch: "main",
  path: "payloads/skills",
};

// The 0.6 catalog pointed at origin-labs-ai/revolt-fusion/skills — a repo
// that does not exist (404). A configured source that 404s falls back to this
// known-good catalog once, with a note, so an old settings row self-heals
// instead of leaving the page empty.
export const FALLBACK_SKILLS_SOURCE = { ...DEFAULT_SKILLS_SOURCE };

// Optional token — never required, but an authenticated api.github.com call
// gets 5,000 req/h instead of 60. Sent to api.github.com ONLY: raw and the
// mirror are third-party hosts, and a PAT is not theirs to see.
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

// Human-readable source label for status lines and notes.
export function githubSourceLabel(cfg) {
  const c = normalizeSkillsSource(cfg);
  return `${c.owner}/${c.repo}@${c.branch} · ${c.path}/`;
}

function sameSource(a, b) {
  return a.owner === b.owner && a.repo === b.repo && a.branch === b.branch && a.path === b.path;
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

// Repo tree. A subtree request (`main:payloads/skills`) lists just that folder;
// that is the difference between a clean 952-skill catalog and the mono-repo's
// 50k-node tree, which GitHub truncates (and a truncated tree silently hides
// skills). The root form is kept for sources that point at the repo root.
function treeUrl(cfg) {
  const ref = cfg.path ? `${cfg.branch}:${cfg.path}` : cfg.branch;
  return assertGithubUrl(
    `https://${GITHUB_API_HOST}/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
}

// Raw content — the CDN host, no rate-limit budget to worry about.
function rawUrl(cfg, filePath) {
  // path segments are charset-validated; encodeURIComponent keeps any legal
  // space/oddity byte-exact without letting `?` or `#` into the URL.
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return assertGithubUrl(`https://${GITHUB_RAW_HOST}/${cfg.owner}/${cfg.repo}/${encodeURIComponent(cfg.branch)}/${encoded}`);
}

// The same blob through jsDelivr's GitHub mirror. Only reached when the raw
// host is unreachable; the caller verifies the bytes against the tree sha.
function cdnUrl(cfg, filePath) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return assertGithubUrl(
    `https://${GITHUB_CDN_HOST}/gh/${cfg.owner}/${cfg.repo}@${encodeURIComponent(cfg.branch)}/${encoded}`,
  );
}

// ─── The one fetch primitive ─────────────────────────────────────────────────

async function fetchText(url, { accept = "application/vnd.github+json" } = {}) {
  try {
    return await fetchTextOnce(url, accept);
  } catch (err) {
    // One retry for network-grade failures only. GitHub's own error statuses
    // (404, 403 rate limit, 5xx) are final and must not double the requests.
    if (!isTransientNetworkError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return fetchTextOnce(url, accept);
  }
}

// A failed first connection to the raw host shows up as a bare "fetch failed"
// (undici puts the real code on cause) or as our own timeout message.
function isTransientNetworkError(err) {
  const message = [err?.message, err?.cause?.message, err?.cause?.code].filter(Boolean).join(" ");
  return /timed out|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up/i.test(message);
}

async function fetchTextOnce(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = {
    Accept: accept,
    // GitHub API requires a UA; a stable, honest one helps debugging.
    "User-Agent": "origin-router-skills-catalog",
    // The token is for api.github.com ONLY. raw and jsDelivr are third-party
    // hosts as far as credentials are concerned — sending a PAT to a CDN
    // would be a credential leak, however trusted the CDN is.
    ...(new URL(url).hostname === GITHUB_API_HOST && githubToken()
      ? { Authorization: `Bearer ${githubToken()}` }
      : {}),
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
    // Keep the reason, not just "fetch failed": undici puts the useful code on
    // cause (UND_ERR_CONNECT_TIMEOUT, ECONNRESET, …) and the retry classifier
    // and the user both need it.
    if (err?.name === "TypeError" && err?.cause) {
      const cause = err.cause;
      throw new Error(`GitHub request failed (${cause.code || cause.message || "network error"})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isNotFound(err) {
  return /\b404\b/.test(String(err?.message || ""));
}

// ─── In-memory cache ─────────────────────────────────────────────────────────
// Module-level Map survives across requests in the Next.js server process
// (same trick driver.js uses with globalThis for the DB adapter, minus the
// hot-reload concern — route modules reload wholesale anyway).

const treeCache = new Map(); // cacheKey → { at, expiresAt, value }
const previewCache = new Map(); // cacheKey → { at, expiresAt, text }

// The source the last successful catalog call used. The preview endpoint only
// receives a repo path, so this is how it knows that a stale 404 source fell
// back to the built-in catalog (and therefore which repo to read from).
let lastUsedSource = null;

// raw.githubusercontent.com is black-holed on some networks (Node reports
// UND_ERR_CONNECT_TIMEOUT after 10s while curl on the same box succeeds). A
// single failed probe is enough to stop asking: for the next 10 minutes every
// SKILL.md goes straight to the mirror. Without this memo, a 975-skill install
// would spend 10s per file re-learning the same outage.
let rawHostUnreachableUntil = 0;
const RAW_HOST_COOLDOWN_MS = 10 * 60 * 1000;
// `${owner}/${repo}@${branch}:${path}` → Git blob sha from the tree. The
// installer verifies every downloaded SKILL.md against it, and previews use it
// when they can. Populated by listGithubSkills (the only caller with a tree).
const skillShaByPath = new Map();

function shaKey(cfg, file) {
  return `${cfg.owner}/${cfg.repo}@${cfg.branch}:${file}`;
}

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

async function readTree(cfg) {
  const cacheKey = `${cfg.owner}/${cfg.repo}@${cfg.branch}:${cfg.path}`;
  const hit = cacheGet(treeCache, cacheKey);
  if (hit) return hit.value;
  try {
    const parsed = JSON.parse(await fetchText(treeUrl(cfg)));
    cacheSet(treeCache, cacheKey, parsed);
    return parsed;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`GitHub catalog not found (404): ${githubSourceLabel(cfg)}`);
    }
    throw err;
  }
}

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
 * @returns {Promise<{skills:Array, truncated:boolean, notes:string[], sourceConfig:object}>}
 */
export async function listGithubSkills(opts = {}) {
  const requested = normalizeSkillsSource(opts.source || (await resolveSkillsSource()));
  const notes = [];
  let cfg = requested;
  let tree;
  try {
    tree = await readTree(cfg);
  } catch (err) {
    // A stale settings row (the 0.6 default pointed at a repo that never
    // existed) must not leave the page empty. Retry the known-good catalog
    // once and SAY that the configured one was not found.
    if (isNotFound(err) && !sameSource(cfg, FALLBACK_SKILLS_SOURCE)) {
      notes.push(
        `Configured GitHub catalog ${githubSourceLabel(requested)} was not found (404) — using ${githubSourceLabel(FALLBACK_SKILLS_SOURCE)} instead.`,
      );
      cfg = normalizeSkillsSource(FALLBACK_SKILLS_SOURCE);
      tree = await readTree(cfg);
    } else {
      throw err;
    }
  }
  lastUsedSource = cfg;

  if (tree?.truncated) {
    // GitHub cuts huge trees; say so rather than silently showing a subset.
    notes.push("GitHub returned a truncated tree — the catalog may be incomplete.");
  }

  const prefix = `${cfg.path}/`;
  const byDir = new Map(); // skill dir path → entry (first blob wins, dirs are unique anyway)
  for (const node of Array.isArray(tree?.tree) ? tree.tree : []) {
    if (node?.type !== "blob" || !node.path) continue;
    // A subtree tree returns paths relative to the requested folder; the
    // preview endpoint and the raw URL both expect repo-relative paths.
    const fullPath = `${cfg.path}/${node.path}`;
    if (!fullPath.startsWith(prefix)) continue;
    if (!fullPath.endsWith("/SKILL.md")) continue;
    const dir = fullPath.slice(0, -"/SKILL.md".length);
    if (!dir.startsWith(prefix) || dir === cfg.path) continue; // no dir → not a skill
    const dirName = dir.slice(dir.lastIndexOf("/") + 1);
    if (!dirName || byDir.has(dir)) continue;
    const sha = String(node.sha || "");
    if (sha) skillShaByPath.set(shaKey(cfg, fullPath), sha);
    byDir.set(dir, {
      dirName,
      name: dirName,
      description: "", // filled by previews, never authored here
      path: fullPath, // repo-relative SKILL.md blob path — the preview endpoint's key
      sha,
    });
  }

  const skills = [...byDir.values()].sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
  return { skills, truncated: !!tree?.truncated, notes, sourceConfig: cfg };
}

// ─── File access ─────────────────────────────────────────────────────────────

// Which repo a file path belongs to. The catalog normally ran first and set
// lastUsedSource; a bare preview request (server restarted mid-session) uses
// the configured source, then the built-in one if the path matches it.
async function effectiveSourceFor(opts, filePath) {
  if (opts?.source) return normalizeSkillsSource(opts.source);
  const file = String(filePath ?? "");
  const configured = await resolveSkillsSource();
  const candidates = [lastUsedSource, configured, normalizeSkillsSource(FALLBACK_SKILLS_SOURCE)];
  return candidates.find((cfg) => cfg && file.startsWith(`${cfg.path}/`)) || configured;
}

function assertSkillFile(cfg, file) {
  if (!file.startsWith(`${cfg.path}/`) || !file.endsWith("/SKILL.md")) {
    throw new Error(`preview path must be a SKILL.md under "${cfg.path}/": ${JSON.stringify(file)}`);
  }
}

// Git's blob hash: sha1("blob <byte length>\0" + bytes). Computed from the
// decoded string, so the length must be the UTF-8 byte count, not .length.
export function gitBlobSha(text) {
  const body = String(text ?? "");
  return createHash("sha1").update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest("hex");
}

// Raw first (GitHub's own host, no third party); jsDelivr only when raw is
// unreachable. A 404 is final — the file is missing, and no mirror will have
// it. No retry on the raw attempt: a connect timeout IS the answer, and paying
// it twice per file would make a large install crawl. The mirror is the retry.
async function fetchSkillFile(cfg, file, expectedSha) {
  let text;
  if (Date.now() < rawHostUnreachableUntil) {
    text = await fetchText(cdnUrl(cfg, file), { accept: "text/plain" });
  } else {
    try {
      text = await fetchTextOnce(rawUrl(cfg, file), "text/plain");
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      rawHostUnreachableUntil = Date.now() + RAW_HOST_COOLDOWN_MS;
      text = await fetchText(cdnUrl(cfg, file), { accept: "text/plain" });
    }
  }
  if (expectedSha) {
    const actual = gitBlobSha(text);
    if (actual !== expectedSha) {
      throw new Error(
        `content verification failed for ${file}: tree sha ${expectedSha.slice(0, 12)}…, received ${actual.slice(0, 12)}…`,
      );
    }
  }
  return text;
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
 * @returns {Promise<{preview:string, card:string, description:string, truncated:boolean}>}
 */
export async function fetchGithubPreview(opts, filePath, limit) {
  const file = assertSegment("path", String(filePath ?? ""), { allowSlash: true });
  const cfg = await effectiveSourceFor(opts, file);
  assertSkillFile(cfg, file);
  const cacheKey = `${cfg.owner}/${cfg.repo}@${cfg.branch}:${file}`;
  const hit = cacheGet(previewCache, cacheKey);
  const { text: raw, fileTruncated } = hit
    ? hit.value
    : await (async () => {
        // Cache a fixed slice, not the whole file: bounded memory per key, and
        // any legal request limit (≤ PREVIEW_MAX_CHARS) fits inside it. The
        // "file had more than the slice" fact is cached alongside so the
        // truncated flag stays honest even at the max limit.
        const full = await fetchSkillFile(cfg, file, skillShaByPath.get(shaKey(cfg, file)));
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
  const { previewWithEllipsis, skillCardText, skillDescription } = await import("./preview.js");
  const rendered = previewWithEllipsis(raw, limit);
  return {
    preview: rendered,
    card: skillCardText(raw, limit),
    description: skillDescription(raw),
    truncated: rendered.endsWith("…") || !!fileTruncated,
  };
}

/**
 * Fetch one whole SKILL.md for an install. No 4,000-char slice: the installer
 * writes the bytes it received, and a skill manifest is data, not a preview.
 * When `expectedSha` is given (the install path always has the tree sha) the
 * blob is verified before it is written, so a mirror or proxy that serves
 * different bytes is rejected.
 *
 * @param {{source?:object}} opts effective source (the catalog's sourceConfig)
 * @param {string} filePath repo-relative path to a SKILL.md
 * @param {string} [expectedSha] Git blob sha from the catalog tree
 * @returns {Promise<string>}
 */
export async function fetchGithubSkillText(opts, filePath, expectedSha) {
  const file = assertSegment("path", String(filePath ?? ""), { allowSlash: true });
  const cfg = await effectiveSourceFor(opts, file);
  assertSkillFile(cfg, file);
  return fetchSkillFile(cfg, file, expectedSha);
}
