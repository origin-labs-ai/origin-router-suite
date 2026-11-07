// Factory reset for OriginRouter's own data — safe by construction.
//
// POST { scope: "settings" | "combos" | "connections" | "usage" | "all",
//        confirm: "RESET" }
//
// Before ANY row is deleted, the whole database is snapshotted with the same
// helpers the schema migrations use (makeBackupDir + backupDbLite), so every
// destructive action leaves a recovery copy under DATA_DIR/db/backups/. If
// the backup cannot be taken, the reset aborts with a 500 and nothing is
// touched — deleting data without a recovery path is never acceptable.
//
// Scope → tables whose ROWS are cleared (tables and schema stay):
//   settings    → settings (back to defaults. This also drops the stored
//                 dashboard password hash — the same effect
//                 /api/auth/reset-password has — so login falls back to the
//                 default password, never locking the owner out)
//   combos      → combos
//   connections → providerConnections
//   usage       → usageHistory + usageDaily
//   all         → settings + combos + connections + usage + requestDetails
//                 + localModels + memories
//
// ⚠️ apiKeys is deliberately NOT in any scope: gateway API keys must survive
// a factory reset so the user is not locked out of their own router and
// configured agents keep authenticating. Keys can still be removed one by
// one from the dashboard. localModels rows are dropped but the model files
// on disk stay (this table only ever stored their paths).

import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { makeBackupDir, backupDbLite, pruneOldBackups } from "@/lib/db/backup.js";

export const dynamic = "force-dynamic";

// The exact string the caller must echo to prove intent. Anything else —
// missing, lowercase, padded — is refused with a 400 before any read/write.
const REQUIRED_CONFIRM = "RESET";

// Fixed whitelist of tables per scope. SQLite cannot bind table names as SQL
// parameters, so safety here comes from this map: request input only ever
// picks a key between them and never supplies an identifier.
const SCOPE_TABLES = {
  settings: ["settings"],
  combos: ["combos"],
  connections: ["providerConnections"],
  usage: ["usageHistory", "usageDaily"],
  all: [
    "settings",
    "combos",
    "providerConnections",
    "usageHistory",
    "usageDaily",
    "requestDetails",
    "localModels",
    "memories",
    // NOT apiKeys — see the header comment above.
  ],
};

export async function POST(request) {
  try {
    // Fail-open body parsing: an unparseable body means no valid confirm
    // string, which the guard below rejects — it never crashes the route.
    const body = await request.json().catch(() => ({}));
    const { scope, confirm } = body || {};

    // Guard first: refuse before touching anything.
    if (confirm !== REQUIRED_CONFIRM) {
      return NextResponse.json(
        { error: 'Confirmation required: confirm must be exactly "RESET"' },
        { status: 400 }
      );
    }

    const tables = SCOPE_TABLES[scope];
    if (!tables) {
      return NextResponse.json(
        { error: `Unknown scope. Valid scopes: ${Object.keys(SCOPE_TABLES).join(", ")}` },
        { status: 400 }
      );
    }

    const db = await getAdapter();

    // Backup BEFORE clearing. backupDbLite throws on failure, which lands in
    // the catch below as a 500 with nothing deleted (fail-safe: we never
    // destroy data we could not snapshot first).
    const backupDir = makeBackupDir(`reset-${scope}`);
    backupDbLite(db, backupDir);
    pruneOldBackups();

    // Clear rows inside one transaction so a failure midway cannot leave a
    // half-reset scope. Each table's row count is read first so the response
    // can say exactly what was removed.
    const cleared = {};
    db.transaction(() => {
      for (const table of tables) {
        const row = db.get(`SELECT COUNT(*) AS n FROM ${table}`);
        db.run(`DELETE FROM ${table}`);
        cleared[table] = row?.n ?? 0;
      }
    });

    return NextResponse.json({ ok: true, backupDir, cleared });
  } catch (error) {
    console.log("Error resetting OriginRouter data:", error);
    return NextResponse.json(
      { error: "Failed to reset OriginRouter data", detail: error?.message },
      { status: 500 }
    );
  }
}
