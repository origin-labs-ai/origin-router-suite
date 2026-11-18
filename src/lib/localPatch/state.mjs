/**
 * Local patch — shared state.
 *
 * One place for the paths and the small JSON files that let three surfaces
 * agree on what "the installed app" is: the repo script, the `or patch` CLI
 * command, and the dashboard API.
 *
 * Nothing here touches the user's data directory except its own `patch/`
 * folder. The running app, its `.env` and `~/.or` are never rewritten by
 * accident.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// Relative on purpose: scripts/local-patch.mjs imports this module with plain
// node (no bundler), so the `@/` alias must not appear here.
import { getDataDir } from "../dataDir.js";

export const PATCH_DIR = path.join(getDataDir(), "patch");
export const SOURCE_FILE = path.join(PATCH_DIR, "source.json");
export const STATUS_FILE = path.join(PATCH_DIR, "status.json");
export const RUNNER_FILE = path.join(PATCH_DIR, "runner.cjs");
export const LOG_FILE = path.join(PATCH_DIR, "patch.log");
export const MANIFEST_NAME = ".patch.json";

// The gateway exits with this code after handing the swap to the runner. The CLI
// supervisor treats a non-zero exit as "restart the server", so an installed
// build comes back on the new code without the user touching the tray.
export const PATCH_EXIT_CODE = 75;

export function ensurePatchDir() {
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  return PATCH_DIR;
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

export function readPatchStatus() {
  return readJsonFile(STATUS_FILE, null);
}

export function writePatchStatus(patch) {
  const previous = readPatchStatus() || {};
  return writeJsonFile(STATUS_FILE, {
    ...previous,
    ...patch,
    at: new Date().toISOString(),
  });
}

export function readPatchSource() {
  const source = readJsonFile(SOURCE_FILE, null);
  if (!source || typeof source.bundle !== "string") return null;
  return source;
}

export function writePatchSource(source) {
  return writeJsonFile(SOURCE_FILE, { ...source, registeredAt: new Date().toISOString() });
}

export function readManifest(appDir) {
  return readJsonFile(path.join(appDir || "", MANIFEST_NAME), null);
}

export function writeManifest(appDir, manifest) {
  return writeJsonFile(path.join(appDir, MANIFEST_NAME), manifest);
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Identity of a bundle. BUILD_ID changes whenever Next recompiles a route, the
 * server.js mtime catches a rebuild that kept the same id, and the version
 * catches a package bump. The hash is what the manifest stores.
 */
export function fingerprintBundle(bundleDir) {
  if (!bundleDir) return null;
  const buildId = (() => {
    for (const file of [
      path.join(bundleDir, ".next-cli-build", "BUILD_ID"),
      path.join(bundleDir, ".next", "BUILD_ID"),
    ]) {
      try {
        return fs.readFileSync(file, "utf8").trim();
      } catch {
        /* try the next layout */
      }
    }
    return "";
  })();
  const pkg = readJsonFile(path.join(bundleDir, "package.json"), {}) || {};
  const server = fileStamp(path.join(bundleDir, "server.js"));
  const customServer = fileStamp(path.join(bundleDir, "custom-server.js"));
  const hash = crypto
    .createHash("sha256")
    .update([buildId, pkg.version || "", server?.size || 0, server?.mtimeMs || 0, customServer?.mtimeMs || 0].join("|"))
    .digest("hex")
    .slice(0, 16);
  return {
    buildId,
    version: pkg.version || "",
    serverBytes: server?.size || 0,
    builtAt: server ? new Date(server.mtimeMs).toISOString() : null,
    hash,
  };
}

export function manifestFromBundle(bundleDir, extra = {}) {
  const fingerprint = fingerprintBundle(bundleDir);
  return {
    version: fingerprint?.version || "",
    buildId: fingerprint?.buildId || "",
    hash: fingerprint?.hash || "",
    builtAt: fingerprint?.builtAt || null,
    source: bundleDir,
    ...extra,
    patchedAt: new Date().toISOString(),
  };
}

export function isManifestCurrent(manifest, bundleFingerprint) {
  if (!manifest || !bundleFingerprint) return false;
  return Boolean(manifest.hash) && manifest.hash === bundleFingerprint.hash;
}
