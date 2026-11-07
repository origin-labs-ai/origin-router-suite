import { NextResponse } from "next/server";
import {
  ensureAccessToken,
  getCloudsyncState,
  listBackups,
  DEFAULT_CLIENT_ID,
} from "@/lib/cloudsync/googleDrive";

export const dynamic = "force-dynamic";

// GET /api/cloudsync/status — what the wizard and the profile page need to
// draw the Google Drive card: signed in or not, when the last sync ran, what
// went wrong (if anything), and whether a backup actually exists in Drive.
//
// Auth: no per-route guard, matching /api/combos — the dashboard guard is
// deny-by-default for every /api/* path, so this route is only reachable with
// a valid dashboard session (or the local CLI token).
export async function GET() {
  try {
    const state = await getCloudsyncState();

    // "Signed in" means we hold a sealed refresh token. The email and the
    // client id stay readable so the card can show them.
    const connected = state.connected === true && Boolean(state.credentials);

    // Probe Drive for a real backup when signed in. Fail-open: any error here
    // (offline, token expired, scope refused) just reports "no backup known"
    // instead of turning a status check into a failure page.
    let hasBackup = false;
    let backupAt = null;
    let probeError = null;
    if (connected) {
      try {
        const accessToken = await ensureAccessToken();
        const files = await listBackups(accessToken);
        if (files.length) {
          hasBackup = true;
          backupAt = files[0].modifiedTime || null;
        }
      } catch (error) {
        // Not signed-in-valid anymore, or appDataFolder refused. Surface the
        // reason; the card can offer re-signing in.
        probeError = error.message;
      }
    }

    return NextResponse.json({
      connected,
      email: state.email || null,
      clientIdConfigured:
        typeof state.clientId === "string" && state.clientId && state.clientId !== DEFAULT_CLIENT_ID,
      lastSyncAt: state.lastSyncAt || null,
      lastError: state.lastError || null,
      hasBackup,
      backupAt,
      probeError,
    });
  } catch (error) {
    console.log("Error reading cloudsync status:", error);
    return NextResponse.json({ error: "Failed to read cloud sync status" }, { status: 500 });
  }
}
