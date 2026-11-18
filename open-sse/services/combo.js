/**
 * Shared combo (model combo) handling with fallback support
 */

// The pipeline judge prompt: how the final seat uses the draft thread.
function buildPipelinePrompt(drafts) {
  const parts = drafts.map(
    (d, i) => `--- Draft ${i + 1} (from ${d.model}) ---\n${d.text}`
  );
  return [
    "You are the final stage of a pipeline. Earlier stages produced the drafts below.",
    "Produce the final answer: improve on the drafts, resolve their disagreements,",
    "and answer the user's actual request. Do not mention the drafts or the pipeline.",
    "",
    ...parts,
  ].join("\n");
}

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { parseModel } from "./model.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { peekStreamForContent, reconstructStream, isNoRetryFinish } from "./emptyFailover.js";
import { EMPTY_PEEK_DEADLINE_MS } from "../config/runtimeConfig.js";
import {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";
import { orderSeats, recordComboOutcome } from "./comboOrderers.js";
import {
  HYDRAFUSION_CATEGORIES,
  HYDRAFUSION_DEFAULT_EFFORT,
  HYDRAFUSION_DEFAULT_PATTERN,
  planHydraRun,
  rankHydraSeats,
  resolveHydraEffort,
} from "../config/hydrafusion.js";
import { injectHydraState, loadHydraState, saveHydraState } from "./hydrafusionState.js";
import { isSeatHealthy, markSeatFailure, markSeatSuccess } from "./seatHealth.js";

// Peek a 2xx combo response for real content. Returns null for non-SSE responses (leave
// them untouched). For SSE, returns { outcome: "content"|"empty", finishReason, response }
// where `response` is a faithful replay of the original stream (head buffer + live reader).
async function peekComboResponse(result, log, deadlineMs = EMPTY_PEEK_DEADLINE_MS) {
  const ct = (result.headers.get("content-type") || "").toLowerCase();
  if (!result.body || !ct.includes("text/event-stream")) return null;
  const peeked = await peekStreamForContent(result.body, { deadlineMs });
  const response = new Response(reconstructStream(peeked.head, peeked.reader, peeked.pendingRead), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  return {
    outcome: peeked.outcome,
    finishReason: peeked.finishReason,
    timedOut: peeked.timedOut,
    // Did the upstream send a real frame (data:/event:), or only keepalive comments?
    // This is the quota decision: a seat that has not produced a frame is queued or
    // dead and can be replaced, while one that is streaming is worth waiting for.
    sawFrame: peeked.sawFrame,
    response,
  };
}

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
// Random-spread rotation state: the shuffled order plus how many requests have
// reused it. Held per combo so a burst of parallel agents lands on different
// seats, while a short sticky window still lets prompt caches stay warm.
const randomRotationState = new Map();

function shuffleRotation(models, comboName, stickyLimit) {
  const rotationKey = comboName || "__default__";
  const limit = normalizeStickyLimit(stickyLimit);
  const state = randomRotationState.get(rotationKey);

  if (state && state.count < limit) {
    randomRotationState.set(rotationKey, { order: state.order, count: state.count + 1 });
    return state.order;
  }

  // Fisher-Yates. Every seat stays in the list, so all of them get tried across
  // requests — no seat is permanently skipped and none is always first.
  const order = [...models];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  randomRotationState.set(rotationKey, { order, count: 1 });
  return order;
}

export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1) {
    return models;
  }

  // Random spread: every request walks the seats in a freshly shuffled order,
  // so a fleet of agents fans out over all of them instead of queueing behind
  // the same first model. The order is held for `stickyLimit` requests per combo,
  // which is what keeps prompt-cache warm when the same seat is reused.
  if (strategy === "random") {
    return shuffleRotation(models, comboName, stickyLimit);
  }

  if (strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) {
    comboRotationState.delete(comboName);
    randomRotationState.delete(comboName);
    clearStickyComboSession(comboName);
  } else {
    comboRotationState.clear();
    clearStickyComboSession();
  }
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Detect whether a 2xx JSON response contains zero usable content
 * (e.g. empty assistant message with in_progress/incomplete)
 * so combo fallback can continue to the next model.
 */
export function isZeroContentResponse(data) {
  if (!data || typeof data !== "object") return false;

  // OpenAI chat format
  if (Array.isArray(data.choices)) {
    if (data.choices.length === 0) return true;
    const choice = data.choices[0];
    if (!choice) return true;

    const msg = choice.message || choice.delta;
    const content = msg?.content;
    const hasContent = typeof content === "string" ? content.trim().length > 0 : (Array.isArray(content) && content.length > 0);
    const hasToolCalls = (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg?.function_call);
    const hasReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim().length > 0 : false;

    const finish = choice.finish_reason;
    const isNormalFinish = finish === "stop" || finish === "length" || finish === "tool_calls" || finish === "function_call";

    if (!hasContent && !hasToolCalls && !hasReasoning && (!isNormalFinish || finish === "in_progress" || finish === "incomplete")) {
      return true;
    }
  }

  // Anthropic messages format
  if (Array.isArray(data.content)) {
    const hasContent = data.content.some((c) => (c.type === "text" && c.text?.trim().length > 0) || c.type === "tool_use");
    const stopReason = data.stop_reason;
    if (!hasContent && (!stopReason || stopReason === "in_progress" || stopReason === "incomplete")) {
      return true;
    }
  }

  return false;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback", "round-robin", or "smart"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {boolean} [options.autoSwitch=true] - Capability auto-switching
 * @param {string|null} [options.sessionId=null] - Client session identifier for prompt cache retention
 * @param {string} [options.smartPolicy="smart"] - Policy: "smart" (adaptive ≥80%), "strict" (lock 1st model), "per-turn", or "custom"
 * @param {boolean} [options.sessionSticky=true] - Keep chosen model across session requests to retain prompt cache
 * @param {number} [options.confidenceThreshold=0.8] - Minimum confidence required for model switch (0-1)
 * @param {Function|null} [options.resolveSmartChoice=null] - Smart router resolver callback: (body, models) => Promise<{ choice, probabilities, confidence } | null>
 * @returns {Promise<Response>}
 */
export async function handleComboChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  comboStrategy,
  comboStickyLimit = 1,
  autoSwitch = true,
  sessionId = null,
  smartPolicy = "smart",
  sessionSticky = true,
  confidenceThreshold = 0.8,
  resolveSmartChoice = null,
  // Per-seat weights for the "weighted" strategy (comboStrategies[name].weights)
  weights = {},
  // AutoAgressive tightens the smart-switch bar (lower = switch sooner).
  confidenceThresholdOverride = null,
  // How long a member may hold the turn without sending a single byte before the
  // walk cuts it and advances. Tunable from Settings → Routing resilience.
  seatSilenceMs = EMPTY_PEEK_DEADLINE_MS,
}) {
  let rotatedModels = models;
  let activeStickyModel = null;

  if (comboStrategy === "smart") {
    const policy = (typeof smartPolicy === "string" ? smartPolicy : "smart").toLowerCase();
    const isPerTurn = policy === "per-turn" || sessionSticky === false;
    const isStrict = policy === "strict";

    let switchThreshold = 0.8;
    if (policy === "custom") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    } else if (policy === "smart-switch-70") switchThreshold = 0.7;
    else if (policy === "smart-switch-90") switchThreshold = 0.9;
    else if (policy.startsWith("smart-switch") || policy === "smart") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    }
    // AutoAgressive: the strategy, not the operator, adjusts the bar.
    if (typeof confidenceThresholdOverride === "number" && confidenceThresholdOverride > 0) {
      switchThreshold = confidenceThresholdOverride;
    }

    if (!isPerTurn && sessionId) {
      activeStickyModel = getStickyComboModel(comboName, sessionId, models);
    }

    if (activeStickyModel) {
      if (isStrict) {
        // Strict Lock: re-use sticky model without invoking System One (0ms, 0 extra tokens)
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
        log.info("COMBO", `smart-router [strict] locked session "${sessionId}" → ${activeStickyModel}`);
      } else if (typeof resolveSmartChoice === "function") {
        // Smart Switch (Adaptive): check if the user's task drastically shifted
        try {
          const smartResult = await resolveSmartChoice(body, models);
          const newChoice = smartResult?.choice;
          const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

          if (newChoice && newChoice !== activeStickyModel && models.includes(newChoice) && conf !== null && conf >= switchThreshold) {
            // Task changed with high confidence: switch model and update session
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router [smart-switch] task changed → switched from ${activeStickyModel} to ${newChoice} (confidence: ${conf} >= ${switchThreshold})`);
            if (sessionId) {
              setStickyComboModel(comboName, sessionId, newChoice);
              activeStickyModel = newChoice;
            }
          } else {
            // Stay on current model to preserve warm prompt cache
            rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
            log.info("COMBO", `smart-router [smart-switch] retained prompt cache model "${activeStickyModel}"`);
          }
        } catch (err) {
          // Fail open to active sticky model
          rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
          log.warn("COMBO", `smart-router error, retained model "${activeStickyModel}"`, { error: err?.message || String(err) });
        }
      } else {
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
      }
    } else if (typeof resolveSmartChoice === "function") {
      // Turn 1 or per-turn: evaluate System One to select initial model
      try {
        const smartResult = await resolveSmartChoice(body, models);
        const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

        if (smartResult?.choice && models.includes(smartResult.choice)) {
          if (switchThreshold > 0 && conf !== null && conf < switchThreshold) {
            log.info("COMBO", `smart-router confidence (${conf}) below threshold (${switchThreshold}), fallback to order: [${models.join(", ")}]`);
          } else {
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router selected ${smartResult.choice} (confidence: ${conf ?? "N/A"})`);
            if (!isPerTurn && sessionId) {
              setStickyComboModel(comboName, sessionId, smartResult.choice);
              activeStickyModel = smartResult.choice;
            }
          }
        } else {
          log.info("COMBO", `smart-router no decision, fallback to order: [${models.join(", ")}]`);
        }
      } catch (err) {
        log.warn("COMBO", `smart-router error, fallback to order: [${models.join(", ")}]`, { error: err?.message || String(err) });
      }
    }
  } else {
    // Apply rotation strategy if enabled
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
    // Strategy-registry orderers (strict-random, weighted, p2c, lkgp, cost-/
    // context-/cache-optimized, shadow-cache, quota family, latency-arbitrage).
    // Random/round-robin/fallback are rotation strategies already applied above;
    // orderSeats passes them through untouched.
    rotatedModels = orderSeats(rotatedModels, comboStrategy, {
      comboName,
      body,
      weights,
    });
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  let requestScopedResult = null;
  // Quota is the constraint that decides everything here. Advancing to another
  // member re-sends the whole prompt, so it is only ever worth doing when the
  // current member is provably dead — a stream that has not delivered a single
  // frame in seatSilenceMs. A member that IS delivering (thinking deltas, SSE
  // keepalives) is left alone for the full stall budget: cutting a live generation
  // would burn the prompt twice and buy nothing.
  // Cuts are also capped per turn. Without a cap, a walk across a pool of quiet
  // lanes would pay for the prompt once per member, which is the quota burn this
  // whole rule exists to avoid. After the cap the next member is committed to.
  let silenceCuts = 0;
  const MAX_SILENCE_CUTS = 2;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(body, modelStr);
      
      // Success (2xx). A 2xx is necessary but NOT sufficient: Gemini aborts (e.g.
      // MALFORMED_FUNCTION_CALL) still return 200 and stream empty content, which would
      // otherwise be delivered as a successful empty answer with no failover.
      // Peek the stream for real content before committing to this candidate.
      if (result.ok) {
        let peeked = null;
        try {
          peeked = await peekComboResponse(result, log, seatSilenceMs);
        } catch (peekErr) {
          // peekStreamForContent is written not to throw; if reconstruction/Response
          // construction ever does, result.body is already locked by getReader() and can no
          // longer be streamed. Returning `result` would hand the client a locked, unreadable
          // body. Degrade to a clean, valid (empty) SSE stream instead.
          log.warn("COMBO", `empty-peek error on ${modelStr}, returning empty SSE: ${peekErr?.message || peekErr}`);
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        if (!peeked) {
          // Non-streaming (or non-SSE) response — not this peek's job. The zero-content
          // JSON check still applies on a non-final seat.
          const isLastModel = i === rotatedModels.length - 1;
          if (!isLastModel) {
            const contentType = result.headers?.get?.("content-type") || "";
            if (contentType.includes("application/json")) {
              try {
                const peekBody = await result.clone().json();
                if (isZeroContentResponse(peekBody)) {
                  log.warn("COMBO", `Model ${modelStr} returned HTTP 200 with zero usable content, falling back to next model`);
                  if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
                    clearStickyComboSession(comboName, sessionId);
                  }
                  lastError = "Zero usable content";
                  lastStatus = 200;
                  continue;
                }
              } catch {
                // Ignore JSON parse errors
              }
            }
          }

          log.info("COMBO", `Model ${modelStr} succeeded`);
          recordComboOutcome(modelStr, { comboName }, { ok: true, status: result.status });
          return result;
        }

        if (peeked.outcome === "content") {
          // "content" on a peek that hit its deadline only means "the window ended".
          // A seat that has produced a real frame is generating — waiting costs
          // nothing extra and cutting it would pay for the prompt twice AND truncate
          // an answer the client is already reading. A seat that sent not even a
          // keepalive comment inside seatSilenceMs is queued or dead: nothing has
          // reached the client, so closing it loses no output and is strictly
          // cheaper than holding the turn open for it.
          if (peeked.timedOut && !peeked.sawFrame && silenceCuts < MAX_SILENCE_CUTS && i < rotatedModels.length - 1) {
            const silenceSec = Math.round(seatSilenceMs / 1000);
            silenceCuts += 1;
            log.warn("COMBO", `Model ${modelStr} produced no frame in ${silenceSec}s (queued/dead) — cut ${silenceCuts}/${MAX_SILENCE_CUTS}, trying the next member`);
            recordComboOutcome(modelStr, { comboName }, { ok: false, status: 504, errorKind: "silence-cut" });
            peeked.response.body?.cancel?.().catch(() => {});
            lastError = `no response frame in ${silenceSec}s`;
            if (!lastStatus) lastStatus = 504;
            if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
              clearStickyComboSession(comboName, sessionId);
            }
            continue;
          }
          // Committed. From here the answer belongs to the client: the remaining
          // budget is the caller's 7200s, and no further member is ever asked.
          log.info("COMBO", `Model ${modelStr} succeeded${peeked.timedOut ? " (peek deadline; generating, waiting it out)" : ""}`);
          recordComboOutcome(modelStr, { comboName }, { ok: true, status: peeked.response.status });
          return peeked.response;
        }

        // Empty generation. Fall through to the next candidate unless this is a legitimately
        // empty class (content filter) or the last candidate — in which case return the
        // (empty) response as-is, preserving prior behaviour rather than manufacturing a 5xx.
        const reasonLabel = peeked.finishReason || "no-content";
        const isLast = i === rotatedModels.length - 1;
        if (isNoRetryFinish(peeked.finishReason) || isLast) {
          log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — ${isNoRetryFinish(peeked.finishReason) ? "no-retry class" : "last candidate"}, returning as-is`);
          return peeked.response;
        }

        log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — falling through to next candidate`);
        if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
          clearStickyComboSession(comboName, sessionId);
        }
        // Drain/close the discarded stream in the background so its usage logging still runs.
        peeked.response.body?.cancel?.().catch(() => {});
        lastError = `empty generation (${reasonLabel})`;
        if (!lastStatus) lastStatus = 502;
        continue;
      }

      // If the model that failed was the session-sticky model, clear it so next turns re-evaluate
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { provider } = parseModel(modelStr);
      const { shouldFallback, cooldownMs, requestScoped } = checkFallbackError(result.status, errorText, 0, provider);
      recordComboOutcome(modelStr, { comboName }, { ok: false, status: result.status, errorKind: shouldFallback ? "fallback" : "no-fallback" });

      if (!shouldFallback && !requestScoped) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // A request-scoped 4xx (validation failure, unsupported parameter, context
      // overflow) says this member cannot serve THIS request — not that the
      // credential is unhealthy. Members run on different providers with
      // different validation, so the next member may well serve it. Advance
      // without a cooldown, and without waiting: there is nothing to recover.
      // checkFallbackError() reports no account fallback here on purpose (a
      // request-scoped fault must not evict a healthy account from rotation).
      if (requestScoped) {
        log.warn("COMBO", `Model ${modelStr} rejected the request (${result.status}), trying next`, { status: result.status });
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = result.status;
        if (!requestScopedResult) requestScopedResult = result;
        continue;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // At least one member rejected the request itself. Hand back that member's own
  // response — status and body — rather than the synthesized envelope below: the
  // synthesized one reaches the client as a 200 carrying an error object, which
  // reads as an empty success, and it buries the member that named the real cause.
  // This is also what the caller saw before combos advanced on these errors.
  if (requestScopedResult) {
    log.warn("COMBO", `No model served the request; returning the first request-scoped failure (${requestScopedResult.status})`);
    return requestScopedResult;
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

// The router's own "no provider" notice is an HTTP 200 with prose. It is not
// a model answer; treating it as a draft poisons the panel and the judge.
const ROUTER_UNAVAILABLE = /could not reach any provider|send it again and it will be routed|no available provider|all providers failed|provider is temporarily unavailable/i;
function isUnavailableText(text) {
  return ROUTER_UNAVAILABLE.test(String(text || ""));
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}

/**
 * Pipeline combo strategy: runs the seats in sequence, feeding each step's
 * output into the next. Step N's answer is appended to the conversation as a
 * "draft" turn; the final seat produces the answer the client sees (streamed,
 * tools intact). Intermediate steps run non-streaming with tools stripped —
 * they are drafting stages, not tool-runners. If a step fails or returns
 * nothing, the chain skips it: a pipeline that loses a stage still answers,
 * it just has one fewer draft.
 *
 * @param {Object} options - Same shape as handleFusionChat
 * @param {string[]} [options.steps] - Optional per-step prompt hints (comboStrategies[name].pipelineSteps)
 * @returns {Promise<Response>}
 */
export async function handlePipelineChat({ body, models, handleSingleModel, log, comboName, steps }) {
  const chain = Array.isArray(models) ? models.filter(Boolean) : [];
  if (chain.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Pipeline combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (chain.length === 1) {
    return handleSingleModel(body, chain[0]);
  }

  log.info("PIPELINE", `Combo "${comboName}" | chain=${chain.length} [${chain.join(" → ")}]`);

  // Intermediate drafting body: non-streaming, tools stripped, tool history
  // flattened to prose (the same discipline the fusion panel gets).
  const { tools, tool_choice, stream_options, ...rest } = body;
  const draftBody = { ...rest, stream: false };
  if (Array.isArray(draftBody.messages)) {
    draftBody.messages = flattenToolHistory(draftBody.messages);
  } else if (Array.isArray(draftBody.input)) {
    draftBody.input = flattenToolHistory(draftBody.input);
  }

  const drafts = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const model = chain[i];
    const stepHint = Array.isArray(steps) && steps[i] ? String(steps[i]) : "";
    const stepBody = JSON.parse(JSON.stringify(draftBody));
    if (stepHint) {
      stepBody.messages = [
        ...(stepBody.messages || []),
        { role: "user", content: `[Pipeline stage ${i + 1} focus] ${stepHint}` },
      ];
    }
    try {
      const res = await handleSingleModel(stepBody, model, true);
      if (!res || !res.ok) {
        log.warn("PIPELINE", `Stage ${i + 1} (${model}) failed — skipping`, { status: res?.status });
        continue;
      }
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        drafts.push({ model, text });
        log.info("PIPELINE", `Stage ${i + 1} (${model}) ok (${text.length} chars)`);
      } else {
        log.warn("PIPELINE", `Stage ${i + 1} (${model}) returned no content — skipping`);
      }
    } catch (err) {
      log.warn("PIPELINE", `Stage ${i + 1} (${model}) threw — skipping`, { error: err?.message || String(err) });
    }
  }

  if (drafts.length === 0) {
    // No drafts survived: a degenerate pipeline is just a fallback walk on the
    // final seat, which is the safest degradation.
    log.warn("PIPELINE", "No stage produced a draft — answering directly on the final seat");
    return handleSingleModel(body, chain[chain.length - 1]);
  }

  // Final seat: original body (streaming, tools), plus the draft thread so the
  // last model can synthesize instead of starting cold.
  const finalModel = chain[chain.length - 1];
  const finalBody = appendUserTurn(body, buildPipelinePrompt(drafts));
  log.info("PIPELINE", `Final answer from ${finalModel} with ${drafts.length} draft(s)`);
  return handleSingleModel(finalBody, finalModel);
}

/* ══════════════════════════════ HydraFusion ════════════════════════════════
 *
 * HydraFusion is Fusion's successor. Fusion had one shape: fan out, judge. The
 * Hydra ladder adds six effort tiers and three explicit orchestration shapes
 * (Single / Cascade / Critique), so the same combo can answer a lookup in one
 * cheap call or spend a few auditors on a long-horizon engineering task.
 *
 * The judge call is always the last call and always keeps the client's stream
 * flag + tools, exactly like Fusion, so streaming and tool use still work.
 * Intermediate calls are non-streaming, tools-stripped prose calls.
 */

/** Last user turn as plain text, across the request formats clients send. */
function lastUserText(body) {
  const list = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : Array.isArray(body?.contents)
        ? body.contents
        : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (msg?.role !== "user") continue;
    const content = msg.content ?? msg.parts;
    const text = extractTextContent(content);
    if (text.trim()) return text.trim();
  }
  return "";
}

/** First user turn: the stable anchor for a conversation without a session id. */
function firstUserText(body) {
  const list = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : Array.isArray(body?.contents)
        ? body.contents
        : [];
  for (let i = 0; i < list.length; i += 1) {
    const msg = list[i];
    if (msg?.role !== "user") continue;
    const content = msg.content ?? msg.parts;
    const text = extractTextContent(content);
    if (text.trim()) return text.trim();
  }
  return "";
}

/** Clone the body with the tier's reasoning budget attached. */
function withHydraEffort(body, tier) {
  return { ...body, reasoning_effort: tier.reasoningEffort };
}

/**
 * One panel/stage call with a fail-open effort retry. A provider that does not
 * know `reasoning_effort` (or rejects a tier it does not have) gets one retry
 * without the field instead of losing the seat.
 */
async function hydraSeatCall({ handleSingleModel, body, model, log, tag }) {
  try {
    const first = await handleSingleModel(body, model, true);
    if (!first) return { __error: new Error("empty response") };
    if (first.ok || !body.reasoning_effort) return first;
    let detail = "";
    try { detail = await first.clone().text(); } catch { /* ignore */ }
    if (first.status === 400 || first.status === 422 || /reason|effort|thinking|invalid/i.test(detail)) {
      const retry = { ...body };
      delete retry.reasoning_effort;
      log.warn(tag, `${model} rejected effort "${body.reasoning_effort}" — retrying without it`);
      return await handleSingleModel(retry, model, true);
    }
    return first;
  } catch (error) {
    return { __error: error };
  }
}

/** Fan out, then collect usable prose. Sparse results are expected by design. */
async function hydraPanelAnswers({ seats, body, handleSingleModel, log, tag, tier, minPanel = 2, timeoutMs = null }) {
  const budget = Math.max(5000, Number(timeoutMs) || tier.hardTimeoutMs);
  const calls = seats.map((model) =>
    withTimeout(
      hydraSeatCall({ handleSingleModel, body, model, log, tag }),
      budget,
    ),
  );
  const settled = await collectPanel(calls, {
    minPanel: Math.min(Math.max(1, minPanel), Math.max(1, seats.length)),
    stragglerGraceMs: Math.max(1, Math.min(tier.graceMs || 1, Math.floor(budget / 3))),
    panelHardTimeoutMs: budget,
  });
  const answers = [];
  for (let i = 0; i < settled.length; i += 1) {
    const res = settled[i];
    const model = seats[i];
    if (!res) { markSeatFailure(model, "dropped"); log.warn(tag, `${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { markSeatFailure(model, "timeout"); log.warn(tag, `${model} timed out`); continue; }
    if (res.__error) { markSeatFailure(model, "error"); log.warn(tag, `${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { markSeatFailure(model, `status ${res.status}`); log.warn(tag, `${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (isUnavailableText(text)) {
        markSeatFailure(model, "provider unavailable", 300000);
        log.warn(tag, `${model} returned the router's no-provider notice`);
      } else if (text.trim()) {
        answers.push({ model, text: text.trim().slice(0, 8000) });
        markSeatSuccess(model);
      } else {
        markSeatFailure(model, "empty");
        log.warn(tag, `${model} returned empty content`);
      }
    } catch (error) {
      markSeatFailure(model, "unparseable");
      log.warn(tag, `${model} unparseable`, { error: error?.message || String(error) });
    }
  }
  return answers;
}

function buildHydraCritiquePrompt(answers) {
  const sources = answers.map((answer, i) => `[Draft ${i + 1}]\n${answer.text}`).join("\n\n");
  return [
    "You are the AUDITOR in a quality-controlled answer pipeline. The user's request is above.",
    `${answers.length} anonymous draft answers are below. Audit them against the request.`,
    "",
    "Find, in priority order: factual errors, missed constraints, invalid assumptions, incomplete cases, contradictions between drafts, and reasoning that only looks correct. For each finding, quote the failing claim and state the correction. Do not rewrite the answer and do not praise.",
    "Return at most 8 numbered findings, most severe first. If the drafts have no material problems, return exactly: NO MATERIAL FINDINGS.",
    "",
    "=== DRAFTS ===",
    sources,
    "=== END DRAFTS ===",
  ].join("\n");
}

function buildHydraFinalPrompt({ answers = [], drafts = [], critiques = [], pattern, tier }) {
  const blocks = [];
  if (answers.length > 0) {
    blocks.push(
      "=== PANEL ANSWERS ===",
      answers.map((answer, i) => `[Source ${i + 1}]\n${answer.text}`).join("\n\n"),
      "=== END PANEL ANSWERS ===",
    );
  }
  if (drafts.length > 0) {
    blocks.push(
      "=== DRAFTS ===",
      drafts.map((draft, i) => `[Draft ${i + 1} from stage ${i + 1}]\n${draft.text}`).join("\n\n"),
      "=== END DRAFTS ===",
    );
  }
  if (critiques.length > 0) {
    blocks.push(
      "=== AUDITOR FINDINGS ===",
      critiques.map((critique, i) => `[Audit ${i + 1}]\n${critique.text}`).join("\n\n"),
      "=== END AUDITOR FINDINGS ===",
    );
  }

  const shapeLine = pattern === "cascade"
    ? "Earlier stages produced the drafts below, in order. Each stage improved the previous one."
    : "A panel of experts answered independently; auditors then attacked those answers.";

  return [
    `You are the final JUDGE in a ${tier.id}-effort HydraFusion run. ${shapeLine}`,
    "",
    "Write ONE authoritative final answer addressed directly to the user.",
    "Resolve every valid auditor finding, keep points the sources agree on, correct contradictions with your own reasoning, preserve unique insights that survive scrutiny, and cover blind spots the drafts missed. Do not mention the panel, the drafts, the auditors, or this process.",
    "Be complete but not padded. If the request asks for code, give the code; if it asks for a number, give the number.",
    "",
    ...blocks,
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

function buildHydraDraftPrompt(drafts, stageIndex) {
  if (drafts.length === 0) {
    return "Produce the strongest possible first draft for the user's request. Be complete; later stages will audit and correct it.";
  }
  return [
    `You are refinement stage ${stageIndex + 1}. Improve the draft below.`,
    "Fix errors, fill missing cases, tighten weak reasoning, and keep everything that was already correct. Return the complete improved answer, not a diff.",
    "",
    ...drafts.map((draft, i) => `--- Draft ${i + 1} ---\n${draft.text}`),
  ].join("\n");
}

async function hydraAuditAnswers({ answers, critics, body, handleSingleModel, log, tag, tier, timeoutMs = null }) {
  if (critics.length === 0 || answers.length === 0) return [];
  const budget = Math.max(5000, Number(timeoutMs) || tier.hardTimeoutMs);
  const prompt = buildHydraCritiquePrompt(answers);
  const auditBody = appendUserTurn(body, prompt);
  const calls = critics.map((model) =>
    withTimeout(
      hydraSeatCall({ handleSingleModel, body: auditBody, model, log, tag }),
      budget,
    ),
  );
  const settled = await collectPanel(calls, {
    minPanel: 1,
    stragglerGraceMs: Math.max(1, Math.min(tier.graceMs || 1, Math.floor(budget / 3))),
    panelHardTimeoutMs: budget,
  });
  const critiques = [];
  for (let i = 0; i < settled.length; i += 1) {
    const res = settled[i];
    const model = critics[i];
    if (!res || res.__timeout || res.__error || !res.ok) {
      markSeatFailure(model, res?.__timeout ? "audit timeout" : "audit failure");
      log.warn(tag, `Auditor ${model} unavailable`);
      continue;
    }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (isUnavailableText(text)) {
        markSeatFailure(model, "auditor unavailable", 300000);
        log.warn(tag, `Auditor ${model} returned the router's no-provider notice`);
      } else if (text.trim()) {
        critiques.push({ model, text: text.trim().slice(0, 8000) });
        markSeatSuccess(model);
      } else {
        markSeatFailure(model, "audit empty");
      }
    } catch (error) {
      markSeatFailure(model, "audit unparseable");
      log.warn(tag, `Auditor ${model} unparseable`, { error: error?.message || String(error) });
    }
  }
  return critiques;
}

async function hydraDirectAnswer({ body, seats, handleSingleModel, log, tag, tier, timeoutMs = null }) {
  const budget = Math.max(5000, Number(timeoutMs) || tier.hardTimeoutMs);
  const deadline = Date.now() + budget;
  let last = null;
  for (const model of seats) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    const res = await withTimeout(
      hydraSeatCall({ handleSingleModel, body: withHydraEffort(body, tier), model, log, tag }),
      Math.min(60000, left),
    );
    if (res && res.ok) {
      // A 200 with the router's no-provider notice is not an answer.
      if (body?.stream !== true) {
        try {
          const json = await res.clone().json();
          if (isUnavailableText(extractPanelText(json))) {
            markSeatFailure(model, "provider unavailable", 300000);
            last = res;
            continue;
          }
        } catch {
          /* non-JSON responses are left alone */
        }
      }
      markSeatSuccess(model);
      return res;
    }
    markSeatFailure(model, res?.__timeout ? "direct timeout" : "direct failure");
    last = res;
  }
  if (last && !last.__error && !last.__timeout) return last;
  log.warn(tag, "No seat answered");
  return new Response(
    JSON.stringify({ error: { message: "All HydraFusion seats failed" } }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

/** Last-resort answer when the judge cannot answer before the deadline. */
function bestHydraFallback({ answers = [], drafts = [] }) {
  const pool = [...drafts, ...answers].filter((entry) => entry?.text?.trim());
  if (pool.length === 0) return "";
  // A draft that already carries a final marker is safer than a long musing.
  const marked = pool.filter((entry) => /FINAL:|answer\s+is|\\boxed\{/i.test(entry.text));
  const chosen = (marked.length > 0 ? marked : pool).sort((a, b) => b.text.length - a.text.length)[0];
  return chosen.text.trim().slice(0, 12000);
}

/**
 * Build an Anthropic Messages response (JSON or SSE) from plain text.
 * The wire format is the endpoint's, not the judge's: a /v1/messages caller
 * rejects `chat.completion` shapes, so the fallback must speak Messages.
 */
function hydraClaudeResponse(text, body) {
  const model = body?.model || "hydrafusion";
  const id = `msg_hydra_${Date.now()}`;
  const outputTokens = Math.max(1, Math.ceil(String(text).length / 4));
  if (body?.stream) {
    const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const events = [
      frame("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
  return new Response(
    JSON.stringify({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: outputTokens },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a response (JSON or SSE) in the client's wire format from plain text. */
function hydraTextResponse(text, body, format = null) {
  if (format === "claude") return hydraClaudeResponse(text, body);
  const model = body?.model || "hydrafusion";
  const id = `chatcmpl-hydra-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (body?.stream) {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    };
    const stop = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(stop)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Stable, tiny hash for the conductor cache. */
function hashText(text) {
  let hash = 2166136261;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Cheap first-pass classifier; always available, even when every seat is slow. */
function hydraHeuristicCategory(text, body) {
  const lower = String(text || "").toLowerCase();
  const scores = { code: 0, math: 0, science: 0, knowledge: 0, writing: 0, agentic: 0, general: 1 };
  const add = (category, weight) => {
    scores[category] += weight;
  };
  if (/```|function\s|class\s|def\s|import\s|const\s|let\s|bug|stack trace|exception|compile|api|sql|python|javascript|typescript|react|docker|git\s|unit test/.test(lower)) add("code", 3);
  if (/solve|equation|integral|derivative|probability|modulo|prime|matrix|geometry|polynomial|combinator|proof|integer|math/.test(lower)) add("math", 3);
  if (/physics|chemistry|biology|quantum|molecule|protein|thermodynamic|experiment|dna|cell|energy level/.test(lower)) add("science", 3);
  if (/history|law|economics|business|politics|philosophy|compare|explain|what is|why does/.test(lower)) add("knowledge", 2);
  if (/write|draft|email|essay|blog|story|summarize|rewrite|tone|copy/.test(lower)) add("writing", 3);
  if ((Array.isArray(body?.tools) && body.tools.length > 0) || /terminal|bash|shell|command|filesystem|repository|repo|install|build|execute/.test(lower)) add("agentic", 3);
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

const conductorCache = new Map();
const CONDUCTOR_TTL_MS = 10 * 60 * 1000;

/**
 * Per-request model-selection judge.
 *
 * A fast pool seat reads the request, classifies it, and the family ranker
 * turns that into a diverse, best-fit panel. The call is cached and capped at
 * 8s; if the conductor itself is unavailable the heuristic keeps routing
 * deterministic instead of failing the request.
 */
async function conductHydraCategory({ body, models, handleSingleModel, log, tag }) {
  const text = lastUserText(body);
  const heuristic = hydraHeuristicCategory(text, body);
  if (!text.trim()) return heuristic;
  const key = hashText(text.slice(0, 4000));
  const cached = conductorCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.category;

  const preferred = [
    "or/deepseek/deepseek-v4.1-flash-1017",
    "or/deepseek/deepseek-chat",
    "or/~deepseek/deepseek-flash-latest",
    "or/deepseek/deepseek-v4-pro",
  ];
  const conductorModel = preferred.find((model) => models.includes(model)) || models[0];
  if (!conductorModel) return heuristic;

  const prompt = [
    "You are the conductor for a multi-model answering panel.",
    "Classify the user's request into exactly one category:",
    HYDRAFUSION_CATEGORIES.join(", ") + ".",
    'Return only JSON: {"category":"<category>"}.',
    "code=programming/debugging; math=competition or symbolic math; science=physics/chemistry/biology; knowledge=history/law/economics/explanation; writing=copy/essays/summaries; agentic=terminal/files/tools/multi-step execution; general=everything else.",
    "",
    "USER REQUEST:",
    text.slice(0, 4000),
  ].join("\n");

  try {
    const res = await withTimeout(
      handleSingleModel(
        {
          model: conductorModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          stream: false,
          max_tokens: 80,
        },
        conductorModel,
        true,
      ),
      8000,
    );
    if (!res || res.__timeout || res.__error || !res.ok) throw new Error("conductor unavailable");
    const json = await res.clone().json();
    const raw = extractPanelText(json);
    const match = raw.match(/"category"\s*:\s*"([a-z]+)"/i) || raw.match(/\b(code|math|science|knowledge|writing|agentic|general)\b/i);
    const category = match ? match[1].toLowerCase() : heuristic;
    const valid = HYDRAFUSION_CATEGORIES.includes(category) ? category : heuristic;
    conductorCache.set(key, { category: valid, expires: Date.now() + CONDUCTOR_TTL_MS });
    if (conductorCache.size > 500) {
      for (const [cacheKey, entry] of conductorCache) {
        if (entry.expires <= Date.now()) conductorCache.delete(cacheKey);
      }
    }
    log.info(tag, `conductor classified request as ${valid} (${conductorModel})`);
    return valid;
  } catch (error) {
    log.warn(tag, `conductor unavailable — heuristic=${heuristic}`, {
      error: error?.message || String(error),
    });
    conductorCache.set(key, { category: heuristic, expires: Date.now() + 60000 });
    return heuristic;
  }
}

/**
 * HydraFusion combo entry point.
 *
 * @param {Object} options
 * @param {Object} options.body - Client request body
 * @param {string[]} options.models - Combo members
 * @param {Function} options.handleSingleModel - (body, model, isPanel) => Promise<Response>
 * @param {Object} options.log
 * @param {string} [options.comboName]
 * @param {string} [options.judgeModel]
 * @param {string} [options.effort] - minimal|light|low|medium|high|xhigh|max|ultra
 * @param {string} [options.pattern] - auto|single|cascade|critique
 * @param {Object} [options.tuning] - Per-combo overrides ({ effort, pattern })
 * @param {string|null} [options.sessionId]
 * @param {string|null} [options.seed] - Override the seat-rotation seed (tests)
 * @returns {Promise<Response>}
 */
export async function handleHydraFusionChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  judgeModel,
  effort,
  pattern,
  tuning,
  sessionId = null,
  seed = null,
  category: categoryOverride = null,
  format = null,
}) {
  const requestedEffort = effort || tuning?.effort || HYDRAFUSION_DEFAULT_EFFORT;
  const requestedPattern = pattern || tuning?.pattern || HYDRAFUSION_DEFAULT_PATTERN;
  const tag = "HYDRA";
  const userText = lastUserText(body);
  const anchorText = firstUserText(body);
  // Seat health gate: a seat that just timed out stays out of the next panel
  // until its cooldown expires. The full pool is still used whenever the
  // healthy subset is too small to orchestrate.
  const pool = Array.isArray(models) ? models : [];
  const healthy = pool.filter((model) => isSeatHealthy(model));
  const modelPool = healthy.length >= Math.min(4, pool.length) ? healthy : pool;
  const healthyJudge = judgeModel && isSeatHealthy(judgeModel) ? judgeModel : "";
  const seedText = seed ?? (sessionId ? `${sessionId}:${userText}` : `${anchorText}:${userText}`);

  // Per-request conductor: classify the request, then rank the pool so each
  // family contributes one seat before any family contributes a second alias.
  // The conductor is capped and falls back to the heuristic classifier.
  //
  // A tool-bearing request is classified locally: an extra probe call before
  // every agent turn buys nothing (the tools already say "agentic") and costs
  // seconds on a pool where probes often fail first.
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const category =
    categoryOverride && HYDRAFUSION_CATEGORIES.includes(categoryOverride)
      ? categoryOverride
      : hasTools
        ? hydraHeuristicCategory(userText, body)
        : await conductHydraCategory({ body, models: modelPool, handleSingleModel, log, tag });
  const rankedPool = rankHydraSeats(modelPool, category, seedText);
  // A client that sends tools is an agent loop: every turn must end in a real
  // tool call from one model. Panels and audits only produce prose, so for
  // tool-bearing or agentic requests the run collapses to the best-ranked seat
  // with the client's tools and stream untouched. Debate cannot replace the
  // actor in an agent loop, and pretending otherwise would silently break it.
  const agentic = hasTools || category === "agentic";
  const plan = planHydraRun({
    models: rankedPool,
    // The dedicated judge is a prose synthesizer, not the actor; agentic turns
    // go to the best-fit pool seat instead.
    judgeModel: agentic ? "" : healthyJudge,
    effort: requestedEffort,
    pattern: agentic ? "single" : requestedPattern,
    // Seat order is already the conductor's ranking; planHydraRun must not
    // rotate it away again.
    seed: seedText,
    preserveOrder: true,
  });

  if (plan.seats.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "HydraFusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const tier = plan.effort;
  const runBudgetMs = tier.runBudgetMs || tier.hardTimeoutMs;
  const deadline = Date.now() + runBudgetMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const previous = loadHydraState({ comboName, sessionId, userText, anchorText });
  // Reasoning-state preservation: the compact block goes everywhere the run
  // reasons (panel, drafts, auditors, final judge), never into the client's
  // visible transcript.
  const stateBody = injectHydraState(body, previous);

  log.info(
    tag,
    `Combo "${comboName}" | effort=${tier.id} | category=${category} | pattern=${plan.pattern} | panel=${plan.panel.length} | stages=${plan.stages.length} | critics=${plan.critics.length} | judge=${plan.judge} | budget=${runBudgetMs}ms | healthy=${healthy.length}/${pool.length}${agentic ? " | agentic=direct" : ""}`,
  );

  // Nothing to orchestrate: one seat, one pass, tools and stream intact.
  if (plan.seats.length === 1 || plan.pattern === "single") {
    const seats = [plan.judge, ...plan.seats.filter((m) => m !== plan.judge)];
    const res = await hydraDirectAnswer({ body: stateBody, seats, handleSingleModel, log, tag, tier, timeoutMs: runBudgetMs });
    saveHydraState({
      comboName,
      sessionId,
      userText,
      anchorText,
      effort: tier.id,
      pattern: plan.pattern,
      previous,
      relay: { lastDraft: "", critique: "", panel: [] },
    });
    return res;
  }

  // Intermediate calls never stream and never carry tools; they are prose.
  const { tools, tool_choice, stream_options, ...rest } = withHydraEffort(stateBody, tier);
  const workBody = { ...rest, stream: false };
  if (Array.isArray(workBody.messages)) {
    workBody.messages = flattenToolHistory(workBody.messages);
  } else if (Array.isArray(workBody.input)) {
    workBody.input = flattenToolHistory(workBody.input);
  }

  let answers = [];
  let drafts = [];
  let critiques = [];

  try {
    if (plan.pattern === "critique") {
      const panelMs = Math.max(10000, Math.min(tier.hardTimeoutMs, Math.floor(remaining() * 0.62)));
      answers = await hydraPanelAnswers({
        seats: plan.panel,
        body: workBody,
        handleSingleModel,
        log,
        tag,
        tier,
        minPanel: Math.min(2, plan.panel.length),
        timeoutMs: panelMs,
      });
      log.info(tag, `panel produced ${answers.length}/${plan.panel.length} answers (${panelMs}ms budget)`);
      if (answers.length > 0 && remaining() > 12000) {
        const auditMs = Math.max(8000, Math.min(tier.hardTimeoutMs, Math.floor(remaining() * 0.55)));
        critiques = await hydraAuditAnswers({
          answers,
          critics: plan.critics,
          body: workBody,
          handleSingleModel,
          log,
          tag,
          tier,
          timeoutMs: auditMs,
        });
        log.info(tag, `${critiques.length} audit(s) collected (${auditMs}ms budget)`);
      }
    } else {
      // Cascade: each stage sees the previous stage's complete draft.
      for (let i = 0; i < plan.stages.length; i += 1) {
        const left = remaining();
        if (left < 6000) {
          log.warn(tag, `cascade stopped at stage ${i + 1} — run budget exhausted`);
          break;
        }
        const model = plan.stages[i];
        const stagesLeft = Math.max(1, plan.stages.length - i);
        const reserve = Math.min(30000, Math.max(8000, Math.floor(runBudgetMs * 0.25)));
        const stageMs = Math.max(6000, Math.min(60000, Math.floor(Math.max(0, left - reserve) / stagesLeft)));
        const stageBody = appendUserTurn(workBody, buildHydraDraftPrompt(drafts, i));
        const res = await withTimeout(
          hydraSeatCall({ handleSingleModel, body: stageBody, model, log, tag }),
          stageMs,
        );
        if (!res || res.__timeout || res.__error || !res.ok) {
          markSeatFailure(model, res?.__timeout ? "stage timeout" : "stage failure");
          log.warn(tag, `stage ${i + 1} (${model}) failed — skipping`);
          continue;
        }
        try {
          const json = await res.clone().json();
          const text = extractPanelText(json);
          if (isUnavailableText(text)) {
            markSeatFailure(model, "provider unavailable", 300000);
            log.warn(tag, `stage ${i + 1} (${model}) returned the no-provider notice`);
          } else if (text.trim()) {
            drafts.push({ model, text: text.trim().slice(0, 8000) });
            markSeatSuccess(model);
            log.info(tag, `stage ${i + 1} (${model}) ok (${text.length} chars)`);
          } else {
            markSeatFailure(model, "stage empty");
          }
        } catch (error) {
          markSeatFailure(model, "stage unparseable");
          log.warn(tag, `stage ${i + 1} (${model}) unparseable`, { error: error?.message || String(error) });
        }
      }
      if (drafts.length > 0 && remaining() > 10000) {
        const auditMs = Math.max(8000, Math.min(tier.hardTimeoutMs, Math.floor(remaining() * 0.5)));
        critiques = await hydraAuditAnswers({
          answers: drafts,
          critics: plan.critics,
          body: workBody,
          handleSingleModel,
          log,
          tag,
          tier,
          timeoutMs: auditMs,
        });
      }
    }
  } catch (error) {
    // Any orchestration surprise drops to a direct answer; a combo must never
    // fail because its quality stage did.
    log.warn(tag, "Orchestration failed — falling back to a direct judge call", {
      error: error?.message || String(error),
    });
  }

  const relay = {
    lastDraft: drafts.at(-1)?.text || answers[0]?.text || "",
    critique: critiques.map((c) => c.text).join("\n\n"),
    panel: answers.length > 0 ? answers : drafts,
  };

  // The final judge always streams and keeps tools. If it cannot answer at all,
  // fall back to a cold direct call so the client still gets a usable response.
  const finalPrompt = buildHydraFinalPrompt({
    answers,
    drafts,
    critiques,
    pattern: plan.pattern,
    tier,
  });
  const finalBody = appendUserTurn(withHydraEffort(stateBody, tier), finalPrompt);
  const judgeMs = Math.max(5000, Math.min(90000, remaining()));
  let finalRes = await withTimeout(
    hydraSeatCall({ handleSingleModel, body: finalBody, model: plan.judge, log, tag }),
    judgeMs,
  );

  // A streaming judge cannot be inspected without consuming the stream; a
  // non-streaming judge is checked so the router's no-provider notice never
  // reaches the client as if it were a model answer.
  if (finalRes && finalRes.ok && body?.stream !== true) {
    try {
      const json = await finalRes.clone().json();
      if (isUnavailableText(extractPanelText(json))) {
        markSeatFailure(plan.judge, "judge unavailable", 300000);
        finalRes = { __error: new Error("judge unavailable") };
      }
    } catch {
      /* leave non-JSON responses alone */
    }
  }

  let fallbackText = "";
  if (!finalRes || finalRes.__error || finalRes.__timeout || !finalRes.ok) {
    if (finalRes?.__timeout) markSeatFailure(plan.judge, "judge timeout", 120000);
    fallbackText = bestHydraFallback({ answers, drafts });
    if (!fallbackText) {
      log.warn(tag, "Final judge failed — using a cold direct answer");
      finalRes = await hydraDirectAnswer({
        body: stateBody,
        seats: [plan.judge, ...plan.seats.filter((m) => m !== plan.judge)],
        handleSingleModel,
        log,
        tag,
        tier,
        timeoutMs: Math.max(10000, remaining()),
      });
    } else {
      log.warn(tag, "Final judge failed — returning the strongest draft");
    }
  }

  saveHydraState({
    comboName,
    sessionId,
    userText,
    anchorText,
    effort: tier.id,
    pattern: plan.pattern,
    previous,
    relay,
  });

  if (fallbackText) return hydraTextResponse(fallbackText, body, format);
  return finalRes;
}

export {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";
