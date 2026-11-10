import { PROVIDER_MODELS } from "@/shared/constants/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { extractApiKey, isValidApiKey } from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleChat } from "./chat.js";
import { handleCompletions } from "./derived/textIntelligence.js";
import { handleEmbeddings } from "./embeddings.js";
import { handleImageGeneration } from "./imageGeneration.js";
import { handleTts } from "./tts.js";
import { handleStt } from "./stt.js";

// Provider-scoped routes: the same gateway endpoints with the provider fixed by
// the path. `/v1/providers/{provider}/chat/completions` routes exactly like
// `/v1/chat/completions`, but the caller cannot spend another provider's quota.

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

async function requireKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  const valid = await isValidApiKey(apiKey);
  if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  return null;
}

function resolveProvider(provider) {
  const id = AI_PROVIDERS[provider] ? provider : AI_PROVIDERS[provider]?.id;
  if (id) return id;
  const alias = Object.values(AI_PROVIDERS).find((p) => p.alias === provider);
  return alias ? alias.id : null;
}

function modelList(providerId) {
  const models = PROVIDER_MODELS[providerId] || [];
  const alias = AI_PROVIDERS[providerId]?.alias || providerId;
  return models.map((m) => ({
    id: `${alias}/${m.id}`,
    object: "model",
    owned_by: providerId,
    created: 0,
    name: m.name || m.id,
    kind: m.kind || "llm",
  }));
}

/** GET /v1/providers/{provider} — provider metadata. */
export async function handleProviderInfo(request, provider) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const providerId = resolveProvider(provider);
  if (!providerId) return errorResponse(HTTP_STATUS.NOT_FOUND, `No such provider: ${provider}`);
  const cfg = AI_PROVIDERS[providerId] || {};
  const models = PROVIDER_MODELS[providerId] || [];
  return jsonResponse({
    id: providerId,
    alias: cfg.alias || providerId,
    name: cfg.name || providerId,
    serviceKinds: cfg.serviceKinds || [],
    modelCount: models.length,
  });
}

/** GET /v1/providers/{provider}/models — that provider's model catalog. */
export async function handleProviderModels(request, provider) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const providerId = resolveProvider(provider);
  if (!providerId) return errorResponse(HTTP_STATUS.NOT_FOUND, `No such provider: ${provider}`);
  return jsonResponse({ object: "list", data: modelList(providerId) });
}

/**
 * POST /v1/providers/{provider}/{endpoint} — one gateway endpoint, provider fixed.
 * The body's `model` is rewritten to `{provider}/{model}` when it arrives bare.
 */
export async function handleProviderEndpoint(request, provider, endpoint) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const providerId = resolveProvider(provider);
  if (!providerId) return errorResponse(HTTP_STATUS.NOT_FOUND, `No such provider: ${provider}`);
  const alias = AI_PROVIDERS[providerId]?.alias || providerId;
  const suffix = String(endpoint || "").replace(/^\/+/, "");

  // Each suffix maps to the canonical gateway path so endpoint-based format
  // detection (handleChat reads the pathname) sees the same URL as /v1/...
  const targets = {
    "chat/completions": [handleChat, "/v1/chat/completions"],
    "completions": [handleCompletions, "/v1/completions"],
    "embeddings": [handleEmbeddings, "/v1/embeddings"],
    "images/generations": [handleImageGeneration, "/v1/images/generations"],
    "audio/speech": [handleTts, "/v1/audio/speech"],
    "audio/transcriptions": [handleStt, "/v1/audio/transcriptions"],
  }[suffix];
  if (!targets) return errorResponse(HTTP_STATUS.NOT_FOUND, `Unsupported provider endpoint: ${suffix}`);
  const [handler, canonicalPath] = targets;

  let init = { method: request.method, headers: request.headers, signal: request.signal };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
      }
      const model = body?.model;
      const bare = typeof model === "string" && !model.includes("/") ? model : null;
      const next = bare ? { ...body, model: `${alias}/${bare}` } : body;
      init = { ...init, headers: new Headers(request.headers), body: JSON.stringify(next) };
    } else {
      init = { ...init, body: request.body, duplex: "half" };
    }
  }
  const target = new URL(canonicalPath, new URL(request.url).origin);
  target.search = new URL(request.url).search;
  return handler(new Request(target, init));
}
