// The first-run wizard has to find an install that is really there, read the
// keys out of it, and leave the source alone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-migration-"));

// A fake home with one router install in it: the same layout the real
// installs use (a data folder with db/data.sqlite).
const fakeHome = path.join(tmpRoot, "home");
const installDir = path.join(fakeHome, ".router-install");
fs.mkdirSync(path.join(installDir, "db"), { recursive: true });

function writeInstallDb(dir, keys) {
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec(
    "CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)"
  );
  const insert = db.prepare(
    "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)"
  );
  for (const [index, entry] of keys.entries()) {
    insert.run(`id-${index}`, entry.key, entry.name, "machine", 1, new Date().toISOString());
  }
  db.close();
}

writeInstallDb(installDir, [
  { key: "sk-imported-one-key-value", name: "openrouter" },
  { key: "sk-imported-two-key-value", name: "groq" },
]);

// The env-var install: one .env file per provider.
const fccDir = path.join(fakeHome, ".fcc");
fs.mkdirSync(fccDir, { recursive: true });
fs.writeFileSync(
  path.join(fccDir, "provider-openrouter.env"),
  'OPENROUTER_API_KEY="sk-free-claude-code-key-value"\n# comment\nOTHER=ignored\n'
);

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

describe("migration sources", () => {
  it("finds a router install by what it contains, not by what it is called", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { sources } = await listSources();
    const router = sources.find((source) => source.id.startsWith("router:"));
    expect(router).toBeTruthy();
    expect(router.label).toBe(".router-install");
    expect(router.keyCount).toBe(2);
  });

  it("reads the keys out of a detected install", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await listSources();
    const router = candidates.routerInstalls[0];
    expect(router.keys).toHaveLength(2);
    expect(router.keys.map((entry) => entry.key)).toContain("sk-imported-one-key-value");
  });

  it("reads the provider keys out of an env-file install", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await listSources();
    const fcc = candidates.freeClaudeCode;
    expect(fcc).toBeTruthy();
    expect(fcc.keys.some((entry) => entry.key === "sk-free-claude-code-key-value")).toBe(true);
    expect(fcc.keys.some((entry) => entry.key === "ignored")).toBe(false);
  });

  it("always lists the three kinds of sources, found or not", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { sources } = await listSources();
    const ids = sources.map((source) => source.id);

    expect(sources).toHaveLength(3);
    expect(ids.some((id) => id.startsWith("router:"))).toBe(true);
    expect(ids).toContain("omniroute");
    expect(ids).toContain("free-claude-code");
    // A source that is not on this machine is shown, but not offered.
    for (const source of sources) {
      expect(typeof source.available).toBe("boolean");
      if (!source.available) expect(source.keyCount).toBe(0);
    }
  });

  it("never offers our own data folder as a source", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await listSources();
    const paths = candidates.routerInstalls.map((entry) => entry.path);
    expect(paths.some((p) => p.endsWith(".or"))).toBe(false);
  });

  it("leaves the source install untouched", async () => {
    const { listSources } = await import("../../src/lib/migrations/sources.js");
    const { candidates } = await listSources();
    const before = fs.readdirSync(path.join(installDir, "db"));
    await listSources();
    const after = fs.readdirSync(path.join(installDir, "db"));
    expect(after.sort()).toEqual(before.sort());
  });
});
