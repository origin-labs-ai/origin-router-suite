import { handleChat } from "@/sse/handlers/chat.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// The derived /v1 endpoints (rerank, classify, moderations, segments,
// completions, models/query) are thin shapes over the chat pipeline. They run
// the caller's request through handleChat with streaming disabled, so combo
// rotation, account fallback, token refresh and the token savers all apply
// without re-implementing any of it.

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

/** CORS preflight shared by the derived routes. */
export function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * Fold an SSE body into plain text. Lines are trimmed, the `data:` prefix is
 * dropped, and `choices[0].delta.content` is accumulated. `[DONE]`, comment
 * lines and non-JSON frames are ignored. The `choices[0].text` and
 * `choices[0].message.content` fallbacks keep text-completion and full-message
 * frames from being lost.
 */
export function foldSseText(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "";
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string") {
      text += delta;
      continue;
    }
    if (Array.isArray(delta)) {
      text += delta
        .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .join("");
      continue;
    }
    if (typeof choice?.text === "string") {
      text += choice.text;
      continue;
    }
    if (typeof choice?.message?.content === "string") {
      text += choice.message.content;
    }
  }
  return text;
}

/** JSON response with the CORS header the rest of the /v1 surface sends. */
export function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

/** 400 with the OpenAI error envelope. */
export function badRequest(message) {
  return errorResponse(HTTP_STATUS.BAD_REQUEST, message);
}

/**
 * Run the request through the chat pipeline with streaming disabled and return
 * a Response. A JSON answer is returned untouched; a stream is folded into
 * `{ choices: [{ message: { role: "assistant", content } }] }`.
 *
 * @param {Request} request - the original derived-endpoint request
 * @param {object} body - chat-completions body to send (messages required)
 * @returns {Promise<Response>}
 */
export async function complete(request, body) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // The body is rewritten, so the caller's length header no longer matches.
  headers.delete("content-length");
  const response = await handleChat(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: false }),
    }),
  );
  if (!response) {
    return jsonResponse(
      { error: { message: "Chat pipeline unavailable", type: "server_error" } },
      500,
    );
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) return response;
  const raw = await response.text();
  return jsonResponse({
    choices: [{ index: 0, message: { role: "assistant", content: foldSseText(raw) } }],
  });
}

/** Extract the assistant text from a JSON or SSE response. */
export async function messageText(response) {
  if (!response) return "";
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return foldSseText(raw);
  }
  const choice = parsed?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  if (typeof parsed?.output_text === "string") return parsed.output_text;
  return "";
}

/** Read the usage block from a chat response, defaulting to zero counts. */
export async function readUsage(response) {
  try {
    const json = await response.json();
    const usage = json?.usage;
    if (usage && typeof usage === "object") {
      return {
        prompt_tokens: Number(usage.prompt_tokens) || 0,
        completion_tokens: Number(usage.completion_tokens) || 0,
        total_tokens: Number(usage.total_tokens) || 0,
      };
    }
  } catch {
    /* no usage block */
  }
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}
