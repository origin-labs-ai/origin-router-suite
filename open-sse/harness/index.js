// Provider Adapter Harness — the deterministic-gateway layer, adapted.
//
// The references shipped a typed harness (openai/anthropic/local adapters)
// over their self-hosted gateway. This is that concept natively: three thin
// adapter kinds over the three wire formats OriginRouter already speaks, with
// the same auth/header conventions as the provider schema defaults. Adapters
// are read-mostly wrappers — the main pipeline (translator/executors) remains
// the canonical path; the harness is for the deterministic surfaces (MCP,
// A2A, YAML routing) that need a minimal `complete(request)` contract without
// pulling the whole combo machinery in.
//
// House rules: plain JS ESM, fail-open (an unknown provider id falls back to
// the default OpenAI adapter), no network on import, no TypeScript.

import { getCapabilitiesForModel } from "../providers/capabilities.js";

// ─── Auth/header conventions (mirror of PROVIDER_DEFAULTS) ───────────────────

function bearerHeaders(apiKey, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

function xApiKeyHeaders(apiKey, extra = {}) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    ...extra,
  };
}

function queryAuthUrl(baseUrl, apiKey) {
  // Gemini-style ?key= auth over https. Refuses non-https and non-standard
  // hosts by construction (callers pass registry baseUrls; the guard is the
  // backstop).
  const u = new URL(String(baseUrl));
  if (u.protocol !== "https:") throw new Error("gemini adapter requires https");
  u.searchParams.set("key", String(apiKey));
  return u.toString();
}

// ─── Adapter kinds ───────────────────────────────────────────────────────────

// OpenAI chat-completions: POST {base}/chat/completions, bearer auth.
async function completeOpenAI(request, { baseUrl, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const res = await doFetch(url, {
    method: "POST",
    headers: bearerHeaders(apiKey),
    body: JSON.stringify({ ...request, stream: false }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// Anthropic messages: POST {base}/messages, x-api-key auth.
async function completeAnthropic(request, { baseUrl, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${String(baseUrl).replace(/\/+$/, "")}/messages`;
  const body = {
    model: request.model,
    max_tokens: request.max_tokens || 4096,
    messages: (request.messages || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    })),
    ...(request.system ? { system: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
  const res = await doFetch(url, {
    method: "POST",
    headers: xApiKeyHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// Gemini generateContent: POST {base}/models/{model}:generateContent?key=…
async function completeGemini(request, { baseUrl, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const base = String(baseUrl).replace(/\/+$/, "");
  const model = String(request.model || "").replace(/^models\//, "");
  const url = queryAuthUrl(`${base}/models/${encodeURIComponent(model)}:generateContent`, apiKey);
  const contents = (request.messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }],
  }));
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}) }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// The kind registry: one complete() per wire format.
const KINDS = {
  openai: completeOpenAI,
  anthropic: completeAnthropic,
  gemini: completeGemini,
};

/**
 * Build a provider adapter: { id, kind, complete(request, ctx) }.
 * @param {{ providerId?: string, kind?: "openai"|"anthropic"|"gemini",
 *            baseUrl: string, apiKey?: string, fetchImpl?: Function }} config
 */
export function createProviderAdapter({ providerId, kind = "openai", baseUrl, apiKey, fetchImpl } = {}) {
  const id = String(providerId || `adapter-${kind}`);
  const completeFn = KINDS[kind] || completeOpenAI; // unknown kind falls back to openai
  return {
    id,
    kind: KINDS[kind] ? kind : "openai",
    async complete(request, ctx = {}) {
      const doFetch = ctx.fetchImpl || fetchImpl || fetch;
      return completeFn(request, { baseUrl, apiKey, fetchImpl: doFetch });
    },
  };
}

const registry = new Map(); // id → adapter

/** Register an adapter for the deterministic surfaces; returns the adapter. */
export function registerAdapter(adapter) {
  if (adapter?.id) registry.set(adapter.id, adapter);
  return adapter;
}

export function getAdapter(id) {
  return registry.get(id) || null;
}

export function listAdapters() {
  return [...registry.values()].map(({ id, kind }) => ({ id, kind }));
}

/** Convenience: create AND register in one call. */
export function provideAdapter(config) {
  return registerAdapter(createProviderAdapter(config));
}
