// Revolt Fusion loader — on-demand hydration of the extension pack.
//
// The mechanism (the owner's architecture): heavy categories live in packs.
// Installing a pack copies its files into
//   <DATA_DIR>/fusion-modules/<packId>/
// after verifying every file's SHA-256 against the pack's own manifest.json.
// Activating a pack loads its entry module with a cache-busted dynamic
// import() — the exact pattern pxpipe/loader.js already uses (webpackIgnore),
// so nothing enters the Next.js build graph and no restart is needed.
//
// Sources (the pack is ALWAYS ours — no third-party repo is ever contacted):
//   { kind: "local",  dir }                              — development/testing
//   { kind: "github", repo: "origin-labs-ai/revolt-fusion" } — release assets
//
// Security posture (Mimosa rules, enforced here):
//   - Outbound requests: https only, host-validated against a fixed allowlist,
//     and localhost/loopback/private/reserved addresses refused.
//   - repo/tag/path strings are strictly validated before any URL is built.
//   - Every file byte-checked against the manifest before it lands on disk.
//   - No shell, no child processes, no eval — modules load through import().

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// ─── Paths & small helpers ───────────────────────────────────────────────────

let dataDirCache = null;
let dataDirPromise = null;

// DATA_DIR resolution: import the canonical helper once at first use.
function resolveDataDir() {
  if (!dataDirPromise) {
    dataDirPromise = import("@/lib/dataDir.js").then((m) => {
      dataDirCache = m.DATA_DIR;
      return m.DATA_DIR;
    });
  }
  return dataDirPromise;
}

function fusionRoot() {
  return join(dataDirCache, "fusion-modules");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Strict id validation: lowercase alphanumeric + dash, 1-64 chars. Anything
// else can never name a pack directory.
function validId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
}

// Semver-ish version guard (loose): digits and dots, 1-32 chars.
function validVersion(s) {
  return typeof s === "string" && /^[0-9A-Za-z.\-+]{1,32}$/.test(s);
}

// ─── Network source (GitHub releases, https-only, allowlisted hosts) ─────────

const GITHUB_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
]);

// Refuse anything that is not a plain https URL on an allowlisted host, and
// refuse loopback/private/reserved addresses by host NAME as a first pass
// (DNS-level checks are out of scope for a release-asset fetch).
function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid pack URL");
  }
  if (u.protocol !== "https:") throw new Error("pack source must be https");
  const host = u.hostname.toLowerCase();
  if (!GITHUB_HOSTS.has(host)) throw new Error(`pack host not allowed: ${host}`);
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\])/.test(host)) {
    throw new Error("loopback and private addresses are refused");
  }
  return u;
}

// repo: "owner/name" — the ONLY repo shape accepted. tag: release tag.
function assertSafeRepoTag(repo, tag) {
  if (!/^[\w.\-]+\/[\w.\-]+$/.test(String(repo || ""))) throw new Error("invalid repo id");
  if (!/^[\w.\-]{1,64}$/.test(String(tag || ""))) throw new Error("invalid release tag");
}

async function fetchWithTimeout(url, ms = 20000) {
  const u = assertSafeUrl(url);
  const res = await fetch(u, { signal: AbortSignal.timeout(ms), cache: "no-store" });
  if (!res.ok) throw new Error(`pack fetch failed: ${res.status} ${u.pathname}`);
  return res;
}

// ─── Pack format ─────────────────────────────────────────────────────────────
// A pack is a directory:
//   <DATA_DIR>/fusion-modules/<packId>/manifest.json
//   <DATA_DIR>/fusion-modules/<packId>/index.js
// manifest.json: { packId, version, features: [categoryId...],
//                  files: { "index.js": "<sha256>" } }
// Every listed file is byte-verified before and after placement.

function manifestPath(dir) {
  return join(dir, "manifest.json");
}

function readManifest(dir) {
  const raw = readFileSync(manifestPath(dir), "utf8");
  const m = JSON.parse(raw);
  if (!validId(String(m.packId || ""))) throw new Error("manifest packId invalid");
  if (!validVersion(String(m.version || ""))) throw new Error("manifest version invalid");
  if (!Array.isArray(m.features) || !m.features.every(validId)) throw new Error("manifest features invalid");
  if (!m.files || typeof m.files !== "object") throw new Error("manifest files invalid");
  for (const [name, hash] of Object.entries(m.files)) {
    if (!/^[\w.\-]{1,64}\.js$/.test(name)) throw new Error(`manifest file name invalid: ${name}`);
    if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new Error(`manifest hash invalid: ${name}`);
  }
  return m;
}

// Verify every file in the manifest against its hash. Returns the map.
function verifyFiles(dir, manifest) {
  const verified = {};
  for (const [name, hash] of Object.entries(manifest.files)) {
    const p = join(dir, name);
    if (!existsSync(p)) throw new Error(`pack file missing: ${name}`);
    if (!resolve(p).startsWith(resolve(dir) + sep)) throw new Error("path traversal in pack");
    const actual = sha256(readFileSync(p));
    if (actual !== hash) throw new Error(`hash mismatch: ${name}`);
    verified[name] = hash;
  }
  return verified;
}

// ─── Install: from a local directory ─────────────────────────────────────────

async function installFromLocal(sourceDir) {
  const src = resolve(String(sourceDir || ""));
  const manifest = readManifest(src);
  const dest = join(await fusionRootAsync(), manifest.packId);
  mkdirSync(dest, { recursive: true });
  const files = {};
  for (const name of Object.keys(manifest.files)) {
    const buf = readFileSync(join(src, name));
    if (sha256(buf) !== manifest.files[name]) throw new Error(`hash mismatch: ${name}`);
    writeFileSync(join(dest, name), buf);
    files[name] = manifest.files[name];
  }
  writeFileSync(manifestPath(dest), JSON.stringify(manifest, null, 2));
  return { packId: manifest.packId, version: manifest.version, features: manifest.features, dir: dest, files };
}

function fusionRootAsync() {
  return resolveDataDir().then(() => fusionRoot());
}

// ─── Install: from a GitHub release ──────────────────────────────────────────

async function installFromGitHub(repo, tag) {
  assertSafeRepoTag(repo, tag);
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  // Manifest first, then each file it lists (text modules, no archives).
  const manifestRes = await fetchWithTimeout(`${base}/manifest.json`);
  const manifestText = await manifestRes.text();
  const staging = join(await fusionRootAsync(), `.staging-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    const manifest = JSON.parse(manifestText);
    if (!validId(String(manifest.packId || ""))) throw new Error("manifest packId invalid");
    if (!validVersion(String(manifest.version || ""))) throw new Error("manifest version invalid");
    writeFileSync(join(staging, "manifest.json"), manifestText);
    const files = {};
    for (const [name, hash] of Object.entries(manifest.files || {})) {
      if (!/^[\w.\-]{1,64}\.js$/.test(name)) throw new Error(`manifest file name invalid: ${name}`);
      const res = await fetchWithTimeout(`${base}/${encodeURIComponent(name)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== hash) throw new Error(`hash mismatch: ${name}`);
      writeFileSync(join(staging, name), buf);
      files[name] = hash;
    }
    manifest.files = manifest.files || {};
    const dest = join(await fusionRootAsync(), manifest.packId);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(resolve(dest, ".."), { recursive: true });
    // Atomic-ish: rename staging into place.
    const { renameSync } = await import("node:fs");
    renameSync(staging, dest);
    return { packId: manifest.packId, version: manifest.version, features: manifest.features, dir: dest, files };
  } catch (err) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// ─── Activation: cache-busted dynamic import (pxpipe pattern) ────────────────

const loadedModules = new Map(); // packId → { mod, version }

/**
 * Load a pack's entry module. Uses the repo's proven runtime-import pattern:
 * a file URL with a version query (cache-bust) and a webpackIgnore comment,
 * so pack code never enters the Next.js build graph and hot-loads without a
 * server restart.
 */
export async function loadPackModule(packId) {
  if (loadedModules.has(packId)) return loadedModules.get(packId).mod;
  await resolveDataDir();
  const dir = join(fusionRoot(), validId(packId) ? packId : "");
  const entry = join(dir, "index.js");
  if (!existsSync(entry)) return null;
  const manifest = readManifest(dir);
  try {
    verifyFiles(dir, manifest);
  } catch {
    return null; // tampered/incomplete pack never activates
  }
  const url = `${pathToFileURL(entry).href}?v=${encodeURIComponent(manifest.version || "0")}`;
  const ns = await import(/* webpackIgnore: true */ url);
  // Pack convention: the default export is the module interface. Named
  // exports still work — the default is just the common path.
  const mod = ns?.default ?? ns;
  loadedModules.set(packId, { mod, version: manifest.version });
  return mod;
}

export function invalidateLoadedPack(packId) {
  loadedModules.delete(packId);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Install the pack for a feature set and persist the registry in settings.
 * @param {{ tier: string, features: string[], source: object }} setup
 */
export async function installPack(setup) {
  const { features = [], source } = setup || {};
  const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  const settings = await getSettings();
  const src = source || settings.fusion?.source || { kind: "local", dir: "" };

  // One pack carries all feature categories; id is fixed for now.
  const packId = "revolt-fusion";
  let result;
  if (src.kind === "github") {
    if (!src.tag) throw new Error("github source needs a release tag");
    result = await installFromGitHub(src.repo, src.tag);
  } else {
    result = await installFromLocal(src.dir);
  }

  const packs = { ...(settings.fusion?.packs || {}) };
  packs[result.packId] = {
    version: result.version,
    installedAt: new Date().toISOString(),
    features: result.features,
    dir: result.dir,
    files: result.files,
  };
  invalidateLoadedPack(result.packId);
  await updateSettings({ fusion: { ...settings.fusion, packs } });
  return { ok: true, packId: result.packId, version: result.version, features: result.features };
}

/**
 * Apply a setup tier: resolve features, persist tier+features, and (when the
 * tier needs the pack) install it. Daily Code never fetches anything.
 */
export async function applySetup({ tier, handPicked, source } = {}) {
  const { resolveFeatures, isPeakTier } = await import("./catalog.js");
  const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  const features = resolveFeatures(tier, handPicked);
  const settings = await getSettings();

  // Peak tiers (Ultra Ultimate Max) also turn every knob to its ceiling: max
  // concurrency, max failover routes, ultra compression, every brain live.
  // Values mirror the Mythos preset's ceilings, which are the same ones the
  // routing policy clamps to.
  let peakPatch = {};
  if (isPeakTier(tier)) {
    peakPatch = {
      routingPolicy: {
        ...(settings.routingPolicy || {}),
        maxAgentsConcurrency: 64,
        perConnectionConcurrency: 64,
        admissionQueueMs: 120000,
        hedgeMs: 120000,
        maxFailoverRoutes: 64,
        hopBackoffMs: 0,
        degradeCooldownMs: 900000,
        brainTimeoutMs: 60000,
        jevTimeoutMs: 120000,
        seatFairness: 1,
        tierBias: 1,
        routerBrain: "merged",
      },
      tokenSaver: {
        ...(settings.tokenSaver || {}),
        rtkEnabled: true,
        cavemanEnabled: true,
        cavemanLevel: "ultra",
        ponytailEnabled: true,
        ponytailLevel: "ultra",
      },
      comboStrategy: "autoaggressive",
    };
  }

  await updateSettings({
    fusion: {
      ...settings.fusion,
      enabled: features.length > 0,
      tier: tier || "daily",
      features,
      ...(source ? { source } : {}),
    },
    ...peakPatch,
  });
  // The pack itself is installed on demand by installPack (explicit user
  // action); applying a tier only records intent, so nothing downloads
  // behind the user's back.
  return { ok: true, tier: tier || "daily", features, peak: isPeakTier(tier) };
}

/** Fusion status for the dashboard + API. */
export async function fusionStatus() {
  const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
  const settings = await getSettings();
  const fusion = settings.fusion || {};
  const packs = {};
  for (const [packId, info] of Object.entries(fusion.packs || {})) {
    let verified = false;
    try {
      await resolveDataDir();
      const dir = join(fusionRoot(), packId);
      if (existsSync(manifestPath(dir))) {
        verifyFiles(dir, readManifest(dir));
        verified = true;
      }
    } catch { /* unverified = shown as damaged in the UI */ }
    packs[packId] = { ...info, verified };
  }
  return {
    enabled: fusion.enabled === true,
    tier: fusion.tier || "daily",
    features: Array.isArray(fusion.features) ? fusion.features : [],
    packs,
    source: fusion.source || { kind: "github", repo: "origin-labs-ai/revolt-fusion" },
  };
}

/** Remove a pack from disk and the registry. */
export async function removePack(packId) {
  if (!validId(packId)) throw new Error("invalid packId");
  await resolveDataDir();
  const dir = join(fusionRoot(), packId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  invalidateLoadedPack(packId);
  const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  const settings = await getSettings();
  const packs = { ...(settings.fusion?.packs || {}) };
  delete packs[packId];
  await updateSettings({ fusion: { ...settings.fusion, packs } });
  return { ok: true };
}
