import { NextResponse } from "next/server";
import {
  exchangeCode,
  getCloudsyncState,
  saveCloudsyncState,
  storeCloudTokens,
} from "@/lib/cloudsync/googleDrive";

export const dynamic = "force-dynamic";

// GET /api/cloudsync/callback — Google redirects here with ?code=…&state=…
// (or ?error=… when the user said no). We exchange the code, seal the refresh
// token into settings, and bounce the browser back to the profile page with a
// result flag the card can read.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const fail = (reason) =>
      NextResponse.redirect(
        new URL(`/dashboard/profile?cloudsync=error&reason=${encodeURIComponent(reason)}`, url.origin)
      );

    // Google signalled a refusal (access_denied et al.) — nothing to exchange.
    const oauthError = url.searchParams.get("error");
    if (oauthError) return fail(oauthError);

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code) return fail("missing_code");

    const state = await getCloudsyncState();

    // CSRF: the state we sent must be the state Google returned. Fail CLOSED
    // here on purpose — a mismatch is someone else's flow, not a glitch.
    if (!state.oauthState || !returnedState || returnedState !== state.oauthState) {
      return fail("state_mismatch");
    }

    const redirectUri = `${url.origin}/api/cloudsync/callback`;
    const tokens = await exchangeCode({
      clientId: state.clientId,
      clientSecret: state.clientSecret || "",
      code,
      redirectUri,
    });

    if (!tokens.refreshToken) {
      // access_type=offline + prompt=consent should always yield one; without
      // it sync cannot survive the hour, so treat that as a failure.
      return fail("no_refresh_token");
    }

    await storeCloudTokens(tokens);
    // Clear the one-time CSRF state, and any stale error, on success.
    await saveCloudsyncState({ oauthState: null, lastError: null });

    return NextResponse.redirect(new URL("/dashboard/profile?cloudsync=ok", url.origin));
  } catch (error) {
    console.log("Error in cloudsync callback:", error);
    // Send the reason along so the profile card can show it.
    const origin = new URL(request.url).origin;
    return NextResponse.redirect(
      new URL(`/dashboard/profile?cloudsync=error&reason=${encodeURIComponent(error.message)}`, origin)
    );
  }
}
