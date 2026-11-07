import { NextResponse } from "next/server";
import {
  applyRestorePlan,
  DriveAccessError,
  ensureAccessToken,
  fetchNewestBackup,
  planRestore,
  saveCloudsyncState,
} from "@/lib/cloudsync/googleDrive";
import { getCombos } from "@/lib/db/repos/combosRepo";
import { getModelAliases } from "@/lib/db/repos/aliasRepo";

export const dynamic = "force-dynamic";

// POST /api/cloudsync/restore — pull the newest backup from Drive.
//
// Two-phase, like any destructive-looking operation should be:
//   POST {}               → preview: what a restore would create/change
//   POST { apply: true }  → apply it
//
// Only NON-CREDENTIAL parts are ever applied: combos, model aliases, and the
// settings patch (scrubbed of secrets and of the "*Redacted" placeholders at
// plan time). Provider connections are listed in the preview with a note —
// they arrive without credentials by construction, so restoring them would
// only create rows that cannot authenticate.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const apply = body?.apply === true;

    const accessToken = await ensureAccessToken();
    const backup = await fetchNewestBackup(accessToken);
    if (!backup) {
      return NextResponse.json(
        { ok: false, error: "No backup found in Google Drive appDataFolder yet. Run a sync first.", code: "NO_BACKUP" },
        { status: 404 }
      );
    }

    // The local state the planner merges against.
    const [combos, aliases] = await Promise.all([getCombos(), getModelAliases()]);
    const plan = planRestore(backup, { combos, aliases });

    if (!apply) {
      return NextResponse.json({
        ok: true,
        preview: true,
        backup: { exportedAt: backup.exportedAt || null, version: backup.version || null },
        connectionCount: plan.connectionCount,
        connectionNote: plan.connectionNote,
        combosToCreate: plan.combosToCreate.length,
        combosSkipped: plan.combosSkipped,
        aliasesToSet: Object.keys(plan.aliasesToSet).length,
        aliasesSkipped: plan.aliasesSkipped,
        settingsKeys: Object.keys(plan.settingsPatch),
        errors: plan.errors,
      });
    }

    const result = await applyRestorePlan(plan);
    await saveCloudsyncState({
      lastRestoreAt: new Date().toISOString(),
      ...(result.ok ? { lastError: null } : {}),
    });
    return NextResponse.json({ ok: result.ok, ...result });
  } catch (error) {
    try {
      await saveCloudsyncState({ lastError: error.message, lastErrorAt: new Date().toISOString() });
    } catch {
      // Never let status bookkeeping mask the original error.
    }
    const status = error instanceof DriveAccessError && error.code === "NOT_SIGNED_IN" ? 400 : 502;
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code || "restore_failed" },
      { status }
    );
  }
}
