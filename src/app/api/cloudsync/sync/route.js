import { NextResponse } from "next/server";
import {
  buildBackupPayload,
  DriveAccessError,
  ensureAccessToken,
  saveCloudsyncState,
  uploadBackup,
} from "@/lib/cloudsync/googleDrive";

export const dynamic = "force-dynamic";

// POST /api/cloudsync/sync — snapshot this install to Google Drive, now.
//
// The payload leaves this machine already redacted (see buildBackupPayload):
// provider connection rows are stripped to an allow-list and every credential-
// shaped settings field is replaced with a placeholder before upload, so no
// API key, token, secret or password can reach Drive even if the rest of the
// pipeline were changed carelessly later.
export async function POST() {
  try {
    const accessToken = await ensureAccessToken();
    const payload = await buildBackupPayload();
    const result = await uploadBackup(accessToken, payload);

    await saveCloudsyncState({
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      lastBackupFileId: result.fileId,
    });

    return NextResponse.json({
      ok: true,
      lastSyncAt: new Date().toISOString(),
      fileId: result.fileId,
      bytes: Buffer.byteLength(JSON.stringify(payload)),
    });
  } catch (error) {
    // Record the failure so the status card can show it, then answer with the
    // same message. appDataFolder refusals get their own typed code.
    try {
      await saveCloudsyncState({ lastError: error.message, lastErrorAt: new Date().toISOString() });
    } catch {
      // Never let status bookkeeping mask the original error.
    }
    const status = error instanceof DriveAccessError && error.code === "NOT_SIGNED_IN" ? 400 : 502;
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code || "sync_failed" },
      { status }
    );
  }
}
