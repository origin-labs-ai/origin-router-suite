import { Buffer } from "node:buffer";
import {
  extractApiKey,
  isValidApiKey,
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleImageGeneration } from "./imageGeneration.js";
import { handleTts } from "./tts.js";
import { handleStt } from "./stt.js";
import { handleVoices } from "./voices.js";
import { complete } from "./derived/chatBridge.js";
import * as log from "../utils/logger.js";

// Media aliases: thin shapes over the media surface the engine already serves.
// OCR rides the chat pipeline (vision), image edit/upscale ride image generation,
// translation rides STT, and the ElevenLabs-native routes proxy straight to the
// stored ElevenLabs connection. None of these re-implement provider logic.

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const ELEVENLABS_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "request-id",
  "retry-after",
  "character-cost",
  "song-id",
];

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

/** Reject invalid/absent keys when the instance requires them. */
async function requireKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  const valid = await isValidApiKey(apiKey);
  if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  return null;
}

/** ElevenLabs connection, or the response that refuses the request. */
async function elevenLabsCredentials() {
  const credentials = await getProviderCredentials("elevenlabs", null, null);
  if (!credentials) {
    return { response: errorResponse(HTTP_STATUS.UNAUTHORIZED, "No credentials for provider: elevenlabs") };
  }
  if (credentials.allRateLimited) {
    return {
      response: errorResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        `[elevenlabs] ${credentials.lastError || "All accounts rate limited"}`,
      ),
    };
  }
  const apiKey = credentials.apiKey || credentials.accessToken;
  if (!apiKey) {
    return { response: errorResponse(HTTP_STATUS.UNAUTHORIZED, "No credentials for provider: elevenlabs") };
  }
  return { apiKey, credentials };
}

function copyUpstreamHeaders(upstream) {
  const headers = new Headers(CORS_HEADERS);
  for (const name of ELEVENLABS_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/**
 * Forward the request to the ElevenLabs v1 API with the stored connection key.
 * The upstream body/status is passed through untouched so native JSON fields,
 * query parameters and binary audio keep their meaning.
 */
async function elevenLabsFetch(request, pathname, init = {}) {
  const blocked = await requireKey(request);
  if (blocked) return { response: blocked };
  const cred = await elevenLabsCredentials();
  if (cred.response) return { response: cred.response };

  const incoming = new URL(request.url);
  const upstreamUrl = new URL(`${ELEVENLABS_BASE}${pathname}`);
  upstreamUrl.search = incoming.search;

  const headers = new Headers();
  headers.set("xi-api-key", cred.apiKey);
  const contentType = init.contentType ?? request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);

  try {
    const upstream = await fetch(upstreamUrl, { ...init, headers, signal: request.signal });
    if (upstream.ok) {
      await clearAccountError(cred.credentials.connectionId).catch?.(() => {});
    } else if (upstream.status === 401 || upstream.status === 429) {
      await markAccountUnavailable(cred.credentials.connectionId, upstream.status, "ElevenLabs upstream error").catch?.(() => {});
    }
    return { upstream };
  } catch (error) {
    log.warn("MEDIA", `ElevenLabs ${pathname} failed: ${error?.message || error}`);
    return { response: errorResponse(HTTP_STATUS.BAD_GATEWAY, error?.message || "ElevenLabs request failed") };
  }
}

/** Proxy a raw ElevenLabs response (audio/multipart/JSON) straight through. */
async function proxyElevenLabs(request, pathname, init = {}) {
  const { upstream, response } = await elevenLabsFetch(request, pathname, init);
  if (response) return response;
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyUpstreamHeaders(upstream),
  });
}

/** Read a JSON or multipart body into one plain object (file parts become data URLs). */
export async function readMediaBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const body = {};
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          body[key] = value;
          continue;
        }
        const bytes = Buffer.from(await value.arrayBuffer());
        if (!bytes.length) continue;
        const mime = value.type && value.type.startsWith("image/") ? value.type : "image/png";
        body[key] = `data:${mime};base64,${bytes.toString("base64")}`;
      }
      return body;
    } catch (error) {
      log.warn("MEDIA", `Invalid multipart body: ${error?.message || error}`);
      return null;
    }
  }
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Rebuild the request with a JSON body so an existing handler can consume it. */
export function withJsonBody(request, body) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

// ── OCR ──────────────────────────────────────────────────────────────────────

const OCR_DEFAULT_PROMPT =
  "Extract every piece of text from this document. Preserve the reading order and " +
  "return only the extracted markdown, with no commentary.";

function documentUrlOf(body) {
  const document = body?.document || {};
  return (
    document.document_url ||
    document.image_url ||
    document.url ||
    body?.image_url ||
    body?.image ||
    (Array.isArray(body?.images) ? body.images[0] : null) ||
    null
  );
}

/**
 * POST /v1/ocr — document/image OCR over the vision chat pipeline.
 * Body: { model, document: { type: "document_url", document_url }, prompt? }
 * Response: { pages: [{ index, markdown }], model, usage_info }
 */
export async function handleOcr(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const documentUrl = documentUrlOf(body);
  if (!documentUrl) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: document (or image)");
  }

  const model = body?.model || "mistral-ocr-latest";
  const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt : OCR_DEFAULT_PROMPT;

  const response = await complete(request, {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: documentUrl } },
        ],
      },
    ],
  });
  if (!response.ok) return response;

  const text = await response
    .clone()
    .json()
    .then((json) => json?.choices?.[0]?.message?.content ?? "")
    .catch(() => "");

  return jsonResponse({
    pages: [{ index: 0, markdown: typeof text === "string" ? text : "" }],
    model,
    usage_info: { pages_processed: 1 },
  });
}

// ── Image edit / upscale ─────────────────────────────────────────────────────

function hasImage(body) {
  return Boolean(
    body?.image ||
      body?.image_url ||
      body?.imageBytes ||
      (Array.isArray(body?.images) && body.images.length) ||
      (Array.isArray(body?.image_urls) && body.image_urls.length),
  );
}

/**
 * POST /v1/images/edits — OpenAI-style image edit/inpaint.
 * Accepts JSON (data URL or http(s) URL) or multipart/form-data (`image`, `mask`).
 * The body is forwarded to the image generation pipeline, whose providers already
 * understand `image`/`images`/`image_url`.
 */
export async function handleImageEdit(request) {
  const body = await readMediaBody(request);
  if (!body) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid request body. Send multipart/form-data or JSON with an image.",
    );
  }
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  if (!hasImage(body)) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
  if (!body.model) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: model");
  return handleImageGeneration(withJsonBody(request, body));
}

/**
 * POST /v1/images/upscale — image-to-image super resolution.
 * The image generation pipeline carries the source image; a neutral prompt is
 * supplied when the caller does not provide one.
 */
export async function handleImageUpscale(request) {
  const body = await readMediaBody(request);
  if (!body) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid request body. Send multipart/form-data or JSON with an image.",
    );
  }
  if (!hasImage(body)) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
  const forwarded = {
    ...body,
    prompt: typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : "Upscale this image.",
  };
  return handleImageGeneration(withJsonBody(request, forwarded));
}

// ── ElevenLabs native routes ─────────────────────────────────────────────────

/** POST /v1/sound-generation — ElevenLabs sound effects. */
export async function handleSoundGeneration(request) {
  return proxyElevenLabs(request, "/sound-generation", {
    method: "POST",
    body: request.body,
    duplex: "half",
  });
}

/** GET /v1/voices — alias for /v1/audio/voices (provider-scoped voice catalog). */
export async function handleVoicesAlias(request) {
  return handleVoices(request);
}

// ── Music ────────────────────────────────────────────────────────────────────

/** POST /v1/music — ElevenLabs music composition (native audio). */
export async function handleMusic(request) {
  return proxyElevenLabs(request, "/music", { method: "POST", body: request.body, duplex: "half" });
}

/** POST /v1/music/stream — ElevenLabs music streaming. */
export async function handleMusicStream(request) {
  return proxyElevenLabs(request, "/music/stream", {
    method: "POST",
    body: request.body,
    duplex: "half",
  });
}

/** POST /v1/music/plan — ElevenLabs composition plan. */
export async function handleMusicPlan(request) {
  return proxyElevenLabs(request, "/music/plan", {
    method: "POST",
    body: request.body,
    duplex: "half",
  });
}

/** POST /v1/music/detailed — ElevenLabs multipart audio + composition plan. */
export async function handleMusicDetailed(request) {
  return proxyElevenLabs(request, "/music/detailed", {
    method: "POST",
    body: request.body,
    duplex: "half",
  });
}

/** POST /v1/music/detailed/stream — ElevenLabs SSE metadata + audio chunks. */
export async function handleMusicDetailedStream(request) {
  return proxyElevenLabs(request, "/music/detailed/stream", {
    method: "POST",
    body: request.body,
    duplex: "half",
  });
}

/**
 * POST /v1/music/generations — OpenAI-style music generation.
 * Maps the unified contract onto ElevenLabs' `/music`: `duration` (seconds)
 * becomes `music_length_ms` unless an explicit value is sent, and `instrumental`
 * maps to `force_instrumental`. Returns `{ created, data: [{ b64_json, format }] }`.
 */
export async function handleMusicGenerations(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body?.prompt && !body?.composition_plan) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  const durationMs = Number.isFinite(Number(body.music_length_ms))
    ? Number(body.music_length_ms)
    : Number.isFinite(Number(body.duration))
      ? Math.round(Number(body.duration) * 1000)
      : undefined;
  const instrumental = body.force_instrumental ?? body.instrumental;
  const payload = {
    ...(body.prompt ? { prompt: body.prompt } : {}),
    ...(body.composition_plan ? { composition_plan: body.composition_plan } : {}),
    ...(durationMs ? { music_length_ms: durationMs } : {}),
    ...(instrumental ? { force_instrumental: true } : {}),
    ...(body.model_id ? { model_id: body.model_id } : {}),
  };

  const { upstream, response } = await elevenLabsFetch(request, "/music", {
    method: "POST",
    body: JSON.stringify(payload),
    contentType: "application/json",
  });
  if (response) return response;
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyUpstreamHeaders(upstream),
    });
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type") || "";
  const format = contentType.includes("wav") ? "wav" : "mp3";
  return jsonResponse({
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: audio.toString("base64"), format }],
  });
}

// ── Translations / STT / TTS aliases ────────────────────────────────────────

/**
 * POST /v1/audio/translations — Whisper-style translation.
 * Reuses the STT pipeline with `task=translate`, which switches the
 * OpenAI-compatible transport to the provider's translation endpoint.
 */
export async function handleAudioTranslation(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }
  formData.set("task", "translate");
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: formData,
    signal: request.signal,
  });
  return handleStt(forwarded);
}

const VOICE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** POST /v1/speech-to-text — alias for /v1/audio/transcriptions. */
export async function handleSpeechToTextAlias(request) {
  return handleStt(request);
}

/**
 * POST /v1/text-to-speech/{voiceId} — alias for /v1/audio/speech with the
 * path voice injected into the body.
 */
export async function handleTextToSpeechAlias(request, voiceId) {
  if (typeof voiceId !== "string" || !VOICE_ID_RE.test(voiceId)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid voice ID");
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  const forwarded = {
    ...body,
    voice: voiceId,
    input: body.input ?? body.text,
    // A path voice with no explicit provider model defaults to ElevenLabs,
    // which is the catalog the native voice-id routes address.
    model: body.model ?? body.model_id ?? `elevenlabs/${voiceId}`,
  };
  return handleTts(withJsonBody(request, forwarded));
}
