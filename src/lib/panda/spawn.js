// PandaOrchestrator local detection — the discarded-feature revival.
//
// The router brain's Panda half is an external local service
// (https://github.com/aicodeking/PandaOrchestrator) that was documented but
// never started by the app: users had to launch it by hand and discover the
// wiring themselves. v0.6.000 revives the idea: at startup the router looks
// for a local PandaOrchestrator install and, if found, surfaces exactly how
// to start it (and reports when it is already healthy) via the panda status
// API and the startup log.
//
// Deliberately detection-only: the router never spawns third-party binaries
// on its own — no command surface, no attack surface. The one-line start
// command is returned so the user (or the desktop shell) can run it with full
// consent.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Candidate homes for a local PandaOrchestrator install.
function pandaHomeCandidates() {
  const out = [];
  const env = String(process.env.OR_PANDA_HOME || "").trim();
  if (env && !env.includes("..")) out.push(env);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  if (localAppData) out.push(join(localAppData, "Programs", "PandaOrchestrator"));
  out.push(join(home, "Tools", "PandaOrchestrator"));
  out.push(join(home, ".or", "panda"));
  return out.filter(Boolean);
}

// Identify a PandaOrchestrator install in a candidate dir. Returns the kind
// and the exact, user-consented start command — nothing is executed here.
function identifyPandaDir(dir) {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (/panda/i.test(String(pkg?.name || ""))) {
        const bin = pkg?.scripts?.start ? "npm start" : null;
        return { kind: "npm", dir, hint: bin || `cd "${dir}" && npm start` };
      }
    } catch { /* keep looking */ }
  }
  for (const exe of ["panda-orchestrator.exe", "panda-orchestrator", "panda.exe", "panda"]) {
    if (existsSync(join(dir, exe))) {
      return { kind: "exe", dir, hint: `"${join(dir, exe)}"` };
    }
  }
  return null;
}

/**
 * Detect a local PandaOrchestrator and report how to run it. Detection only —
 * nothing is spawned, nothing throws.
 * @returns {{ installed: boolean, dir: string|null, kind: string|null, hint: string|null }}
 */
export function pandaLocalStatus() {
  for (const dir of pandaHomeCandidates()) {
    if (!existsSync(dir)) continue;
    const found = identifyPandaDir(dir);
    if (found) return { installed: true, dir: found.dir, kind: found.kind, hint: found.hint };
  }
  return { installed: false, dir: null, kind: null, hint: null };
}

/**
 * Startup hook: one log line when a local Panda is found (or the hint that
 * installing one upgrades the brain). Never throws, never blocks boot.
 */
export async function reportPandaStatusAtBoot() {
  try {
    const status = pandaLocalStatus();
    if (status.installed) {
      console.log(`[PANDA] local PandaOrchestrator found at ${status.dir} — start it with: ${status.hint}`);
    }
  } catch { /* fail open */ }
}
