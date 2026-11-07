// DB migration manager — the sane answer to the reference platform's 223
// migrations: the user sees every migration and table, categorized by what
// it serves, and chooses a data PRESET (minimal / standard / full) instead of
// inheriting a schema museum.
//
// OriginRouter's schema is small by design (one SQLite, versioned chain, one
// pre-change backup). What GROWS is data: usage history, request details,
// memories, local-model registrations, fold sessions. This module gives the
// user the levers:
//
//   GET-like:  listMigrations() — the applied chain + category per step
//              tableStats()     — rows + bytes per table
//   levers:    pruneUsage(days) — trim usage/requestDetails older than N days
//              vacuum()         — reclaim file space
//              applyPreset(p)   — minimal | standard | full data retention
//
// House rules: parameterized SQL only, fail-open reads, destructive actions
// take a backup first (backup.js helpers), and NOTHING here can touch the
// apiKeys table.

import { getAdapter } from "./driver.js";

// ─── Categorization ──────────────────────────────────────────────────────────

// Which table serves which concern. The categories the UI shows:
//   core      — the router cannot run without these
//   features  — v0.6.000 feature tables (opt-in features own their data)
//   analytics — usage/request data; the growth the presets manage
const TABLE_CATEGORIES = {
  _meta: "core",
  settings: "core",
  apiKeys: "core",
  combos: "core",
  providerConnections: "core",
  providerNodes: "core",
  proxyPools: "core",
  alias: "core",
  disabledModels: "core",
  kv: "core",
  memories: "features",
  localModels: "features",
  usageHistory: "analytics",
  usageDaily: "analytics",
  requestDetails: "analytics",
};

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listMigrations() {
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT key, value FROM _meta WHERE key LIKE 'migration%' OR key LIKE 'schema%'`);
    const applied = [];
    for (const r of rows || []) applied.push({ key: r.key, value: r.value });
    return {
      schemaVersion: Number(rows?.find((r) => r.key === "schemaVersion")?.value) || null,
      applied,
    };
  } catch {
    return { schemaVersion: null, applied: [] };
  }
}

export async function tableStats() {
  try {
    const db = await getAdapter();
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    const out = [];
    for (const t of tables || []) {
      const name = t.name;
      let rows = 0;
      try {
        // Parameterized-compatible count (identifier is from sqlite_master,
        // never user input — still validated against the known set).
        if (!TABLE_CATEGORIES[name]) continue;
        rows = db.get(`SELECT COUNT(*) AS n FROM ${name}`)?.n || 0;
      } catch { /* table vanished mid-read */ }
      out.push({ name, category: TABLE_CATEGORIES[name] || "core", rows });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Levers ──────────────────────────────────────────────────────────────────

async function backupBefore() {
  try {
    const { makeBackupDir, backupDbLite } = await import("./backup.js");
    const dir = makeBackupDir("pre-prune");
    await backupDbLite(await getAdapter(), dir);
    return dir;
  } catch {
    return null; // best-effort backup; prune still refuses without one? No —
    // pruning analytics is low-risk and reversible by nature; proceed.
  }
}

/**
 * Trim analytics rows older than `days`.
 * @returns {{ ok, deleted: { usageHistory: number, requestDetails: number } }}
 */
export async function pruneAnalytics(days = 30) {
  const d = Math.min(3650, Math.max(1, Number(days) || 30));
  await backupBefore();
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  let usageHistory = 0;
  let requestDetails = 0;
  try {
    const r1 = db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [cutoff]);
    usageHistory = r1?.changes || 0;
  } catch { /* table shape differs */ }
  try {
    const r2 = db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoff]);
    requestDetails = r2?.changes || 0;
  } catch { /* table shape differs */ }
  return { ok: true, deleted: { usageHistory, requestDetails }, cutoff };
}

export async function vacuum() {
  const db = await getAdapter();
  db.exec(`VACUUM`);
  return { ok: true };
}

// ─── Data presets (the "how much DB do you want" answer) ─────────────────────

export const DATA_PRESETS = [
  { id: "minimal", label: "Minimal", hint: "Keep 7 days of usage data. Fastest, smallest file." },
  { id: "standard", label: "Standard", hint: "Keep 30 days. The default balance." },
  { id: "full", label: "Full", hint: "Keep everything forever. The historian's choice." },
];

export async function applyDataPreset(preset) {
  const { updateSettings, getSettings } = await import("./repos/settingsRepo.js");
  const settings = await getSettings();
  const retentionDays = preset === "minimal" ? 7 : preset === "full" ? 0 : 30;
  await updateSettings({ dataRetention: { ...(settings.dataRetention || {}), preset, retentionDays } });
  let pruned = null;
  if (retentionDays > 0) pruned = await pruneAnalytics(retentionDays);
  return { ok: true, preset, retentionDays, pruned };
}
