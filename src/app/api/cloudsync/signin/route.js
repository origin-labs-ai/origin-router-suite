import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  buildAuthUrl,
  getCloudsyncState,
  DEFAULT_CLIENT_ID,
  saveCloudsyncState,
} from "@/lib/cloudsync/googleDrive";

export const dynamic = "force-dynamic";

// GET /api/cloudsync/signin — hand the browser the Google consent-screen URL.
//
// The user brings their own OAuth client (Google will not let a published
// client use drive.appdata), so the client id travels two ways:
//   ?clientId=…  the wizard passes what was typed and it gets persisted here
//   settings.cloudsync.clientId  what a previous sign-in saved
// Without either, we return a friendly error and the documented default
// placeholder rather than a consent URL that can only fail at Google's end.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const queryClientId = (url.searchParams.get("clientId") || "").trim();
    const queryClientSecret = (url.searchParams.get("clientSecret") || "").trim();

    // Persist what the user supplied, so later syncs and the status card see it.
    if (queryClientId) {
      await saveCloudsyncState({
        clientId: queryClientId,
        ...(queryClientSecret ? { clientSecret: queryClientSecret } : {}),
      });
    }

    const state = await getCloudsyncState();
    const clientId = state.clientId || queryClientId || "";

    if (!clientId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "A Google OAuth Client ID is required. Create one at console.cloud.google.com (OAuth client, Web application), add this dashboard's /api/cloudsync/callback as an authorized redirect URI, and paste the client id here.",
          defaultPlaceholder: DEFAULT_CLIENT_ID,
          authUrl: null,
        },
        { status: 400 }
      );
    }

    // The redirect points back at THIS dashboard, whatever host it is served
    // on (localhost in dev, a LAN/tunnel address otherwise) — the browser does
    // the redirecting, so the outbound-request private-host rule does not apply.
    const redirectUri = `${url.origin}/api/cloudsync/callback`;

    // Opaque CSRF token, stored and compared in the callback. Fail-closed on
    // mismatch: unlike the rest of the module, a state mismatch means someone
    // else started the flow, and "fail open" would be the wrong direction.
    const oauthState = crypto.randomBytes(16).toString("hex");
    await saveCloudsyncState({ oauthState });

    const authUrl = buildAuthUrl({ clientId, redirectUri, state: oauthState });
    return NextResponse.json({ ok: true, authUrl });
  } catch (error) {
    console.log("Error building cloudsync signin URL:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
