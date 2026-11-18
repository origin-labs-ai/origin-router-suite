/**
 * Local patch — target detection and planning.
 *
 * The same probe runs in three places (repo script, CLI, dashboard API), so it
 * never hardcodes an install path. A target is any folder that ends in `app`
 * and looks like a standalone bundle; the standard per-user installs are just
 * the two layouts we know about.
 */
import fs from "node:fs";
import path from "node:path";
import { fingerprintBundle, isManifestCurrent, readManifest, readJsonFile } from "./state.mjs";

function existsDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeBundle(dir) {
  if (!existsDir(dir)) return false;
  for (const file of ["server.js", "custom-server.js", "package.json"]) {
    try {
      fs.accessSync(path.join(dir, file));
      return true;
    } catch {
      /* keep checking */
    }
  }
  return false;
}

function readInstallMode(root) {
  const info = readJsonFile(path.join(root, "install.json"), null);
  return info?.mode || "";
}

function makeTarget(id, label, appDir) {
  if (!looksLikeBundle(appDir)) return null;
  const root = path.dirname(appDir);
  return {
    id,
    label,
    appDir,
    root,
    installMode: readInstallMode(root) || "manual",
  };
}

/**
 * Standard layouts, in the order a user is most likely to mean:
 *   1. the per-user server install
 *   2. the desktop app's bundled server
 *   3. a portable folder (install.json next to app/)
 * An explicit path always wins and is returned alone.
 */
export function detectTargets({ explicitDir, env = process.env, cwd = process.cwd() } = {}) {
  if (explicitDir) {
    const resolved = path.resolve(explicitDir);
    const appDir = path.basename(resolved) === "app" ? resolved : path.join(resolved, "app");
    const target = makeTarget("custom", "Custom bundle", appDir);
    return target ? [target] : [];
  }

  const candidates = [];
  const localAppData = env.LOCALAPPDATA || "";
  if (localAppData) {
    candidates.push(["server", "Server install", path.join(localAppData, "Programs", "OriginRouter", "app")]);
    candidates.push([
      "desktop",
      "Desktop app",
      path.join(localAppData, "Programs", "OriginRouter Desktop", "resources", "server", "app"),
    ]);
  }

  // Portable: the launcher keeps install.json beside app/. Check the documented
  // override, the current working directory, then the launcher's own folder.
  const portableRoots = [env.ORIGINROUTER_HOME, cwd, path.dirname(process.execPath)].filter(Boolean);
  for (const root of portableRoots) {
    const info = readJsonFile(path.join(root, "install.json"), null);
    if (info?.mode === "portable") {
      candidates.push(["portable", "Portable build", path.join(root, "app")]);
      break;
    }
  }

  const seen = new Set();
  const targets = [];
  for (const [id, label, appDir] of candidates) {
    const resolved = path.resolve(appDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const target = makeTarget(id, label, resolved);
    if (target) targets.push(target);
  }
  return targets;
}

/** Bundle identity plus whether each target already runs that exact build. */
export function planPatch({ targets = [], bundleDir }) {
  const bundleFingerprint = fingerprintBundle(bundleDir);
  return {
    bundle: { dir: bundleDir, ...(bundleFingerprint || {}) },
    targets: targets.map((target) => {
      const installed = readManifest(target.appDir);
      return {
        ...target,
        installed,
        current: isManifestCurrent(installed, bundleFingerprint),
        runningBuild: fingerprintBundle(target.appDir)?.hash || "",
      };
    }),
  };
}

/**
 * A build is stale when the newest source file is newer than the bundle's
 * server.js. Cheap enough to run on every patch, and it means `npm run
 * patch:local` rebuilds only when something actually changed.
 */
export function buildNeedsRefresh({
  repoDir,
  bundleDir,
  watched = ["src", "open-sse", "public", "custom-server.js", "package.json", "next.config.mjs"],
}) {
  const bundleServer = path.join(bundleDir, "server.js");
  let bundleStat;
  try {
    bundleStat = fs.statSync(bundleServer);
  } catch {
    return { stale: true, reason: "bundle has no server.js" };
  }

  let newest = { file: "", mtimeMs: 0 };
  const walk = (entry) => {
    let stat;
    try {
      stat = fs.statSync(entry);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(entry);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === "node_modules" || name === ".next" || name === ".next-cli-build" || name === ".git") continue;
        walk(path.join(entry, name));
      }
      return;
    }
    // Source files only: a build artifact must not make the build look stale.
    if (!/\.(js|mjs|cjs|jsx|ts|tsx|css|json|svg|png|ico|woff2?)$/.test(entry)) return;
    if (stat.mtimeMs > newest.mtimeMs) newest = { file: entry, mtimeMs: stat.mtimeMs };
  };

  for (const name of watched) walk(path.join(repoDir, name));

  if (newest.mtimeMs > bundleStat.mtimeMs) {
    return {
      stale: true,
      reason: `${path.relative(repoDir, newest.file)} is newer than the bundle`,
      newestFile: newest.file,
    };
  }
  return { stale: false, reason: "bundle is newer than the sources" };
}
