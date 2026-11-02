import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { setContextCeilingOverrides } from "@/lib/comboContext";
import { setContextCeilingsSource } from "open-sse/providers/capabilities.js";

// Owner-declared context ceilings, e.g. { "or/tencent/hy4-preview-free": 1048576 }.
//
// The combo gate only blocks on numbers someone actually declared, so this file is
// the lever for "I know this seat does 1M even though no catalog says so". It is
// read server-side only (comboContext stays browser-safe) and re-read on mtime
// change, so editing it takes effect without a restart.
const CEILINGS_FILE = path.join(DATA_DIR, "context-ceilings.json");
let cache = { mtime: -1, map: {} };

export function readContextCeilings() {
  try {
    const mtime = fs.statSync(CEILINGS_FILE).mtimeMs;
    if (mtime !== cache.mtime) {
      cache = { mtime, map: JSON.parse(fs.readFileSync(CEILINGS_FILE, "utf8")) || {} };
    }
  } catch {
    cache = { mtime: -1, map: {} };
  }
  return cache.map;
}

// Makes the overrides visible to comboContext (client and server share that code).
export function applyContextCeilings() {
  setContextCeilingOverrides(readContextCeilings());
  return readContextCeilings();
}

// Registers the file as the capability table's ceiling source, so
// getCapabilitiesForModel() itself stops returning the 200K floor as if it were a
// model's limit — that reaches every consumer (provider pages, pickers, the
// playground filter and /v1/models) without each of them having to import this.
// The getter re-reads on mtime change, so editing the file needs no restart.
setContextCeilingsSource({
  get: (provider, model) => {
    const map = readContextCeilings();
    return map[`${provider}/${model}`] ?? map[model] ?? null;
  },
});
