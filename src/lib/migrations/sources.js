// First-run migration.
//
// A machine that already runs a router should not have to type every key again.
// Three kinds of source are recognised:
//
//   1. any other router install on this machine (found by what it contains,
//      not by what it is called)
//   2. an OmniRoute install
//   3. a Free Claude Code install
//
// Nothing here writes to the source. An import only reads, and it reports
// exactly what it took.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

function appDataRoot() {
  return process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
}

function normalize(dir) {
  return path.resolve(dir).toLowerCase();
}

// Our own folders are never a source.
function ownFolders() {
  return [
    path.join(HOME, ".or"),
    path.join(HOME, ".fusion", ".or"),
    path.join(HOME, ".originrouter"),
    path.join(appDataRoot(), "originrouter"),
  ].map(normalize);
}

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function listDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

// ── reading keys out of another install ────────────────────────────────────

// A router install keeps its keys in a SQLite table called apiKeys.
async function readKeysFromSqlite(file) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name);
      if (!tables.includes("apiKeys")) return [];
      return db
        .prepare("SELECT key, name, isActive FROM apiKeys")
        .all()
        .map((row) => ({
          key: row.key,
          name: row.name || "Imported key",
          isActive: row.isActive !== 0,
        }))
        .filter((entry) => typeof entry.key === "string" && entry.key.length > 0);
    } finally {
      db.close();
    }
  } catch {
    // No node:sqlite, or the file is not a database we can read.
    return [];
  }
}

// The older stores kept the same information in a JSON file.
function readKeysFromJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.apiKeys || parsed?.keys || [];
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => {
        if (typeof entry === "string") return { key: entry, name: "Imported key", isActive: true };
        if (!entry || typeof entry.key !== "string") return null;
        return { key: entry.key, name: entry.name || "Imported key", isActive: entry.isActive !== false };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Free Claude Code keeps one env file per provider.
function readKeysFromEnvFiles(dir) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".env")) continue;
    const file = path.join(entry.parentPath || entry.path || dir, entry.name);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|KEY))\s*=\s*["']?([^"'\s#]+)/);
      if (!match) continue;
      const [, name, value] = match;
      if (!value || value.length < 12) continue;
      if (/^(PATH|HOME|USER|SHELL|TERM|LANG|PWD|EDITOR)$/.test(name)) continue;
      found.push({ key: value, name: name.replace(/_(API_KEY|TOKEN)$/, "").replace(/_/g, " ").toLowerCase(), isActive: true });
    }
  }
  return found;
}

// ── detection ───────────────────────────────────────────────────────────────

async function detectRouterInstalls() {
  const own = ownFolders();
  const candidates = [...listDirs(HOME), ...listDirs(appDataRoot())];
  const found = [];
  for (const dir of candidates) {
    if (own.includes(normalize(dir))) continue;
    const sqlite = path.join(dir, "db", "data.sqlite");
    const json = path.join(dir, "db.json");
    if (!exists(sqlite) && !exists(json)) continue;
    const keys = exists(sqlite) ? await readKeysFromSqlite(sqlite) : readKeysFromJson(json);
    if (!keys.length) continue;
    found.push({
      id: `router:${path.basename(dir)}`,
      label: path.basename(dir),
      path: dir,
      keys,
    });
  }
  return found;
}

async function detectOmniRoute() {
  const candidates = [
    path.join(HOME, ".omniroute"),
    path.join(HOME, ".omni-route"),
    path.join(appDataRoot(), "omniroute"),
    path.join(appDataRoot(), "omni-route"),
  ];
  for (const dir of candidates) {
    if (!exists(dir)) continue;
    const sqlite = path.join(dir, "db", "data.sqlite");
    const json = path.join(dir, "db.json");
    const keys = exists(sqlite) ? await readKeysFromSqlite(sqlite) : exists(json) ? readKeysFromJson(json) : [];
    if (!keys.length) continue;
    return { id: "omniroute", label: "OmniRoute", path: dir, keys };
  }
  return null;
}

async function detectFreeClaudeCode() {
  const dir = path.join(HOME, ".fcc");
  if (!exists(dir)) return null;
  const keys = readKeysFromEnvFiles(dir);
  if (!keys.length) return null;
  return { id: "free-claude-code", label: "Free Claude Code", path: dir, keys };
}

// ── the list the wizard shows ───────────────────────────────────────────────

export async function listSources() {
  const [routerInstalls, omniRoute, freeClaudeCode] = await Promise.all([
    detectRouterInstalls(),
    detectOmniRoute(),
    detectFreeClaudeCode(),
  ]);

  const router = routerInstalls[0] || null;
  const sources = [];
  // The wizard shows all three, whether they are on this machine or not.
  // A missing one is greyed out, not hidden.
  sources.push(
    router
      ? {
          id: router.id,
          label: router.label,
          detail: `Found in ${router.path}`,
          keyCount: router.keys.length,
          available: true,
        }
      : {
          id: "router-install",
          label: "An existing router install",
          detail: "No other router was found on this machine.",
          keyCount: 0,
          available: false,
        }
  );
  sources.push(
    omniRoute
      ? {
          id: omniRoute.id,
          label: omniRoute.label,
          detail: `Found in ${omniRoute.path}`,
          keyCount: omniRoute.keys.length,
          available: true,
        }
      : {
          id: "omniroute",
          label: "OmniRoute",
          detail: "Not installed on this machine.",
          keyCount: 0,
          available: false,
        }
  );
  sources.push(
    freeClaudeCode
      ? {
          id: freeClaudeCode.id,
          label: freeClaudeCode.label,
          detail: `Found in ${freeClaudeCode.path}`,
          keyCount: freeClaudeCode.keys.length,
          available: true,
        }
      : {
          id: "free-claude-code",
          label: "Free Claude Code",
          detail: "Not installed on this machine.",
          keyCount: 0,
          available: false,
        }
  );
  return { sources, candidates: { routerInstalls, omniRoute, freeClaudeCode } };
}

// ── the import ──────────────────────────────────────────────────────────────

async function findSource(sourceId) {
  const { candidates } = await listSources();
  if (sourceId === "omniroute" && candidates.omniRoute) return candidates.omniRoute;
  if (sourceId === "free-claude-code" && candidates.freeClaudeCode) return candidates.freeClaudeCode;
  if (sourceId?.startsWith("router:")) {
    return candidates.routerInstalls.find((entry) => entry.id === sourceId) || null;
  }
  return null;
}

/**
 * Copy the keys of one source into this install. Keys that are already here
 * are left alone, so running the import twice changes nothing.
 */
export async function runMigration(sourceId) {
  const source = await findSource(sourceId);
  if (!source) {
    return { ok: false, error: "That source is not installed on this machine." };
  }

  const { getApiKeyByKey, createApiKey, updateApiKey } = await import("@/lib/db/repos/apiKeysRepo");
  const { getConsistentMachineId } = await import("@/shared/utils/machineId");

  const machineId = await getConsistentMachineId();
  const imported = [];
  const skipped = [];

  for (const entry of source.keys) {
    const existing = await getApiKeyByKey(entry.key);
    if (existing) {
      skipped.push({ name: entry.name, reason: "already imported" });
      continue;
    }
    try {
      const created = await createApiKey(entry.name, machineId);
      const updated = await updateApiKey(created.id, { key: entry.key, isActive: entry.isActive !== false });
      imported.push({ id: updated.id, name: updated.name });
    } catch (error) {
      skipped.push({ name: entry.name, reason: error.message });
    }
  }

  return {
    ok: true,
    source: { id: source.id, label: source.label, path: source.path },
    imported,
    skipped,
  };
}
