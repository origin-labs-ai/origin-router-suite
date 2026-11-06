import fs from "node:fs";
import path from "path";
import os from "os";

// All app state lives in `~/.or` (Users/<you>/.or). A second, identical copy is
// kept under `~/.fusion/.or` by dataMirror.js — same layout, same files, no
// "backup" naming anywhere.
const DATA_FOLDER = ".or";
const MIRROR_FOLDER = path.join(".fusion", ".or");

// The folder an older install stored its data in. It is not migrated from any
// more: the data directory is ours alone now.
const LEGACY_CANDIDATES = [
  () => path.join(os.homedir(), ".originrouter"),
  () => path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "originrouter"),
];

function defaultDir() {
  return path.join(os.homedir(), DATA_FOLDER);
}

// The first-run wizard can move the data folder. The choice is kept in the
// default folder, because that is the one place the app can always look -
// even after the data itself moved somewhere else.
export const DATA_LOCATION_FILE = path.join(defaultDir(), "data-location.json");

export function readDataLocationPreference() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_LOCATION_FILE, "utf-8"));
    const dir = typeof parsed?.dir === "string" ? parsed.dir.trim() : "";
    return dir;
  } catch {
    return "";
  }
}

export function writeDataLocationPreference(dir) {
  fs.mkdirSync(defaultDir(), { recursive: true });
  fs.writeFileSync(DATA_LOCATION_FILE, `${JSON.stringify({ dir }, null, 2)}\n`);
  return DATA_LOCATION_FILE;
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
  const configured = process.env.ORIGINROUTER_DATA_DIR || process.env.DATA_DIR || readDataLocationPreference();
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
