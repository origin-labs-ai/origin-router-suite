// Tests for the two settings-reset features.
//
//   1. restore-default for ~/.claude/settings.json — restoreClaudeDefaults()
//      in src/lib/claudeCodeSetup.js, backing the POST { action:
//      "restore-default" } branch of the claude-settings route.
//   2. The factory-reset route /api/settings/reset — scopes (rows cleared vs
//      kept, apiKeys survives "all"), backup-before-clearing, and the exact
//      "RESET" confirm guard.
//
// Following the repo's convention (claude-code-setup.test.js,
// compatible-provider-connections.test.js): fs is NOT mocked with vi.mock —
// the modules under test are pointed at temp directories via HOME/USERPROFILE
// (os.homedir() reads those on every call) and DATA_DIR (read once at import
// time, hence the vi.resetModules() + dynamic-import dance), and the real
// filesystem does the rest.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "../helpers/tempCleanup.js";
import {
  claudeBackupPath,
  claudeSettingsPath,
  restoreClaudeDefaults,
} from "../../src/lib/claudeCodeSetup.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-settings-reset-"));
const fakeHome = path.join(tmpRoot, "home");
fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalDataDir = process.env.DATA_DIR;

const readSettingsFile = () => JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf-8"));

// ---------------------------------------------------------------------------
// 1. restore-default
// ---------------------------------------------------------------------------
describe("restoreClaudeDefaults", () => {
  beforeEach(() => {
    // os.homedir() reads these per call, so the module picks the fake home up
    // without being re-imported.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    fs.rmSync(claudeSettingsPath(), { force: true });
    fs.rmSync(claudeBackupPath(), { force: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it("restores the backup content verbatim when a backup exists", async () => {
    // The user's file as it was before OriginRouter touched it.
    const original = {
      theme: "dark",
      hooks: { PostToolUse: [{ matcher: "*", command: "lint.sh" }] },
      env: { CUSTOM_TOOL_PATH: "/usr/local/bin" },
    };
    fs.writeFileSync(claudeBackupPath(), JSON.stringify(original, null, 2));
    // What OriginRouter's setup left on disk.
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1", API_TIMEOUT_MS: "7200000" } })
    );

    const result = await restoreClaudeDefaults();

    expect(result.ok).toBe(true);
    expect(result.restored).toBe("backup");
    // Router keys gone, the user's original content back byte for byte.
    expect(readSettingsFile()).toEqual(original);
  });

  it("surgically removes only managed keys when no backup exists", async () => {
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({
        theme: "dark",
        alwaysThinkingEnabled: true,
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
          ANTHROPIC_AUTH_TOKEN: "sk-router",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/opus",
          API_TIMEOUT_MS: "7200000",
          BASH_MAX_TIMEOUT_MS: "7200000",
          MCP_TOOL_TIMEOUT: "7200000",
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
          KEEP_ME: "user setting",
        },
      })
    );

    const result = await restoreClaudeDefaults();

    expect(result.ok).toBe(true);
    expect(result.restored).toBe("surgical");
    const settings = readSettingsFile();
    // Unrelated user settings survive untouched...
    expect(settings.theme).toBe("dark");
    expect(settings.alwaysThinkingEnabled).toBe(true);
    expect(settings.env.KEEP_ME).toBe("user setting");
    // ...and every router-managed key is gone, including the five timeout
    // flags and CLAUDE_CODE_MAX_OUTPUT_TOKENS (buildClaudeEnv always writes it).
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(settings.env.API_TIMEOUT_MS).toBeUndefined();
    expect(settings.env.BASH_MAX_TIMEOUT_MS).toBeUndefined();
    expect(settings.env.MCP_TOOL_TIMEOUT).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it("reports was-default when nothing of ours is in the file", async () => {
    fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ theme: "light" }));
    const result = await restoreClaudeDefaults();
    expect(result.restored).toBe("was-default");
    // File left exactly as it was — not even rewritten.
    expect(readSettingsFile()).toEqual({ theme: "light" });
  });

  it("reports was-default for a missing settings file", async () => {
    const result = await restoreClaudeDefaults();
    expect(result.restored).toBe("was-default");
    expect(fs.existsSync(claudeSettingsPath())).toBe(false);
  });

  it("ignores a corrupt backup and falls back to surgical removal", async () => {
    // Fail-open: unusable backup content must not be written over the live file.
    fs.writeFileSync(claudeBackupPath(), "{ not json,,,");
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1" }, theme: "dark" })
    );
    const result = await restoreClaudeDefaults();
    expect(result.restored).toBe("surgical");
    const settings = readSettingsFile();
    // The only managed key was in env, so the emptied env block is removed
    // with it; the unrelated top-level key stays.
    expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.theme).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// 2. /api/settings/reset
// ---------------------------------------------------------------------------
// Every test gets a fresh DATA_DIR and a fresh module registry (DATA_DIR is
// captured once at import time), with next/server mocked like
// compatible-provider-connections.test.js does.

function makeResetRequest(body) {
  return new Request("http://localhost:20128/api/settings/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setupResetRoute() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-reset-"));
  process.env.DATA_DIR = dir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  const { POST } = await import("@/app/api/settings/reset/route.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter(); // creates schema + migrations in the temp dir
  return { POST, db, tempDir: dir };
}

const NOW = new Date().toISOString();

// One row in every table a reset can touch, plus the apiKeys row that must
// survive everything.
async function seedRows(db) {
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ cloudEnabled: true, password: "hash" })]);
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?)`, ["c1", "combo-a", "[]", NOW, NOW]);
  db.run(`INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`, ["p1", "openai", "apikey", "{}", NOW, NOW]);
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES(?, ?, ?, 1, ?)`, ["k1", "or-test-key-123", "test", NOW]);
  db.run(`INSERT INTO usageHistory(timestamp) VALUES(?)`, [NOW]);
  db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, ["2026-01-01", "{}"]);
  db.run(`INSERT INTO requestDetails(id, timestamp, data) VALUES(?, ?, ?)`, ["r1", NOW, "{}"]);
  db.run(`INSERT INTO memories(scope, content, createdAt, updatedAt) VALUES(?, ?, ?, ?)`, ["scope-1", "remember this", NOW, NOW]);
  db.run(`INSERT INTO localModels(name, source, addedAt, updatedAt) VALUES(?, ?, ?, ?)`, ["local-m", "ollama", NOW, NOW]);
}

const countRows = (db, table) => db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

describe("settings reset route", () => {
  let tempDir = null;

  afterEach(() => {
    // removeTempDir → releaseDbAdapter(): closes the sqlite handle so Windows
    // can delete the data file (see tempCleanup.js).
    removeTempDir(tempDir);
    tempDir = null;
    vi.doUnmock("next/server");
    vi.resetModules();
    process.env.DATA_DIR = originalDataDir;
  });

  it("rejects a wrong or missing confirm string with 400 and clears nothing", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    for (const confirm of [undefined, "", "reset", "RESET ", " RESET", "CONFIRM"]) {
      const res = await POST(makeResetRequest({ scope: "all", confirm }));
      expect(res.status).toBe(400);
    }

    // None of the rejected attempts may have touched a single row.
    expect(countRows(db, "settings")).toBe(1);
    expect(countRows(db, "combos")).toBe(1);
    expect(countRows(db, "apiKeys")).toBe(1);
    expect(countRows(db, "usageHistory")).toBe(1);
  });

  it("rejects an unknown scope with 400", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    const res = await POST(makeResetRequest({ scope: "apiKeys", confirm: "RESET" }));
    expect(res.status).toBe(400);
    expect(countRows(db, "apiKeys")).toBe(1);
  });

  it("clears only the requested scope and keeps everything else", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    const res = await POST(makeResetRequest({ scope: "combos", confirm: "RESET" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.cleared.combos).toBe(1);

    expect(countRows(db, "combos")).toBe(0);
    // Everything outside the scope survives.
    expect(countRows(db, "settings")).toBe(1);
    expect(countRows(db, "providerConnections")).toBe(1);
    expect(countRows(db, "apiKeys")).toBe(1);
    expect(countRows(db, "usageHistory")).toBe(1);
  });

  it("scope usage clears history + daily rollups but keeps request details", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    const res = await POST(makeResetRequest({ scope: "usage", confirm: "RESET" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleared.usageHistory).toBe(1);
    expect(data.cleared.usageDaily).toBe(1);

    expect(countRows(db, "usageHistory")).toBe(0);
    expect(countRows(db, "usageDaily")).toBe(0);
    // requestDetails is its own scope — usage does not take it with it.
    expect(countRows(db, "requestDetails")).toBe(1);
    expect(countRows(db, "apiKeys")).toBe(1);
  });

  it("backs up the database before clearing (backup holds the pre-reset rows)", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    const res = await POST(makeResetRequest({ scope: "combos", confirm: "RESET" }));
    expect(res.status).toBe(200);
    const { backupDir } = await res.json();

    expect(typeof backupDir).toBe("string");
    expect(fs.existsSync(backupDir)).toBe(true);
    // The backup lives under the temp DATA_DIR and carries the DB file.
    expect(fs.readdirSync(backupDir)).toContain("data.sqlite");

    // The snapshot was taken BEFORE the rows were deleted: the seeded
    // pre-reset state is still readable from the backup copy.
    const { DatabaseSync } = await import("node:sqlite");
    const backupDb = new DatabaseSync(path.join(backupDir, "data.sqlite"));
    try {
      expect(backupDb.prepare("SELECT COUNT(*) AS n FROM combos").get().n).toBe(1);
    } finally {
      backupDb.close();
    }
    // ...while the live table is empty now.
    expect(countRows(db, "combos")).toBe(0);
  });

  it("scope all clears every scoped table but apiKeys survives", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    const res = await POST(makeResetRequest({ scope: "all", confirm: "RESET" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(fs.existsSync(data.backupDir)).toBe(true);

    for (const table of ["settings", "combos", "providerConnections", "usageHistory", "usageDaily", "requestDetails", "localModels", "memories"]) {
      expect(countRows(db, table)).toBe(0);
    }
    // The whole point of the exception: gateway keys survive the reset so the
    // user is not locked out of their own router.
    expect(countRows(db, "apiKeys")).toBe(1);
  });

  it("scope settings resets the settings table to defaults", async () => {
    const { POST, db, tempDir: dir } = await setupResetRoute();
    tempDir = dir;
    await seedRows(db);

    const res = await POST(makeResetRequest({ scope: "settings", confirm: "RESET" }));
    expect(res.status).toBe(200);
    expect((await res.json()).cleared.settings).toBe(1);
    expect(countRows(db, "settings")).toBe(0);

    // With the row gone, getSettings() answers with pure defaults again.
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    expect(settings.cloudEnabled).toBe(false);
  });
});


