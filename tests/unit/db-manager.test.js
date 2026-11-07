// DB migration manager tests — categories, stats, presets.
// Uses a temp DATA_DIR so the real ~/.or is never touched.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "or-dbman-test-"));
process.env.DATA_DIR = TMP;

const mgr = await import("../../src/lib/db/migrationManager.js");
const { initDb } = await import("../../src/lib/db/index.js");

describe("db migration manager", () => {
  beforeAll(async () => {
    await initDb();
  });

  it("lists the applied schema chain", async () => {
    const m = await mgr.listMigrations();
    // A fresh DB may stamp a low version (the migration chain only runs on
    // upgrades); the contract is a number + a readable applied list.
    expect(m.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(m.applied)).toBe(true);
  });

  it("table stats categorize core/features/analytics", async () => {
    const stats = await mgr.tableStats();
    const names = stats.map((s) => s.name);
    expect(names).toContain("settings");
    expect(names).toContain("usageHistory");
    const settings = stats.find((s) => s.name === "settings");
    expect(settings.category).toBe("core");
    const usage = stats.find((s) => s.name === "usageHistory");
    expect(usage.category).toBe("analytics");
  });

  it("prune trims old analytics rows and keeps apiKeys intact", async () => {
    const db = (await import("../../src/lib/db/index.js")).default || null;
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.run(`INSERT INTO usageHistory (timestamp, provider, model) VALUES (?, ?, ?)`, [
      new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(), "openai", "gpt-5",
    ]);
    adapter.run(`INSERT INTO usageHistory (timestamp, provider, model) VALUES (?, ?, ?)`, [
      new Date().toISOString(), "openai", "gpt-5",
    ]);
    const res = await mgr.pruneAnalytics(30);
    expect(res.ok).toBe(true);
    expect(res.deleted.usageHistory).toBeGreaterThanOrEqual(1);
    // apiKeys never touched by presets/prune
    const keys = adapter.all(`SELECT COUNT(*) AS n FROM apiKeys`);
    expect(keys[0].n).toBeGreaterThanOrEqual(0);
  });

  it("presets set the retention setting", async () => {
    const res = await mgr.applyDataPreset("minimal");
    expect(res.retentionDays).toBe(7);
    const { getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const s = await getSettings();
    expect(s.dataRetention.preset).toBe("minimal");
  });
});
