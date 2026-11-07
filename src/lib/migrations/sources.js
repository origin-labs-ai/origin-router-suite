// First-run migration.
//
// A machine that already runs a router should not have to type every key again.
// Four kinds of source are recognised:
//
//   1. any other router install on this machine (found by what it contains,
//      not by what it is called)
//   2. an OmniRoute install
//   3. a Free Claude Code install
//   4. a 9Router install — the closest cousin: it persists through the same
//      SQLite driver chain this repo uses (see src/lib/db/driver.js), so its
//      data directory carries the same shaped database and a full import is
//      possible, not just keys
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

// ── 9Router: the same-shaped cousin ──────────────────────────────────────────
//
// 9Router persists through the same SQLite driver chain this repo uses
// (src/lib/db/driver.js: bun:sqlite → better-sqlite3 → node:sqlite → sql.js),
// so its database is a plain SQLite file with the same tables. A 9Router
// import can therefore move whole provider connections (registry id, base
// URL, api keys), combos and the per-combo strategies — not just loose keys.
// Reading it only needs a read-only SQLite handle, which node:sqlite gives on
// Node ≥22.5 and better-sqlite3 (an optional dep of this app) gives otherwise.

/**
 * Open a SQLite file read-only through the same driver chain the repo uses,
 * in its simplest form: node:sqlite first (built into Node ≥22.5), then the
 * optional better-sqlite3 dependency. Null when neither is available.
 */
async function openSqliteReadOnly(file) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    // No node:sqlite (older Node, or Bun).
  }
  try {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    return new BetterSqlite3(file, { readonly: true });
  } catch {
    return null;
  }
}

// One JSON-parse helper for the `data`/`models` columns — those columns hold
// JSON text, and a corrupt row must read as "column missing", not a crash.
function parseJsonColumn(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function tableExists(db, name) {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Read everything importable out of a 9Router database. Every table is read
 * defensively: an older 9Router may not have all of them yet.
 */
async function readNineRouterDatabase(file) {
  const db = await openSqliteReadOnly(file);
  if (!db) return null;
  try {
    // providerConnections: same shape as this repo's — identity columns plus
    // a `data` JSON column holding the credentials and provider specifics.
    const connections = tableExists(db, "providerConnections")
      ? db
          .prepare("SELECT * FROM providerConnections")
          .all()
          .map((row) => {
            const extra = parseJsonColumn(row.data, {});
            return {
              id: row.id,
              provider: row.provider,
              authType: row.authType || extra.authType || "apikey",
              name: row.name || extra.name || null,
              email: row.email || extra.email || null,
              priority: row.priority,
              isActive: row.isActive === undefined ? true : row.isActive !== 0 && row.isActive !== false,
              apiKey: extra.apiKey || null,
              providerSpecificData: extra.providerSpecificData || null,
            };
          })
          .filter((entry) => typeof entry.provider === "string" && entry.provider.length > 0)
      : [];

    // providerNodes: the custom ("openai-compatible" etc.) nodes a connection
    // may point at — carries the base URL an unknown registry id needs.
    const nodes = tableExists(db, "providerNodes")
      ? db
          .prepare("SELECT * FROM providerNodes")
          .all()
          .map((row) => {
            const extra = parseJsonColumn(row.data, {});
            return {
              id: row.id,
              type: row.type || extra.type || "openai-compatible",
              name: row.name || extra.name || null,
              prefix: extra.prefix || row.prefix || null,
              apiType: extra.apiType || row.apiType || "chat",
              baseUrl: extra.baseUrl || row.baseUrl || null,
            };
          })
      : [];

    const combos = tableExists(db, "combos")
      ? db
          .prepare("SELECT * FROM combos")
          .all()
          .map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind ?? null,
            models: parseJsonColumn(row.models, []),
            maxContextWindow: row.maxContextWindow ?? null,
            displayName: row.displayName ?? null,
          }))
          .filter((entry) => typeof entry.name === "string" && entry.name.length > 0)
      : [];

    // comboStrategies is one object in the settings row: { comboName: strategyId }.
    let comboStrategies = {};
    if (tableExists(db, "settings")) {
      try {
        const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
        const parsed = parseJsonColumn(row?.data, {});
        if (parsed?.comboStrategies && typeof parsed.comboStrategies === "object") {
          comboStrategies = parsed.comboStrategies;
        }
      } catch {
        // No settings row or unreadable — strategies import as nothing.
      }
    }

    return { connections, nodes, combos, comboStrategies };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only handle is best effort.
    }
  }
}

// The older 9Router builds kept everything in one JSON file. Same information,
// different wrapper — read the same four slices out of it, defensively.
function readNineRouterJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const data = parsed && typeof parsed === "object" ? parsed : {};
    return {
      connections: Array.isArray(data.providerConnections) ? data.providerConnections : [],
      nodes: Array.isArray(data.providerNodes) ? data.providerNodes : [],
      combos: Array.isArray(data.combos) ? data.combos : [],
      comboStrategies:
        data.settings?.comboStrategies && typeof data.settings.comboStrategies === "object"
          ? data.settings.comboStrategies
          : {},
    };
  } catch {
    return null;
  }
}

/**
 * Find the 9Router database inside one data-dir candidate. Order matters:
 * the current layout is a SQLite file (db.sqlite, or the db/ subfolder layout
 * this repo also uses); a bare db.json is the legacy store; and the last
 * resort is any *.sqlite / *.db file sitting directly in the folder.
 */
function findNineRouterDatabase(dir) {
  const sqliteCandidates = [
    path.join(dir, "db.sqlite"),
    path.join(dir, "db", "data.sqlite"),
    path.join(dir, "db", "db.sqlite"),
  ];
  for (const file of sqliteCandidates) {
    if (exists(file)) return file;
  }
  const json = path.join(dir, "db.json");
  if (exists(json)) return json;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/\.(sqlite|sqlite3|db)$/i.test(entry.name)) return path.join(dir, entry.name);
    }
  } catch {
    return null;
  }
  return null;
}

/** Detection: the first candidate folder that actually holds data wins. */
async function detectNineRouter() {
  const candidates = [
    path.join(HOME, ".9router"),
    path.join(appDataRoot(), "9router"),
    path.join(HOME, ".config", "9router"),
  ];
  for (const dir of candidates) {
    if (!exists(dir)) continue;
    const file = findNineRouterDatabase(dir);
    if (!file) continue;
    const data = file.endsWith(".json") ? readNineRouterJson(file) : await readNineRouterDatabase(file);
    if (!data) continue;
    const contentCount =
      data.connections.length + data.combos.length + Object.keys(data.comboStrategies).length;
    if (contentCount <= 0) continue;
    return { id: "9router", label: "9Router", path: dir, ...data };
  }
  return null;
}

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

// Free Claude Code (the Claude Code CLI) keeps its gateway endpoint in
// settings.json env — ANTHROPIC_BASE_URL plus a token. A remote base URL
// imports as an anthropic-compatible node with the token attached. An entry
// pointing at this gateway itself is reported as found-but-self, so the
// wizard card stays accurate instead of lying "not installed".
function readFreeClaudeCodeSettingsEnv() {
  for (const file of [
    path.join(HOME, ".claude", "settings.json"),
    path.join(HOME, ".claude.json"),
  ]) {
    if (!exists(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const env = parsed?.env;
      if (!env || typeof env !== "object") continue;
      const baseUrl = String(env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
      if (!baseUrl) continue;
      const token =
        String(env.ANTHROPIC_AUTH_TOKEN || "") || String(env.ANTHROPIC_API_KEY || "");
      return { baseUrl, token: token || null };
    } catch {
      continue;
    }
  }
  return null;
}

async function detectFreeClaudeCode() {
  const dir = path.join(HOME, ".fcc");
  if (exists(dir)) {
    const keys = readKeysFromEnvFiles(dir);
    if (keys.length) {
      return { id: "free-claude-code", label: "Free Claude Code", path: dir, keys };
    }
  }
  const settings = readFreeClaudeCodeSettingsEnv();
  if (settings) {
    if (isSelfReferentialBaseUrl(settings.baseUrl)) {
      return { id: "free-claude-code", label: "Free Claude Code", path: path.join(HOME, ".claude"), self: true, keys: [] };
    }
    if (settings.token) {
      return {
        id: "free-claude-code",
        label: "Free Claude Code",
        path: path.join(HOME, ".claude"),
        endpoint: settings,
        keys: [],
      };
    }
  }
  return null;
}

// ── the list the wizard shows ───────────────────────────────────────────────

export async function listSources() {
  const [routerInstalls, omniRoute, freeClaudeCode, nineRouter, openCode] = await Promise.all([
    detectRouterInstalls(),
    detectOmniRoute(),
    detectFreeClaudeCode(),
    detectNineRouter(),
    detectOpenCode(),
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
          detail: freeClaudeCode.self
            ? `Found in ${freeClaudeCode.path} - it points at this gateway itself, so there is nothing to import.`
            : `Found in ${freeClaudeCode.path}`,
          keyCount: freeClaudeCode.self
            ? 0
            : freeClaudeCode.keys.length + (freeClaudeCode.endpoint ? 1 : 0),
          available: !freeClaudeCode.self,
        }
      : {
          id: "free-claude-code",
          label: "Free Claude Code",
          detail: "Not installed on this machine.",
          keyCount: 0,
          available: false,
        }
  );
  // 9Router counts more than keys — the card shows how much would actually move
  // (connections, combos, strategies), so "0 keys" on an install that only has
  // settings would be misleading. keyCount carries the full item count.
  sources.push(
    nineRouter
      ? {
          id: nineRouter.id,
          label: nineRouter.label,
          detail: `Found in ${nineRouter.path}`,
          keyCount:
            nineRouter.connections.length +
            nineRouter.combos.length +
            Object.keys(nineRouter.comboStrategies).length,
          available: true,
        }
      : {
          id: "9router",
          label: "9Router",
          detail: "Not installed on this machine.",
          keyCount: 0,
          available: false,
        }
  );
  // OpenCode CLI: provider definitions with their api keys live in its JSON
  // config. The card counts importable api-key providers.
  sources.push(
    openCode
      ? {
          id: openCode.id,
          label: openCode.label,
          detail: `Found in ${openCode.path}`,
          keyCount: openCode.providers.length,
          available: true,
        }
      : {
          id: "opencode",
          label: "OpenCode CLI",
          detail: "No opencode.json config found on this machine.",
          keyCount: 0,
          available: false,
        }
  );
  return { sources, candidates: { routerInstalls, omniRoute, freeClaudeCode, nineRouter, openCode } };
}

// ── the import ──────────────────────────────────────────────────────────────

async function findSource(sourceId) {
  const { candidates } = await listSources();
  if (sourceId === "omniroute" && candidates.omniRoute) return candidates.omniRoute;
  if (sourceId === "free-claude-code" && candidates.freeClaudeCode) return candidates.freeClaudeCode;
  if (sourceId === "9router" && candidates.nineRouter) return candidates.nineRouter;
  if (sourceId === "opencode" && candidates.openCode) return candidates.openCode;
  if (sourceId?.startsWith("router:")) {
    return candidates.routerInstalls.find((entry) => entry.id === sourceId) || null;
  }
  return null;
}

// ── the 9Router import ───────────────────────────────────────────────────────
//
// 9Router speaks this repo's own dialect (same tables, same settings row), so
// a full migration is possible: provider connections with their api keys,
// combos, and the per-combo strategies. The mapping rule is deliberately
// simple: a 9router provider id that is also an OriginRouter registry id maps
// onto it one-to-one; anything else becomes an "openai-compatible" custom
// node (the same thing the Add Compatible modal creates), with the base URL
// taken from the 9router node row or the connection's own providerSpecificData.

// Prefixes are model-id namespaces here; they must survive being typed into a
// model string, so strip everything a model id could not carry.
function sanitizePrefix(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "9router";
}

/**
 * Decide where one 9router connection lands. Pure (and exported for the
 * migration tests): a known registry id maps to itself, an unknown one
 * becomes a compatible-node target with the best base URL we can find.
 */
export function mapNineRouterConnection(conn, nodesById, knownProviderIds) {
  const providerId = String(conn.provider || "");
  if (knownProviderIds.has(providerId)) {
    return { known: true, provider: providerId };
  }
  // Unknown id — gather everything the custom node needs from the 9router
  // node row first, then from the connection's own providerSpecificData.
  const node = nodesById.get(providerId) || null;
  const specifics = conn.providerSpecificData || {};
  const type =
    node?.type === "anthropic-compatible" || node?.type === "custom-embedding"
      ? node.type
      : "openai-compatible";
  const baseUrl =
    node?.baseUrl ||
    specifics.baseUrl ||
    (type === "anthropic-compatible" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
  return {
    known: false,
    type,
    baseUrl,
    prefix: sanitizePrefix(node?.prefix || specifics.prefix || providerId),
    apiType: node?.apiType || "chat",
    nodeName: node?.name || providerId,
    existingNodeId: node?.id || null,
  };
}

/**
 * Import a whole 9Router install: provider connections (mapped per the rule
 * above), combos, and the per-combo strategies. Same report shape as the
 * key-only imports, so the wizard treats every source identically.
 */
// ── smart key dedup (the "Key 2" rule) ──────────────────────────────────────
//
// The owner's rule for every migration source: when the SAME provider is
// connected in both places, a MATCHING key means "already imported" (skip),
// but a DIFFERENT key is still valuable — it imports as a second connection
// named "<label> Key 2", then "Key 3", and so on. A provider with two real
// keys gets both; nothing is silently lost and nothing is duplicated.

// Exported for the migration tests and reuse by future import sources — the
// naming sequence ("Key 2", "Key 3", …) is a product rule, not an accident.
export async function createConnectionWithKeyDedup(createProviderConnection, spec) {
  const base = {
    provider: spec.provider,
    authType: "apikey",
    name: spec.label,
    apiKey: spec.apiKey,
    isActive: spec.isActive !== false,
    testStatus: "unknown",
    ...(spec.providerSpecificData ? { providerSpecificData: spec.providerSpecificData } : {}),
    allowOverwrite: false,
  };
  try {
    return await createProviderConnection(base);
  } catch (error) {
    // A name conflict with a DIFFERENT key is the "Key 2" case. A conflict
    // with the SAME key never reaches here (the caller's existingKeys guard
    // short-circuits first).
    if (error?.code !== "PROVIDER_NAME_CONFLICT") throw error;
    let last = error;
    for (let n = 2; n <= 12; n += 1) {
      try {
        return await createProviderConnection({ ...base, name: `${spec.label} Key ${n}` });
      } catch (err) {
        if (err?.code !== "PROVIDER_NAME_CONFLICT") throw err;
        last = err;
      }
    }
    throw last;
  }
}

async function runNineRouterImport(source) {
  const { getProviderConnections, createProviderConnection } = await import(
    "@/lib/db/repos/connectionsRepo"
  );
  const { getProviderNodeById, createProviderNode } = await import("@/lib/db/repos/nodesRepo");
  const { getCombos, getComboByName, createCombo } = await import("@/lib/db/repos/combosRepo");
  const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo");

  // The registry ids known on THIS build. 9Router predates some providers and
  // names others differently — anything not in this set becomes a custom node.
  const knownProviderIds = new Set();
  try {
    const REGISTRY = (await import("open-sse/providers/registry/index.js")).default;
    for (const entry of Array.isArray(REGISTRY) ? REGISTRY : []) {
      if (entry?.id) knownProviderIds.add(entry.id);
    }
  } catch (error) {
    // Registry unavailable on this build: every id falls through to the
    // custom-node path, which still imports a working connection.
    console.log("[migrations] registry ids unavailable for 9router import:", error.message);
  }

  const nodesById = new Map((source.nodes || []).filter((n) => n?.id).map((n) => [n.id, n]));
  const imported = [];
  const skipped = [];

  // Every api key already stored here, across all providers. The key is the
  // identity — a remapped custom node must not duplicate a key that exists.
  const existingKeys = new Set(
    (await getProviderConnections().catch(() => [])).map((c) => c.apiKey).filter(Boolean)
  );

  // ── provider connections ──
  for (const conn of source.connections || []) {
    const label = conn.name || conn.provider;
    try {
      // Only api-key connections move. An OAuth grant belongs to the upstream
      // account and machine that created it; a copied refresh token is worse
      // than none.
      if (conn.authType && conn.authType !== "apikey") {
        skipped.push({ name: label, reason: `${conn.authType} connections cannot migrate` });
        continue;
      }
      if (!conn.apiKey) {
        skipped.push({ name: label, reason: "no api key stored on the connection" });
        continue;
      }
      if (existingKeys.has(conn.apiKey)) {
        skipped.push({ name: label, reason: "already imported" });
        continue;
      }

      const target = mapNineRouterConnection(conn, nodesById, knownProviderIds);
      let provider;
      let providerSpecificData;
      if (target.known) {
        // Identity mapping: same registry id on both sides.
        provider = target.provider;
        providerSpecificData = conn.providerSpecificData || undefined;
      } else {
        // Unknown id → compatible node. Reuse the 9router node id when it is
        // free here (keeps prefixes stable across a re-import), else mint one
        // the same way AddCompatibleModal does.
        let nodeExists = false;
        if (target.existingNodeId) {
          nodeExists = Boolean(await getProviderNodeById(target.existingNodeId).catch(() => null));
        }
        if (target.existingNodeId && nodeExists) {
          provider = target.existingNodeId;
        } else {
          const prefixPattern =
            target.type === "anthropic-compatible"
              ? "anthropic-compatible-"
              : target.type === "custom-embedding"
                ? "custom-embedding-"
                : "openai-compatible-";
          const { generateId } = await import("@/shared/utils");
          const created = await createProviderNode({
            id: target.existingNodeId || `${prefixPattern}${target.apiType}-${generateId()}`,
            type: target.type,
            prefix: target.prefix,
            apiType: target.apiType,
            baseUrl: target.baseUrl,
            name: target.nodeName,
          });
          provider = created.id;
        }
        providerSpecificData = {
          prefix: target.prefix,
          apiType: target.apiType,
          baseUrl: target.baseUrl,
          nodeName: target.nodeName,
        };
      }

      const created = await createConnectionWithKeyDedup(createProviderConnection, {
        provider,
        label: conn.name || target.nodeName || conn.provider,
        apiKey: conn.apiKey,
        isActive: conn.isActive !== false,
        providerSpecificData,
      });
      existingKeys.add(conn.apiKey);
      imported.push({ id: created.id, name: created.name, kind: "connection", provider });
    } catch (error) {
      const already =
        error?.code === "PROVIDER_NAME_CONFLICT" ? "already imported" : error.message;
      skipped.push({ name: label, reason: already });
    }
  }

  // ── combos ──
  const importedComboNames = new Set();
  for (const combo of source.combos || []) {
    try {
      if (await getComboByName(combo.name)) {
        skipped.push({ name: combo.name, reason: "already exists" });
        continue;
      }
      const created = await createCombo({
        name: combo.name,
        kind: combo.kind ?? null,
        models: Array.isArray(combo.models) ? combo.models : [],
        maxContextWindow: combo.maxContextWindow ?? null,
        displayName: combo.displayName ?? null,
      });
      importedComboNames.add(created.name);
      imported.push({ id: created.id, name: created.name, kind: "combo" });
    } catch (error) {
      skipped.push({ name: combo.name, reason: error.message });
    }
  }

  // ── combo strategies ──
  // The settings row keeps one { comboName: strategyId } object. Strategies
  // only make sense for combos that exist here, and a strategy the user
  // already picked locally always wins over the backup.
  const strategyEntries = Object.entries(source.comboStrategies || {}).filter(
    ([, strategy]) => typeof strategy === "string" && strategy.length > 0
  );
  if (strategyEntries.length) {
    const settings = await getSettings().catch(() => ({}));
    const local = settings?.comboStrategies && typeof settings.comboStrategies === "object"
      ? settings.comboStrategies
      : {};
    const comboNames = new Set([
      ...importedComboNames,
      ...(await getCombos().catch(() => [])).map((c) => c.name),
    ]);
    const merged = { ...local };
    let taken = 0;
    for (const [name, strategy] of strategyEntries) {
      if (!comboNames.has(name) || merged[name] !== undefined) continue;
      merged[name] = strategy;
      taken += 1;
    }
    if (taken > 0) {
      await updateSettings({ comboStrategies: merged });
      imported.push({ name: `${taken} combo strateg${taken === 1 ? "y" : "ies"}`, kind: "setting" });
    }
  }

  return {
    ok: true,
    source: { id: source.id, label: source.label, path: source.path },
    imported,
    skipped,
  };
}

/**
 * Copy the keys of one source into this install. Keys that are already here
 * are left alone, so running the import twice changes nothing. The 9Router
 * source takes the whole-install path above instead.
 */
// ── the OpenCode CLI import ──────────────────────────────────────────────────
//
// OpenCode stores provider definitions (name, baseURL, apiKey) in a JSONC
// config — opencode.json / opencode.jsonc under ~/.config/opencode or
// ~/.opencode. Keys do NOT live inline only: OpenCode keeps them in its auth
// store (~/.local/share/opencode/auth.json) keyed by the provider id. A
// provider whose baseURL matches an OriginRouter registry entry imports onto
// that id; anything else becomes an "openai-compatible" custom node — the
// same path the 9Router import takes. EVERY provider entry imports, including
// key-less and expired ones: the node (name + base URL) becomes a Hand Picked
// configurable the owner can attach a key to later. Only the loop-back
// entries that point at this gateway itself are left out.

function openCodeConfigPaths() {
  // os.homedir() at call time (not the module-load HOME const) so tests can
  // fake the environment per call.
  const home = os.homedir();
  return [
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".opencode", "opencode.jsonc"),
    path.join(home, ".opencode", "opencode.json"),
  ];
}

function readOpenCodeProviders() {
  for (const file of openCodeConfigPaths()) {
    if (!exists(file)) {
      continue;
    }
    try {
      const raw = fs.readFileSync(file, "utf8");
      // JSONC: strip /* */ block and // line comments the way OpenCode's own
      // loader does, then parse. A pure-JSON file survives both paths.
      const jsonc = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = JSON.parse(jsonc);
      }
      const providerMap = parsed?.provider;
      if (!providerMap || typeof providerMap !== "object") continue;
      return { file, providers: providerMap };
    } catch {
      continue; // corrupt config — try the next path, fail open
    }
  }
  return null;
}

// OpenCode's credential store: keys keyed by the provider config id. Both
// layouts exist in the wild (XDG and the legacy dot-folder); read whichever
// is present. Every value is masked on read — nothing here logs keys.
function openCodeAuthStores() {
  const home = os.homedir();
  return [
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(home, ".opencode", "auth.json"),
  ];
}

function readOpenCodeAuthKeys() {
  for (const file of openCodeAuthStores()) {
    if (!exists(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      const keys = {};
      for (const [id, entry] of Object.entries(parsed)) {
        const value = entry?.key || entry?.access || entry?.api_key || entry?.token;
        if (typeof value === "string" && value.length > 0) keys[String(id).toLowerCase()] = value;
      }
      return keys;
    } catch {
      continue;
    }
  }
  return {};
}

async function detectOpenCode() {
  const found = readOpenCodeProviders();
  if (!found) return null;
  const authKeys = readOpenCodeAuthKeys();
  const providers = [];
  for (const [id, cfg] of Object.entries(found.providers || {})) {
    // Inline keys first (options.apiKey), then the auth store. A provider
    // with neither still imports — its node (name + base URL) becomes a
    // configurable the owner can attach a key to later.
    const inlineKey = cfg?.options?.apiKey;
    const inlineKeyOk = typeof inlineKey === "string" && inlineKey.length > 0;
    const apiKey = inlineKeyOk ? inlineKey : authKeys[String(id).toLowerCase()] || null;
    providers.push({
      id: String(id),
      name: String(cfg?.name || id),
      baseUrl: String(cfg?.options?.baseURL || "").replace(/\/+$/, ""),
      apiKey: apiKey || null,
      modelCount: Object.keys(cfg?.models || {}).length,
    });
  }
  return {
    id: "opencode",
    label: "OpenCode CLI",
    path: found.file,
    providers,
  };
}

// Match a baseURL onto a registry provider id by comparing origin+path
// prefixes (registry baseUrls end at /v1-style roots).
async function mapOpenCodeBaseUrls(providers) {
  const known = new Map(); // baseUrl → provider id from OUR registry
  try {
    const { PROVIDERS } = await import("open-sse/providers/index.js");
    for (const [id, cfg] of Object.entries(PROVIDERS || {})) {
      const base = String(cfg?.baseUrl || "").replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
      if (base) known.set(base.toLowerCase(), id);
    }
  } catch { /* registry unavailable → all custom */ }
  return providers.map((p) => {
    const exact = known.get(String(p.baseUrl).toLowerCase());
    if (exact) return { ...p, targetProviderId: exact, custom: false };
    // Prefix match: a config baseURL under a known registry root.
    let prefixHit = null;
    for (const [base, id] of known) {
      if (base && String(p.baseUrl).toLowerCase().startsWith(base)) { prefixHit = id; break; }
    }
    if (prefixHit) return { ...p, targetProviderId: prefixHit, custom: false };
    return { ...p, custom: true };
  });
}

// A base URL pointing at this gateway itself would make the gateway call
// itself on every request — the "OmniRoute"/"9-Router" loop-back entries an
// OpenCode config carries when the owner points OpenCode AT OriginRouter.
function isSelfReferentialBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return false;
    const ownPort = Number(process.env.PORT || 20128);
    return url.port === "" || Number(url.port) === ownPort;
  } catch {
    return false;
  }
}

// One stable identity for an endpoint: lowercase origin+path, no trailing
// slashes. Two config entries sharing it are the same provider no matter
// what each is named.
function endpointIdentity(baseUrl) {
  return String(baseUrl || "").toLowerCase().replace(/\/+$/, "");
}

// Liveness probe for key-less entries: a dead host has nothing to offer even
// after the owner pastes a key, so it is skipped, not imported. Any HTTP
// response (even 401/404) proves the endpoint is alive; only DNS/connection/
// TLS failures count as dead. Probes only https origins — http loopback
// (local engines) imports without a probe, and private ranges are never
// fetched from the server.
async function probeEndpointAlive(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return true; // loopback/other: assume alive
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      await fetch(url.origin + "/", {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });
      return true; // any response = host alive
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function runOpenCodeImport(source) {
  const { getProviderConnections, createProviderConnection } = await import(
    "@/lib/db/repos/connectionsRepo"
  );
  const { getProviderNodes, createProviderNode } = await import("@/lib/db/repos/nodesRepo");
  const { generateId } = await import("@/shared/utils");

  const existingConnections = await getProviderConnections().catch(() => []);
  const existingKeys = new Set(existingConnections.map((c) => c.apiKey).filter(Boolean));
  // Endpoints already configured here — by URL identity, whatever they are
  // named. The owner's dedup rule: a provider that is already with us (from
  // any source, or added by hand) never imports twice.
  let existingNodes = [];
  try {
    existingNodes = await getProviderNodes();
  } catch {
    existingNodes = [];
  }
  const existingUrls = new Map(
    existingNodes
      .map((n) => [endpointIdentity(n.baseUrl), n])
      .filter(([id]) => id),
  );
  // Registry providers that already hold at least one connection.
  const connectedRegistryIds = new Set(
    existingConnections.map((c) => c.provider).filter(Boolean),
  );

  const mapped = await mapOpenCodeBaseUrls(source.providers || []);
  const imported = [];
  const skipped = [];
  // Endpoints imported during THIS run — the same URL in two entries (or in
  // two sources) imports once, under its first name.
  const seenUrls = new Map();

  for (const p of mapped) {
    const label = p.name || p.id;
    try {
      if (!p.baseUrl) {
        skipped.push({ name: label, reason: "no base URL in the OpenCode config" });
        continue;
      }
      if (isSelfReferentialBaseUrl(p.baseUrl)) {
        skipped.push({ name: label, reason: "points at this gateway itself" });
        continue;
      }
      const urlId = endpointIdentity(p.baseUrl);
      const duplicateOf = seenUrls.get(urlId);
      if (duplicateOf) {
        skipped.push({ name: label, reason: `duplicate endpoint — same base URL as ${duplicateOf}` });
        continue;
      }
      const alreadyNode = existingUrls.get(urlId);
      if (alreadyNode) {
        skipped.push({ name: label, reason: `already configured here as ${alreadyNode.name || alreadyNode.id}` });
        continue;
      }
      if (!p.custom && connectedRegistryIds.has(p.targetProviderId)) {
        skipped.push({ name: label, reason: `already connected here (${p.targetProviderId})` });
        continue;
      }
      if (p.apiKey && existingKeys.has(p.apiKey)) {
        skipped.push({ name: label, reason: "already imported" });
        continue;
      }

      let provider = p.targetProviderId;
      let providerSpecificData = null;
      if (p.custom) {
        const created = await createProviderNode({
          id: `openai-compatible-chat-${generateId()}`,
          type: "openai-compatible",
          prefix: p.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24) || "opencode",
          apiType: "chat",
          baseUrl: p.baseUrl,
          name: label,
        });
        provider = created.id;
        existingUrls.set(endpointIdentity(p.baseUrl), created);
        providerSpecificData = {
          prefix: p.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24) || "opencode",
          apiType: "chat",
          baseUrl: p.baseUrl,
          nodeName: label,
        };
      }
      seenUrls.set(urlId, label);

      if (!p.apiKey) {
        // Key-less entry: import only when the endpoint is actually alive —
        // a dead host stays dead even after the owner pastes a key. The
        // configurable lands in Hand Picked with its base URL; a connection
        // appears once the owner attaches a key.
        const alive = await probeEndpointAlive(p.baseUrl);
        if (!alive) {
          seenUrls.delete(urlId);
          skipped.push({ name: label, reason: "endpoint unreachable (looks dead)" });
          continue;
        }
        imported.push({ name: label, kind: "node", provider });
        continue;
      }

      const created = await createConnectionWithKeyDedup(createProviderConnection, {
        provider,
        label,
        apiKey: p.apiKey,
        isActive: true,
        providerSpecificData,
      });
      existingKeys.add(p.apiKey);
      imported.push({ id: created.id, name: created.name, kind: "connection", provider });
    } catch (error) {
      skipped.push({ name: label, reason: error?.code === "PROVIDER_NAME_CONFLICT" ? "already imported" : error.message });
    }
  }

  return {
    ok: true,
    source: { id: source.id, label: source.label, path: source.path },
    imported,
    skipped,
  };
}

export async function runMigration(sourceId) {
  if (sourceId === "9router") {
    const nineRouter = await findSource("9router");
    if (!nineRouter) {
      return { ok: false, error: "That source is not installed on this machine." };
    }
    return runNineRouterImport(nineRouter);
  }
  if (sourceId === "opencode") {
    const openCode = await findSource("opencode");
    if (!openCode) {
      return { ok: false, error: "That source is not installed on this machine." };
    }
    return runOpenCodeImport(openCode);
  }
  const source = await findSource(sourceId);
  if (!source) {
    return { ok: false, error: "That source is not installed on this machine." };
  }

  // Free Claude Code endpoint import: its settings.json env carries one
  // gateway endpoint (base URL + token). The same dedup rules as every other
  // source — nothing imports twice, a loop-back URL imports nothing.
  if (source.endpoint) {
    const { getProviderNodes, createProviderNode } = await import("@/lib/db/repos/nodesRepo");
    const { getProviderConnections, createProviderConnection } = await import(
      "@/lib/db/repos/connectionsRepo"
    );
    const { generateId } = await import("@/shared/utils");

    const baseUrl = source.endpoint.baseUrl;
    if (isSelfReferentialBaseUrl(baseUrl)) {
      return {
        ok: true,
        source: { id: source.id, label: source.label, path: source.path },
        imported: [],
        skipped: [{ name: source.label, reason: "points at this gateway itself" }],
      };
    }

    const [connections, nodes] = await Promise.all([
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
    ]);
    const urlId = endpointIdentity(baseUrl);
    const existingNode = nodes.find((n) => endpointIdentity(n.baseUrl) === urlId);
    const imported = [];
    const skipped = [];

    let provider;
    if (existingNode) {
      provider = existingNode.id;
    } else {
      const created = await createProviderNode({
        id: `anthropic-compatible-${generateId()}`,
        type: "anthropic-compatible",
        apiType: "messages",
        baseUrl,
        name: source.label,
      });
      provider = created.id;
    }

    const existingKeys = new Set(connections.map((c) => c.apiKey).filter(Boolean));
    if (source.endpoint.token && !existingKeys.has(source.endpoint.token)) {
      const created = await createProviderConnection({
        provider,
        authType: "apikey",
        name: source.label,
        apiKey: source.endpoint.token,
        isActive: true,
        testStatus: "unknown",
        allowOverwrite: false,
      });
      imported.push({ id: created.id, name: created.name, kind: "connection", provider });
    } else {
      skipped.push({ name: source.label, reason: existingNode ? "already configured here" : "already imported" });
    }

    return {
      ok: true,
      source: { id: source.id, label: source.label, path: source.path },
      imported,
      skipped,
    };
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
