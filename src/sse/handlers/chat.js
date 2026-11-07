import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getSkillsPromptBlock } from "@/lib/skillsPipeline/promptBlock.js";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, handlePipelineChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { normalizeStrategy } from "@/lib/routing/strategies.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest, synthesizeResponse } from "open-sse/utils/bypassHandler.js";
import { LAST_RESORT_TEXT } from "open-sse/utils/lastResortText.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveRoutingPolicy } from "@/lib/routingPolicy";
import { setMidStreamSilent } from "open-sse/utils/midStreamPolicy.js";
import { acquireSlot, beginConnection } from "../services/inflight.js";
import { findAlternateRoutes } from "../services/alternateRoutes.js";
import { orderRoutes, markDegraded, clearRoute } from "../services/routeHealth.js";
import { rankRoutes, recordOutcome } from "../services/pandaRouter.js";
import { createRouterBrain } from "../services/routerBrain.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";

// Sent by the dashboard's model test (/api/models/test). It means "answer
// honestly: did THIS provider serve THIS model id?". The promise that a client
// never sees an upstream error exists for agent traffic — Claude Code, CLIs, SDK
// calls — which must keep running through a bad seat. It was never meant for a
// connection check, where a swallowed error turns a broken model into a green
// checkmark. Requests carrying this header skip synthesis, failover and hedging,
// and no connection state is written on their account.
const MODEL_TEST_HEADER = "x-or-model-test";

function isStrictModelTest(request) {
  return request?.headers?.get?.(MODEL_TEST_HEADER) === "1";
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 *
 * @param {Request} request
 * @param {object|null} clientRawRequest
 * @param {{ internal?: boolean }} [options] internal=true is for routes that are
 *   already gated by the dashboard session (e.g. /api/dashboard/chat); those must
 *   not additionally demand an API key.
 */
export async function handleChat(request, clientRawRequest = null, options = {}) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  // Resilience policy: how hard the router keeps looking, and the one thing it
  // must never do — answer a client with an upstream API error.
  const policy = resolveRoutingPolicy(settings);
  // Applies process-wide: an aborted stream closes cleanly instead of emitting an
  // error frame the caller would surface as an API error.
  setMidStreamSilent(policy.midStreamSilent);
  const resilience = {
    policy,
    settings,
    body,
    modelStr,
    request,
    clientRawRequest,
    apiKey,
    // The endpoint is the authority on wire format (/v1/messages ⇒ Claude).
    sourceFormat: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
    strictModelTest: isStrictModelTest(request),
    tried: new Set([modelStr]),
  };
  // Wrappers so every exit of this handler passes through the same guard.
  // The seat-silence budget is injected here so every combo entry point — top level,
  // capacity adapter, nested — walks on the same rule without repeating the knob.
  const comboChat = (args) => serve(handleComboChat({ seatSilenceMs: policy.seatSilenceMs, ...args }), resilience);
  const fusionChat = (args) => serve(handleFusionChat(args), resilience);
  const pipelineChat = (args) => serve(handlePipelineChat(args), resilience);
  if (settings.requireApiKey && options.internal !== true) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global. Legacy and
    // alternate names normalize through the strategy registry (24 strategies
    // since v0.6.000); unknown ids fall back to the declaration order.
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = normalizeStrategy(comboSpecificStrategy || settings.comboStrategy || "fallback");
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "pipeline") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: pipeline)`);
      return pipelineChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, policy);
        },
        log,
        comboName: modelStr,
        steps: comboStrategies[modelStr]?.pipelineSteps,
      });
    }

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return fusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, policy);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const comboCfg = comboStrategies[modelStr] || {};
    // The router brain decides which member of this combo carries the task: Panda
    // profiles the task text and grades each seat by calibrated P(success)/cost,
    // Jev (System One) classifies the task semantically, and "merged" blends both
    // into one score per seat. Which of the three runs is Settings → Routing
    // resilience → Router brain, overridable per combo.
    const brain = createRouterBrain({ body, policy, comboCfg, comboName: modelStr, log });
    const preOrdered = await brain.preOrder(augmentedModels, comboStrategy);
    const comboOrder = preOrdered.items;
    const pandaPlan = preOrdered.plan;
    if (pandaPlan?.traceId) {
      resilience.panda = { traceId: pandaPlan.traceId, request: pandaPlan.request, response: pandaPlan.response };
    }
    resilience.brain = brain.mode;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, brain: ${brain.mode}, sticky: ${comboStickyLimit})`);
    return comboChat({
      body,
      models: comboOrder,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => attemptSeat(b, m, clientRawRequest, request, apiKey, policy),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      sessionId,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      weights: comboCfg.weights || {},
      // Brain strategies let the merged Jev+Panda gate pick the seat per request.
      // AutoAgressive switches more eagerly than smart (lower confidence bar) so
      // a degrading seat is abandoned sooner — the situation adjusts the knobs.
      resolveSmartChoice: (comboStrategy === "smart" || comboStrategy === "auto" || comboStrategy === "autoaggressive") && brain.mode !== "panda"
        ? (b, m) => brain.choose(m)
        : null,
      confidenceThresholdOverride: comboStrategy === "autoaggressive" ? 0.6 : null,
    });
  }

  // Single model request. `explicitModelSticky` (default on) is the owner's rule:
  // "I am testing THIS model from THIS provider" must not be turned into a request
  // for some other model by the capability adapter. Combos route freely; a direct
  // target stays exactly where it was pointed, and only same-model provider
  // rotation may move it. Turn the setting off to restore adapter switching.
  const soloAugmented = policy.explicitModelSticky
    ? [modelStr]
    : await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return comboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => attemptSeat(b, m, clientRawRequest, request, apiKey, policy),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  const requestedModel = contextMarker
    ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]`
    : null;
  const primary = handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, requestedModel, policy);
  resilience.requestedModel = requestedModel;
  return serve(hedgedSingle(resilience, primary), resilience);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, policy = null) {
  const activePolicy = policy || resolveRoutingPolicy(await getSettings());
  // A test click is an observation, not an intervention: it must never cool a
  // healthy seat down just because a probe tripped a 429.
  const strictTest = isStrictModelTest(request);
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, policy);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      // A nested combo gets the same brain treatment as a top-level one, so
      // "claude-opus-5-5 → someCombo" is decided by the configured brains rather
      // than falling back to raw member order.
      const brain = createRouterBrain({ body, policy: activePolicy, comboCfg, comboName: modelStr, log });
      const preOrdered = await brain.preOrder(augmentedModels, comboStrategy);
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, brain: ${brain.mode}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        seatSilenceMs: activePolicy.seatSilenceMs,
        models: preOrdered.items,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => attemptSeat(b, m, clientRawRequest, request, apiKey, policy),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart" && brain.mode !== "panda"
          ? (b, m) => brain.choose(m)
          : null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    // Admission control + per-connection load, held for the dispatch window
    // (until upstream answers with headers). This is what lets several agents
    // run at once instead of stampeding one credential.
    // Resolved before the dispatch wrapper: the arrow below is not async, and
    // the lazy module warm-up must not delay holding the slot.
    const pxpipeTransform = chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null;
    // Built before the dispatch slot: the arrow below is not async, and the
    // block itself is process-cached (60s) so this costs one settings read.
    const skillsPrompt = await getSkillsPromptBlock();
    const result = await withDispatchSlot(activePolicy, credentials.connectionId, () => handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      customPromptEnabled: !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      // The skills/local-models system-prompt block, built once per process
      // (60s cache) in the pipeline module; null when disabled or empty.
      skillsPrompt,
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    }));

    if (result.success) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : strictTest
        ? false
        : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}

// The last-resort completion text lives in open-sse/utils/lastResortText.js so the
// dashboard model test can recognise it and refuse to call it a working model.

/**
 * Hold an upstream slot and a connection's load counter for one dispatch.
 * Released as soon as the provider answers with headers — the window in which a
 * fleet of agents would otherwise collide on the same credential.
 */
async function withDispatchSlot(policy, connectionId, run) {
  const releaseSlot = await acquireSlot(policy);
  const releaseConnection = beginConnection(connectionId);
  try {
    return await run();
  } finally {
    releaseConnection();
    releaseSlot();
  }
}

/**
 * Answer a short request from a second seat if the first one stays silent.
 *
 * This is what keeps an agent's own timeout from ever firing: Claude Code's
 * permission/safety classifier asks for a quick yes-no, and when the seat that
 * got it was busy the client gave up and reported the model as unavailable.
 * After policy.hedgeMs the same prompt is dispatched to another provider in
 * parallel and whichever answers first is returned. Large payloads are not
 * hedged — duplicating a full reasoning turn costs quota for nothing.
 */
async function hedgedSingle(ctx, primary) {
  const { policy, body } = ctx;
  // Racing a second seat would answer "is THIS model up?" with "whatever replied
  // first", so a test never hedges.
  if (ctx.strictModelTest) return primary;
  if (!policy.enabled || !policy.failoverEnabled || policy.hedgeMs <= 0) return primary;

  let bytes = 0;
  try {
    bytes = JSON.stringify(body).length;
  } catch {
    return primary;
  }
  if (bytes > policy.hedgeMaxBytes) return primary;

  const resolved = await getModelInfo(ctx.modelStr).catch(() => null);
  if (!resolved?.provider || !resolved?.model) return primary;
  const alternates = (await findAlternateRoutes({
    model: resolved.model,
    providerId: resolved.provider,
  })).slice(0, 2);
  if (alternates.length === 0) return primary;

  const backup = (async () => {
    await sleep(policy.hedgeMs);
    const route = alternates[0].route;
    ctx.tried.add(route);
    log.info("HEDGE", `⏱ ${ctx.modelStr} silent for ${policy.hedgeMs}ms → racing ${route}`);
    return handleSingleModelChat(body, route, ctx.clientRawRequest, ctx.request, ctx.apiKey, null, policy);
  })();

  return firstSuccessful([primary, backup]);
}

/**
 * Resolve with the first successful Response among concurrent attempts.
 * Losers are drained so their streams do not linger; if none succeeds the
 * first failure is returned and serve() takes over the rotation.
 */
function firstSuccessful(promises) {
  return new Promise((resolve) => {
    let remaining = promises.length;
    let firstFailure = null;
    let settled = false;

    promises.forEach((promise) => {
      Promise.resolve(promise).then((response) => {
        if (settled) {
          if (!response?.ok) response?.body?.cancel?.().catch(() => { });
          return;
        }
        if (response?.ok) {
          settled = true;
          resolve(response);
          return;
        }
        if (!firstFailure) firstFailure = response;
        remaining -= 1;
        if (remaining === 0) {
          settled = true;
          resolve(firstFailure);
        }
      }).catch(() => {
        remaining -= 1;
        if (!settled && remaining === 0) {
          settled = true;
          resolve(firstFailure);
        }
      });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The guard every exit of handleChat passes through.
 *
 * A non-2xx here means some provider could not serve the request. That answer
 * must never reach the caller: keep walking the other providers that serve the
 * same model, trim the prompt when the block is a prompt-size/quota cap, and if
 * truly nothing served it, answer with a valid completion in the client's own
 * format. The upstream error stays in the router's log as a failover note.
 */
async function serve(responseOrPromise, ctx) {
  const { policy } = ctx;
  const response = await responseOrPromise;
  if (!policy?.enabled) return response;
  if (response?.ok) {
    // The seat that answered is healthy for every agent, and the orchestrator
    // gets a real outcome to learn from.
    clearRoute(ctx.modelStr);
    reportPandaOutcome(ctx, ctx.modelStr, true);
    return response;
  }

  const errorText = await readErrorText(response);

  // A dashboard model test asks whether THIS provider serves THIS model id. Handing
  // it a synthesized completion, or an answer from some other provider carrying the
  // same id, would report a broken model as a working one. The upstream answer
  // travels back untouched; the no-error promise stays for agent traffic.
  if (ctx.strictModelTest) {
    log.warn("MODELTEST", `✗ ${ctx.modelStr} unserved (${response?.status || "ERR"}) — reported to the dashboard as-is`, { internal: errorText });
    return response;
  }

  log.warn("RESILIENT", `⚠ ${ctx.modelStr} unserved (${response?.status || "ERR"}) → rotating; client sees no error`, {
    internal: errorText,
  });

  if (policy.failoverEnabled) {
    const recovered = await failoverAcrossProviders({ ...ctx, errorText });
    if (recovered) return recovered;
  }

  if (policy.lastResort === "passthrough") return response;

  log.warn("RESILIENT", `⛑ no route served ${ctx.modelStr}; answering with a valid completion`);
  return synthesizeResponse({
    body: ctx.body,
    model: ctx.body?.model || ctx.modelStr,
    text: LAST_RESORT_TEXT,
    format: ctx.sourceFormat,
  });
}

/**
 * Walk every other provider that serves the same model until one answers.
 * @returns {Promise<Response|null>} a successful response, or null if nothing served it
 */
async function failoverAcrossProviders(ctx) {
  const { policy, body, tried, clientRawRequest, request, apiKey } = ctx;
  const deadline = Date.now() + policy.failoverDeadlineMs;
  const targets = await resolveFailoverTargets(ctx);
  const triedProviders = new Set();
  let attempts = 0;

  for (const target of targets) {
    if (Date.now() > deadline) break;
    const resolved = await getModelInfo(target).catch(() => null);
    if (!resolved?.provider || !resolved?.model) continue;
    triedProviders.add(resolved.provider);

    const alternates = await findAlternateRoutes({
      model: resolved.model,
      providerId: resolved.provider,
      excludeProviders: triedProviders,
    });
    if (alternates.length === 0) continue;

    // Order the seats: Panda's judgement when it recognises these models (it
    // scores P(success), expected cost and latency for THIS task text), then the
    // shared breaker — rotating start, seats that just refused any concurrent
    // agent pushed to the back. Neither the herd nor a repeated full sweep.
    // Jev-only mode deliberately skips this: its brain grades models for a task,
    // not the provider seats serving one model id.
    let queue = orderRoutes(alternates, (item) => item.route, policy.degradeCooldownMs);
    if (policy.panda.enabled && policy.panda.decideProvider && alternates.length > 1 && policy.routerBrain !== "jev") {
      const plan = await rankRoutes({ routes: alternates, body, policy, log });
      if (plan?.routes?.length) {
        ctx.panda = ctx.panda || { traceId: plan.traceId };
        queue = orderRoutes(plan.routes, (item) => item.route, policy.degradeCooldownMs);
      }
    }
    queue = queue.slice(0, Math.max(0, policy.maxFailoverRoutes));
    log.info("RESILIENT", `↪ ${resolved.model} also on ${queue.length} seat(s): ${queue.map((r) => r.route).join(", ")}`);

    for (const candidate of queue) {
      if (Date.now() > deadline || tried.has(candidate.route)) continue;
      tried.add(candidate.route);
      attempts += 1;
      // A short, jittered rest between hops. Every agent that reaches this point
      // failed at the same moment, so without it all eight sweep the whole fleet
      // again in the same millisecond — the hammering the owner called "sab models
      // par baar-baar". The first hop is immediate: no reason to delay a retry.
      if (attempts > 1) await hopPause(policy.hopBackoffMs, attempts);

      let response = null;
      let candidateError = "";
      try {
        response = await handleSingleModelChat(
          body,
          candidate.route,
          clientRawRequest,
          request,
          apiKey,
          null,
          policy,
        );
      } catch (error) {
        candidateError = error?.message || String(error);
      }

      if (response?.ok) {
        clearRoute(candidate.route);
        reportPandaOutcome(ctx, candidate.route, true);
        log.info("RESILIENT", `✓ recovered via ${candidate.route}`);
        return response;
      }

      // A seat that refused is evidence for every other agent too, so it is
      // parked globally with a growing cooldown instead of being re-tried by the
      // next request in the same second. The prompt is never trimmed: the wrong
      // seat is replaced, the conversation is not.
      if (!candidateError) candidateError = await readErrorText(response);
      markDegraded(candidate.route, {
        status: response?.status,
        error: candidateError,
        cooldownMs: policy.degradeCooldownMs,
      });
      reportPandaOutcome(ctx, candidate.route, false);
      log.warn("RESILIENT", `↪ ${candidate.route} unserved (${response?.status || "THREW"}); next seat`);
    }
  }

  if (attempts === 0) log.info("RESILIENT", `no alternate provider route for ${ctx.modelStr}`);
  return null;
}

// Feed the result back to the orchestrator (route → run → verify → escalate).
function reportPandaOutcome(ctx, modelId, success) {
  const traceId = ctx?.panda?.traceId;
  if (!traceId || !ctx?.policy?.panda?.enabled) return;
  recordOutcome({ traceId, modelId, success, policy: ctx.policy }).catch(() => { });
}

// Rest between failover hops, jittered and capped, so concurrent agents spread out
// instead of retrying in lockstep. Never long enough to look like a stall.
const HOP_PAUSE_CAP_MS = 4000;
function hopPause(baseMs, hopNumber) {
  const base = Math.max(0, Number(baseMs) || 0);
  if (!base) return Promise.resolve();
  const growth = Math.min(base * Math.max(1, hopNumber - 1), HOP_PAUSE_CAP_MS);
  const jittered = growth * (0.5 + Math.random());
  return new Promise((resolve) => setTimeout(resolve, Math.min(HOP_PAUSE_CAP_MS, Math.round(jittered))));
}

/**
 * What the walk should start from. A combo already rotated over its members and
 * still failed, so its members' other-provider seats are the next best guess;
 * a plain model gets its own id.
 */
async function resolveFailoverTargets(ctx) {
  if (ctx.failoverTargets?.length) return ctx.failoverTargets;
  const { modelStr } = ctx;
  if (modelStr?.includes("/")) return [modelStr];
  const members = await getComboModels(modelStr).catch(() => null);
  return members?.length ? members.slice(0, 3) : [modelStr];
}

/**
 * A refusal that no retry can fix: the key is dead, the account has no credit or
 * permission, or that pool simply does not carry this model. Retrying these on
 * every request is what turns 105 seats into 400 wasted upstream attempts.
 */
const PERMANENT_STATUS = new Set([401, 403, 404]);
const PERMANENT_TEXTS = [
  "invalid_api_key", "invalid or revoked api key", "model not found",
  "model_unpriced_or_unavailable", "not priced or available",
  "no permission to access", "insufficient balance", "out of credits",
  "daily check-in required", "no_entitlement",
];

function isPermanentRejection(status, text = "") {
  const code = Number(status);
  if (PERMANENT_STATUS.has(code)) return true;
  const lower = String(text || "").toLowerCase();
  return PERMANENT_TEXTS.some((needle) => lower.includes(needle));
}

/**
 * One seat of a combo walk, with its result reported to the shared route breaker.
 *
 * The combo walk lives in open-sse and keeps its memory inside one request, so
 * without this the seven other agents start fresh and walk the same dead seat from
 * the top — the "sab models par baar-baar" hammering the owner pointed at, and the
 * reason a broken connection can absorb a hundred attempts in a few minutes. One
 * failure now counts for every concurrent session, for as long as the policy's
 * escalating cooldown says so.
 */
async function attemptSeat(body, modelStr, clientRawRequest, request, apiKey, policy) {
  let response = null;
  let thrown = "";
  try {
    response = await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, null, policy);
  } catch (error) {
    thrown = error?.message || String(error);
  }

  if (response?.ok) {
    clearRoute(modelStr);
  } else {
    const errorText = thrown || (await readErrorText(response));
    const base = policy?.degradeCooldownMs ?? 45000;
    markDegraded(modelStr, {
      status: response?.status,
      error: errorText,
      // A permanent refusal is parked five times longer than a transient one: the
      // seat will not become usable in the next 45 seconds, and the fleet is full of
      // keys and pools that are simply gone.
      cooldownMs: isPermanentRejection(response?.status, errorText) ? Math.max(base * 5, 150000) : base,
    });
  }

  if (thrown) throw new Error(thrown);
  return response;
}

// Upstream error text, kept inside the router for rotation decisions and logs.
async function readErrorText(response) {
  if (!response) return "";
  try {
    const text = await response.clone().text();
    if (!text) return response.statusText || "";
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.message || parsed?.error || parsed?.message || text;
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}
