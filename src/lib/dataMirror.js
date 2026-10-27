import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, MIRROR_DATA_DIR } from "./dataDir.js";

// Keep a second live copy of the data directory at ~/.fusion/.or.
//
// This is a mirror, not a backup: identical tree, identical file names, no
// archive/zip wrapper, no "backup" suffix. It refreshes on an interval and
// immediately after boot, copying only entries whose mtime/size changed.
const MIRRORED_ENTRIES = [
  "db",
  "auth",
  "bin",
  "model-catalog.json",
  "model-catalog-raw.json",
  "jwt-secret",
  "machine-id",
  "connect.env",
];

let timer = null;
let running = false;

function statFingerprint(target) {
  try {
    const stat = fs.statSync(target);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "";
  }
}

function copyEntry(name) {
  const source = path.join(DATA_DIR, name);
  const destination = path.join(MIRROR_DATA_DIR, name);
  if (!fs.existsSync(source)) return;

  const sourceStat = fs.statSync(source);
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const child = path.join(source, entry.name);
      const childDestination = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(child, childDestination, { recursive: true, force: true });
        continue;
      }
      // Skip unchanged files: the DB file is large and rewritten often.
      if (statFingerprint(child) === statFingerprint(childDestination)) continue;
      fs.copyFileSync(child, childDestination);
    }
    return;
  }

  if (statFingerprint(source) === statFingerprint(destination)) return;
  fs.copyFileSync(source, destination);
}

export function syncDataMirror() {
  if (running) return;
  if (path.resolve(DATA_DIR) === path.resolve(MIRROR_DATA_DIR)) return;
  running = true;
  try {
    fs.mkdirSync(MIRROR_DATA_DIR, { recursive: true });
    for (const entry of MIRRORED_ENTRIES) {
      try {
        copyEntry(entry);
      } catch (error) {
        // A locked sqlite file must not break the app; retry next tick.
        console.warn(`[DATA_MIRROR] ${entry}: ${error?.message || error}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startDataMirror(intervalMs = 5000) {
  if (timer) return;
  syncDataMirror();
  timer = setInterval(syncDataMirror, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
