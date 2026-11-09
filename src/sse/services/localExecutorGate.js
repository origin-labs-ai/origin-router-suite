// The /v1-side gate for local-executor providers (see
// open-sse/config/localExecutors.js for why they are opt-in).
//
// Two entry points, one rule:
//   • localExecutorDeniedResponse() — refuses a direct model request.
//   • isLocalExecutorBlocked()      — drops a model from a combo's rotation.
//
// Both run before any credential lookup, so a disabled provider can never be
// reached by a stale combo, an alias or a direct API call. Fail-closed on
// purpose: an unreadable settings object means OFF, not ON.

import { NextResponse } from "next/server";
import { parseModel, resolveProviderAlias } from "open-sse/services/model.js";
import { isLocalExecutor, isLocalExecutorEnabled } from "open-sse/config/localExecutors.js";

/** Provider id behind a model string ("devin-cli/x", "dv/x", or a bare alias). */
export function providerIdForModel(modelStr) {
  if (typeof modelStr !== "string" || !modelStr.trim()) return null;
  const parsed = parseModel(modelStr.trim());
  if (parsed?.provider) return parsed.provider;
  // Bare alias form ("dev"): resolve it the way the router does everywhere else.
  return resolveProviderAlias(parsed?.model || modelStr.trim());
}

/** True when this model must not be attempted because its executor is disabled. */
export function isLocalExecutorBlocked(settings, modelStr) {
  const providerId = providerIdForModel(modelStr);
  if (!isLocalExecutor(providerId)) return false;
  return !isLocalExecutorEnabled(settings, providerId);
}

/** 403 for a direct request to a disabled local executor, null otherwise. */
export function localExecutorDeniedResponse(settings, modelStr) {
  if (!isLocalExecutorBlocked(settings, modelStr)) return null;
  const providerId = providerIdForModel(modelStr);
  return NextResponse.json(
    {
      error: {
        message:
          `Provider "${providerId}" runs a local agent on this machine and is switched off. ` +
          `Turn it on in Dashboard → Providers → Local executor providers.`,
        type: "invalid_request_error",
        code: "local_executor_disabled",
        param: "model",
      },
    },
    { status: 403 },
  );
}
