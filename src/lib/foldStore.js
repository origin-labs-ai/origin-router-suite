// Fold session persistence — file-backed store wired into OriginFold at boot.
//
// Design: one JSON file per session under <DATA_DIR>/fold/, written on every
// fold (atomic-ish via temp+rename — small files, few writes, best-effort).
// Losing the store costs the fold, never a request: OriginFold fails open
// with or without this module.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const ROOT = join(DATA_DIR, "fold");

function safeKey(key) {
  // Session keys are numeric strings from the fold's hash; clamp anyway.
  return String(key).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anon";
}

export function loadFoldSession(key) {
  try {
    const p = join(ROOT, `${safeKey(key)}.json`);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function saveFoldSession(key, json) {
  try {
    mkdirSync(ROOT, { recursive: true });
    const p = join(ROOT, `${safeKey(key)}.json`);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, p);
  } catch { /* best-effort persistence */ }
}

// Wire into the fold module (open-sse/fold/index.js) at boot.
export async function installFoldStore() {
  const { setFoldStore } = await import("open-sse/fold/index.js");
  setFoldStore({ load: loadFoldSession, save: saveFoldSession });
}
