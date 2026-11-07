// The 9Router migration source.
//
// 9Router persists through the same SQLite driver chain this repo uses, so its
// data directory carries the same shaped database. These tests cover the two
// halves of the feature: detection (which folders, which files, in which
// order) and the import mapping (registry ids map one-to-one, unknown ids
// become openai-compatible custom nodes, combos and strategies move over).
//
// The fixtures are built with node:sqlite in a temp dir the same way
// migration-sources.test.js builds its fake installs. The import half runs
// against a temp DATA_DIR, so the whole repo-DB layer (driver chain, schema
// migrations, repos) is exercised for real without touching the machine's
// own data in ~/.or.
import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-9router-"));

// A fake home (detection scans it) and a fake data dir (the import writes here).
const fakeHome = path.join(tmpRoot, "home");
const fakeDataDir = path.join(tmpRoot, "data");

// Data-dir candidates, in the order detection tries them:
// ~/.9router → %APPDATA%/9router → ~/.config/9router.
const candidateDirs = {
  home: path.join(fakeHome, ".9router"),
  appData: path.join(fakeHome, "appdata-roaming", "9router"),
  config: path.join(fakeHome, ".config", "9router"),
};

function writeNineRouterSqlite(dir) {
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db.sqlite"));
  db.exec(`
    CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE providerNodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, maxContextWindow INTEGER, displayName TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT);
  `);
  const insertConn = db.prepare(
    "INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data) VALUES(?,?,?,?,?,?,?,?)"
  );
  // A connection on a provider id both routers share → maps one-to-one.
  insertConn.run("c1", "deepseek", "apikey", "DeepSeek main", null, 1, 1, JSON.stringify({ apiKey: "sk-9r-deepseek-key" }));
  // A connection on an id this build's registry does not know → custom node,
  // base URL found in the connection's own providerSpecificData.
  insertConn.run("c2", "legacy-provider-x", "apikey", "Legacy X", null, 2, 1, JSON.stringify({
    apiKey: "sk-9r-custom-key",
    providerSpecificData: { baseUrl: "https://legacy-x.example.com/v1" },
  }));
  // A connection bound to a 9router custom node → node row carries the base URL.
  insertConn.run("c3", "openai-compatible-chat-n1", "apikey", "Special node", null, 3, 1, JSON.stringify({ apiKey: "sk-9r-node-key" }));
  // An OAuth grant → never migrates (the token belongs to that machine's login).
  insertConn.run("c4", "codex", "oauth", "Codex account", "me@example.com", 4, 1, JSON.stringify({ refreshToken: "1//secret" }));

  db.prepare("INSERT INTO providerNodes(id, type, name, data) VALUES(?,?,?,?)").run(
    "openai-compatible-chat-n1",
    "openai-compatible",
    "Special cloud",
    JSON.stringify({ prefix: "special", apiType: "chat", baseUrl: "https://special.example.com/v1" })
  );

  const insertCombo = db.prepare(
    "INSERT INTO combos(id, name, kind, models, maxContextWindow, displayName) VALUES(?,?,?,?,?,?)"
  );
  insertCombo.run("k1", "Work", null, JSON.stringify(["deepseek/deepseek-chat"]), 128000, null);
  insertCombo.run("k2", "Cheap", null, JSON.stringify(["openai-compatible-chat-n1/special/model"]), null, "Cheap one");

  db.prepare("INSERT INTO settings(id, data) VALUES(1, ?)").run(
    JSON.stringify({ comboStrategies: { Work: "fallback", Cheap: "round_robin", Nonexistent: "smart" } })
  );
  db.close();
}

// Env must be set before the first dynamic import: sources.js captures HOME at
// module load, and dataDir.js captures DATA_DIR for the whole db layer.
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.APPDATA = candidateDirs.appData.replace(/9router$/, "");
process.env.DATA_DIR = fakeDataDir;
process.env.ORIGINROUTER_MIRROR_DIR = path.join(tmpRoot, "mirror");

// Detection writes nothing; the import test only enables the fixture later,
// so the first describe below runs against a machine WITHOUT 9Router.
writeNineRouterSqlite(candidateDirs.home);

// Same rows in the legacy JSON layout, for the db.json fallback test.
function writeNineRouterJson(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "db.json"),
    JSON.stringify({
      providerConnections: [
        { id: "j1", provider: "groq", authType: "apikey", name: "Groq key", isActive: true, apiKey: "sk-9r-json-groq" },
      ],
      combos: [{ id: "jk1", name: "JsonCombo", models: ["groq/llama-3.3-70b-versatile"] }],
      settings: { comboStrategies: { JsonCombo: "fallback" } },
    })
  );
}
writeNineRouterJson(candidateDirs.config);

describe("9router detection heuristics", () => {
  it("finds ~/.9router first, via its db.sqlite", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { sources, candidates } = await listSources();
    const entry = sources.find((source) => source.id === "9router");
    expect(entry).toBeTruthy();
    expect(entry.available).toBe(true);
    expect(entry.label).toBe("9Router");
    expect(entry.detail).toContain(candidateDirs.home);
    // keyCount is everything that would move, not just keys:
    // 4 connections + 2 combos + 3 strategy entries.
    expect(entry.keyCount).toBe(9);
    const found = candidates.nineRouter;
    expect(found.connections).toHaveLength(4);
    expect(found.nodes).toHaveLength(1);
    expect(found.combos).toHaveLength(2);
    expect(found.comboStrategies).toEqual({ Work: "fallback", Cheap: "round_robin", Nonexistent: "smart" });
    // Credentials read out of the data column, not the row:
    expect(found.connections[0].apiKey).toBe("sk-9r-deepseek-key");
  });

  it("falls through to %APPDATA%/9router when the home candidate has no data", async () => {
    fs.renameSync(candidateDirs.home, `${candidateDirs.home}.hidden`);
    try {
      fs.mkdirSync(candidateDirs.appData, { recursive: true });
      fs.copyFileSync(path.join(candidateDirs.home + ".hidden", "db.sqlite"), path.join(candidateDirs.appData, "db.sqlite"));
      const { listSources } = await import("../../src/lib/migrations/sources.js");
      const { sources } = await listSources();
      const entry = sources.find((source) => source.id === "9router");
      expect(entry.available).toBe(true);
      expect(entry.detail).toContain(candidateDirs.appData);
    } finally {
      fs.rmSync(candidateDirs.appData, { recursive: true, force: true });
      fs.renameSync(`${candidateDirs.home}.hidden`, candidateDirs.home);
    }
  });

  it("reads the legacy db.json layout in ~/.config/9router", async () => {
    fs.renameSync(candidateDirs.home, `${candidateDirs.home}.hidden`);
    try {
      const { listSources } = await import("../../src/lib/migrations/sources.js");
      const { sources, candidates } = await listSources();
      const entry = sources.find((source) => source.id === "9router");
      expect(entry.available).toBe(true);
      expect(entry.detail).toContain(candidateDirs.config);
      expect(candidates.nineRouter.connections[0].provider).toBe("groq");
      expect(candidates.nineRouter.connections[0].apiKey).toBe("sk-9r-json-groq");
    } finally {
      fs.renameSync(`${candidateDirs.home}.hidden`, candidateDirs.home);
    }
  });

  it("shows 9Router greyed out when no candidate holds a database", async () => {
    fs.renameSync(candidateDirs.home, `${candidateDirs.home}.hidden`);
    fs.rmSync(candidateDirs.config, { recursive: true, force: true });
    try {
      const { listSources } = await import("../../src/lib/migrations/sources.js");
      const { sources } = await listSources();
      const entry = sources.find((source) => source.id === "9router");
      expect(entry.available).toBe(false);
      expect(entry.keyCount).toBe(0);
    } finally {
      fs.renameSync(`${candidateDirs.home}.hidden`, candidateDirs.home);
      writeNineRouterJson(candidateDirs.config);
    }
  });
});

// The mapping rule, pure: known registry ids map to themselves; unknown ids
// become compatible-node targets with the best base URL available.
describe("9router provider id mapping", () => {
  const known = new Set(["deepseek", "groq", "codex"]);
  const nodesById = new Map([
    ["openai-compatible-chat-n1", {
      id: "openai-compatible-chat-n1", type: "openai-compatible", name: "Special cloud",
      prefix: "special", apiType: "chat", baseUrl: "https://special.example.com/v1",
    }],
  ]);

  it("maps a registry id both sides share onto itself", async () => {
    const sources = await loadSources();
    const mapped = sources.mapNineRouterConnection(
      { provider: "deepseek" }, nodesById, known
    );
    expect(mapped).toEqual({ known: true, provider: "deepseek" });
  });

  it("sends an unknown id to a custom node, base URL from providerSpecificData", async () => {
    const sources = await loadSources();
    const mapped = sources.mapNineRouterConnection(
      { provider: "legacy-provider-x", providerSpecificData: { baseUrl: "https://legacy-x.example.com/v1" } },
      nodesById, known
    );
    expect(mapped.known).toBe(false);
    expect(mapped.type).toBe("openai-compatible");
    expect(mapped.baseUrl).toBe("https://legacy-x.example.com/v1");
    expect(mapped.prefix).toBe("legacy-provider-x");
    expect(mapped.apiType).toBe("chat");
    expect(mapped.nodeName).toBe("legacy-provider-x");
  });

  it("prefers the 9router node row for an unknown id bound to a node", async () => {
    const sources = await loadSources();
    const mapped = sources.mapNineRouterConnection(
      { provider: "openai-compatible-chat-n1" }, nodesById, known
    );
    expect(mapped.known).toBe(false);
    expect(mapped.baseUrl).toBe("https://special.example.com/v1");
    expect(mapped.prefix).toBe("special");
    expect(mapped.nodeName).toBe("Special cloud");
    expect(mapped.existingNodeId).toBe("openai-compatible-chat-n1");
  });

  it("keeps the anthropic-compatible node type when the node says so", async () => {
    const sources = await loadSources();
    const anthropicNodes = new Map([
      ["anthropic-compatible-abc", {
        id: "anthropic-compatible-abc", type: "anthropic-compatible", name: "AC node",
        prefix: "ac-x", baseUrl: "https://ac.example.com/v1",
      }],
    ]);
    const mapped = sources.mapNineRouterConnection(
      { provider: "anthropic-compatible-abc" }, anthropicNodes, known
    );
    expect(mapped.type).toBe("anthropic-compatible");
    expect(mapped.baseUrl).toBe("https://ac.example.com/v1");
  });

  it("sanitizes prefixes into model-id-safe strings", async () => {
    const sources = await loadSources();
    const mapped = sources.mapNineRouterConnection(
      { provider: "Legacy Provider X!! (v2)" }, new Map(), known
    );
    expect(mapped.prefix).toBe("legacy-provider-x-v2");
  });
});

// Loaded lazily (and cached) so the env vars above are settled before any
// src module runs — sources.js captures HOME at import time.
let moduleCache = null;
async function loadSources() {
  if (!moduleCache) moduleCache = await import("../../src/lib/migrations/sources.js");
  return moduleCache;
}

// The full import, for real: the report shape, the providerConnections rows
// written through connectionsRepo, the created node, combos, strategies —
// all against a temp DATA_DIR, then a second run to prove idempotency.
describe("9router import", () => {
  let report = null;

  it("imports connections, combos and strategies in the shared report shape", async () => {
    const { runMigration } = await loadSources();
    report = await runMigration("9router");

    expect(report.ok).toBe(true);
    expect(report.source).toEqual({
      id: "9router",
      label: "9Router",
      path: candidateDirs.home,
    });
    expect(Array.isArray(report.imported)).toBe(true);
    expect(Array.isArray(report.skipped)).toBe(true);

    // 3 connections + 2 combos + 1 strategies entry; the OAuth grant skipped.
    const byKind = report.imported.filter((entry) => entry.kind === "connection");
    expect(byKind).toHaveLength(3);
    expect(report.imported.filter((entry) => entry.kind === "combo")).toHaveLength(2);
    expect(report.skipped).toEqual([
      { name: "Codex account", reason: "oauth connections cannot migrate" },
    ]);
  });

  it("maps a known registry id onto the same provider", async () => {
    const { getProviderConnections } = await import("../../src/lib/db/repos/connectionsRepo.js");
    const conns = await getProviderConnections({ provider: "deepseek" });
    expect(conns).toHaveLength(1);
    expect(conns[0].authType).toBe("apikey");
    expect(conns[0].apiKey).toBe("sk-9r-deepseek-key");
    expect(conns[0].isActive).toBe(true);
  });

  it("imports an unknown id as an openai-compatible custom node + connection", async () => {
    const { getProviderConnections } = await import("../../src/lib/db/repos/connectionsRepo.js");
    const { getProviderNodes } = await import("../../src/lib/db/repos/nodesRepo.js");

    const legacy = await getProviderConnections({ provider: "legacy-provider-x" });
    expect(legacy).toHaveLength(0); // the row is keyed by the NODE id, not the old id

    const nodes = await getProviderNodes();
    const created = nodes.find((node) => node.type === "openai-compatible" && node.baseUrl === "https://legacy-x.example.com/v1");
    expect(created).toBeTruthy();
    expect(created.prefix).toBe("legacy-provider-x");
    expect(created.apiType).toBe("chat");

    const conn = (await getProviderConnections({ provider: created.id }))[0];
    expect(conn).toBeTruthy();
    expect(conn.apiKey).toBe("sk-9r-custom-key");
    expect(conn.providerSpecificData).toMatchObject({
      prefix: "legacy-provider-x",
      apiType: "chat",
      baseUrl: "https://legacy-x.example.com/v1",
      nodeName: "legacy-provider-x",
    });
  });

  it("reuses the 9router node id when it is free on this install", async () => {
    const { getProviderConnections } = await import("../../src/lib/db/repos/connectionsRepo.js");
    // Connections are found by their provider column (= the node id here).
    const conns = await getProviderConnections({ provider: "openai-compatible-chat-n1" });
    expect(conns).toHaveLength(1);
    expect(conns[0].apiKey).toBe("sk-9r-node-key");
    expect(conns[0].providerSpecificData.baseUrl).toBe("https://special.example.com/v1");
    expect(conns[0].providerSpecificData.prefix).toBe("special");
    // And the node row itself kept the 9router id.
    const { getProviderNodeById } = await import("../../src/lib/db/repos/nodesRepo.js");
    const node = await getProviderNodeById("openai-compatible-chat-n1");
    expect(node).toBeTruthy();
    expect(node.prefix).toBe("special");
  });

  it("brings the combos over with their models", async () => {
    const { getCombos } = await import("../../src/lib/db/repos/combosRepo.js");
    const combos = await getCombos();
    const names = combos.map((c) => c.name);
    expect(names).toContain("Work");
    expect(names).toContain("Cheap");
    const work = combos.find((c) => c.name === "Work");
    expect(work.models).toEqual(["deepseek/deepseek-chat"]);
    expect(work.maxContextWindow).toBe(128000);
  });

  it("merges comboStrategies into settings for combos that exist here", async () => {
    const { getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    expect(settings.comboStrategies.Work).toBe("fallback");
    expect(settings.comboStrategies.Cheap).toBe("round_robin");
    expect(settings.comboStrategies.Nonexistent).toBeUndefined();
  });

  it("is a no-op the second time it runs", async () => {
    const { runMigration } = await loadSources();
    const second = await runMigration("9router");
    expect(second.ok).toBe(true);
    expect(second.imported).toHaveLength(0);
    const reasons = second.skipped.map((entry) => entry.reason);
    expect(reasons.filter((reason) => reason === "already imported")).toHaveLength(3);
    expect(reasons.filter((reason) => reason === "already exists")).toHaveLength(2);
  });
});
