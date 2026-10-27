import fs from "node:fs";
import path from "path";
import os from "os";

// All app state lives in `~/.or` (Users/<you>/.or). A second, identical copy is
// kept under `~/.fusion/.or` by dataMirror.js — same layout, same files, no
// "backup" naming anywhere.
const DATA_FOLDER = ".or";
const MIRROR_FOLDER = path.join(".fusion", ".or");

// legacy migration path — old installs stored data here
const LEGACY_CANDIDATES = [
  () => path.join(os.homedir(), ".originrouter"),
  () => path.join(os.homedir(), ".9router"), // legacy migration path
  () => path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "originrouter"),
  () => path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router") /* legacy migration path */,
];

function defaultDir() {
  return path.join(os.homedir(), DATA_FOLDER);
}

// One-time move from any previous location so existing installs keep their
// database, keys and logs instead of starting empty. When several old folders
// exist, the one with the newest database wins — older ones are usually stale
// CLI leftovers.
function newestDbMtime(dir) {
  for (const candidate of [path.join(dir, "db", "data.sqlite"), path.join(dir, "db.json")]) {
    try {
      return fs.statSync(candidate).mtimeMs;
    } catch {
      // try next
    }
  }
  return -1;
}

function migrateLegacyDir(targetDir) {
  try {
    const hasDb = (dir) => newestDbMtime(dir) >= 0;
    if (fs.existsSync(targetDir) && hasDb(targetDir)) return;

    const candidates = LEGACY_CANDIDATES
      .map((resolve) => resolve())
      .filter((dir) => fs.existsSync(dir) && hasDb(dir))
      .sort((a, b) => newestDbMtime(b) - newestDbMtime(a));

    if (candidates.length === 0) {
      if (!fs.existsSync(targetDir)) return;
      return;
    }

    const legacyDir = candidates[0];
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(legacyDir, targetDir, { recursive: true, force: true });
    console.log(`[DATA_DIR] migrated ${legacyDir} -> ${targetDir}`);
  } catch (e) {
    console.warn(`[DATA_DIR] legacy migration skipped: ${e?.message || e}`);
  }
}

export function getDataDir() {
  const configured = process.env.ORIGINROUTER_DATA_DIR || process.env.DATA_DIR;
  if (!configured) {
    const dir = defaultDir();
    migrateLegacyDir(dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback to ~/${DATA_FOLDER}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();

// Mirror target. Same content, written continuously (not a one-off snapshot).
export const MIRROR_DATA_DIR = process.env.ORIGINROUTER_MIRROR_DIR
  || path.join(os.homedir(), MIRROR_FOLDER);
