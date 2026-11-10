import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import {
  complete,
  messageText,
  readUsage,
  jsonResponse,
  badRequest,
  preflight,
} from "./chatBridge.js";

export { preflight };

// Derived text-intelligence endpoints. Each one reshapes its input into a chat
// request, runs it through the shared chat bridge (combo rotation, account
// fallback, token refresh and token savers included), then reshapes the answer
// back into the endpoint's own contract.

const LLM_KIND = "llm";

/** Copy a body without the keys the chat pipeline should not see. */
function omit(body, keys) {
  const out = { ...(body || {}) };
  for (const key of keys) delete out[key];
  return out;
}

/** Coerce strings, string arrays and text-bearing objects into plain text. */
function toText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : typeof v?.text === "string" ? v.text : ""))
      .join("\n");
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return "";
}

/** Pull the first JSON object/array out of a model answer. */
function extractJson(text) {
  const s = String(text || "");
  const match = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** OpenAI completions `prompt` (string or string[]) → chat messages. */
function normalizePrompt(prompt) {
  if (typeof prompt === "string") {
    return prompt.trim() ? [{ role: "user", content: prompt }] : [];
  }
  if (Array.isArray(prompt)) {
    return prompt
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => ({ role: "user", content: p }));
  }
  return [];
}

/** Rerank documents may be strings or objects with a `text` field. */
function normalizeDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents.map((doc) => {
    if (typeof doc === "string") return doc;
    if (doc && typeof doc.text === "string") return doc.text;
    try {
      return JSON.stringify(doc);
    } catch {
      return String(doc);
    }
  });
}

/** Scores aligned with the document order, clamped to 0..1. */
function parseRerankScores(text, count) {
  const scores = new Array(count).fill(0);
  const parsed = extractJson(text);
  const arr = Array.isArray(parsed) ? parsed : parsed?.results ?? parsed?.scores;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const index = Number(item?.index ?? item?.i);
      const score = Number(item?.relevance_score ?? item?.score ?? item?.relevance);
      if (Number.isInteger(index) && index >= 0 && index < count && Number.isFinite(score)) {
        scores[index] = Math.max(0, Math.min(1, score));
      }
    }
  }
  return scores;
}

/** Top label plus a full label→score map. */
function parseClassification(text, labels) {
  const scores = {};
  for (const label of labels) scores[label] = 0;
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed.scores ?? parsed.categories ?? parsed;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const score = Number(value);
        if (Object.prototype.hasOwnProperty.call(scores, key) && Number.isFinite(score)) {
          scores[key] = Math.max(0, Math.min(1, score));
        }
      }
    }
    const label = parsed.label ?? parsed.top_label ?? parsed.top;
    if (typeof label === "string" && Object.prototype.hasOwnProperty.call(scores, label)) {
      return { top_label: label, scores };
    }
  }
  let top = labels[0];
  let best = -Infinity;
  for (const [label, score] of Object.entries(scores)) {
    if (score > best) {
      best = score;
      top = label;
    }
  }
  return { top_label: top, scores };
}

/** Sentence list from JSON, falling back to a punctuation split. */
function parseSegments(text) {
  const parsed = extractJson(text);
  if (Array.isArray(parsed)) {
    return parsed.filter((s) => typeof s === "string" && s.trim());
  }
  const arr = parsed?.segments ?? parsed?.sentences;
  if (Array.isArray(arr)) {
    return arr.filter((s) => typeof s === "string" && s.trim());
  }
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Flag plus category map from JSON. */
function parseModeration(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") return { flagged: false, categories: {} };
  const raw = parsed.categories;
  const categories = {};
  if (Array.isArray(raw)) {
    for (const c of raw) if (typeof c === "string") categories[c] = true;
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      categories[key] = typeof value === "boolean" ? value : Boolean(value);
    }
  }
  const flagged =
    typeof parsed.flagged === "boolean" ? parsed.flagged : Object.values(categories).some(Boolean);
  return { flagged, categories };
}

function buildRerankPrompt(query, documents) {
  return [
    "You are a search reranker. Score how relevant each document is to the query.",
    'Return ONLY JSON: {"results":[{"index":<number>,"relevance_score":<0..1>}]}.',
    "Do not include the document text or any explanation.",
    "",
    `Query: ${query}`,
    "",
    "Documents:",
    ...documents.map((doc, i) => `[${i}] ${doc}`),
  ].join("\n");
}

function buildClassifyPrompt(input, labels) {
  return [
    "Classify the input into one of the labels.",
    'Return ONLY JSON: {"label":"<label>","scores":{"<label>":<0..1>}}.',
    "",
    `Labels: ${labels.join(", ")}`,
    "",
    "Input:",
    input,
  ].join("\n");
}

function buildSegmentPrompt(text) {
  return [
    "Split the text into sentences. Keep the original wording.",
    'Return ONLY JSON: {"segments":["<sentence>", ...]}.',
    "",
    "Text:",
    text,
  ].join("\n");
}

function buildModerationPrompt(input) {
  return [
    'Moderate the input. Return ONLY JSON: {"flagged":<true|false>,"categories":{"<category>":<true|false>}}.',
    "Categories: hate, harassment, sexual, violence, self-harm, self-harm/intent, self-harm/instructions, sexual/minors, violence/graphic, hate/threatening.",
    "",
    "Input:",
    input,
  ].join("\n");
}

/**
 * POST /v1/completions — OpenAI text-completion shape over the chat pipeline.
 * `prompt` (string or string[]) becomes the user turn(s); the reply is wrapped
 * as a `text_completion` object with `choices[].text`.
 */
export async function handleCompletions(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const messages = normalizePrompt(body?.prompt);
  if (!messages.length) return badRequest("Missing required field: prompt");

  const response = await complete(request, {
    ...omit(body, ["prompt", "suffix", "best_of", "echo"]),
    messages,
  });
  if (!response.ok) return response;

  const clone = response.clone();
  const text = await messageText(response);
  const usage = await readUsage(clone);

  return jsonResponse({
    id: `cmpl-${Date.now().toString(36)}`,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: body?.model,
    choices: [{ text, index: 0, finish_reason: "stop", logprobs: null }],
    usage,
  });
}

/**
 * POST /v1/rerank — score each document against a query. The prompt asks for a
 * JSON score list; the answer is sorted by relevance (highest first).
 */
export async function handleRerank(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const query = toText(body?.query);
  const documents = normalizeDocuments(body?.documents);
  if (!query.trim()) return badRequest("Missing required field: query");
  if (!documents.length) return badRequest("Missing required field: documents");

  const response = await complete(request, {
    ...omit(body, ["query", "documents", "top_n", "return_documents", "max_chunks_per_doc"]),
    messages: [{ role: "user", content: buildRerankPrompt(query, documents) }],
  });
  if (!response.ok) return response;

  const text = await messageText(response);
  const scores = parseRerankScores(text, documents.length);
  const requested = Number(body?.top_n);
  const topN = Number.isFinite(requested) && requested >= 0 ? Math.floor(requested) : documents.length;
  const results = documents
    .map((document, index) => ({ index, relevance_score: scores[index], document }))
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, topN);

  return jsonResponse({ results });
}

/**
 * POST /v1/classify — pick the best label for an input and return the scores.
 */
export async function handleClassify(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const input = toText(body?.input);
  const labels = Array.isArray(body?.labels)
    ? body.labels.filter((label) => typeof label === "string" && label.trim())
    : [];
  if (!input.trim()) return badRequest("Missing required field: input");
  if (!labels.length) return badRequest("Missing required field: labels");

  const response = await complete(request, {
    ...omit(body, ["input", "labels"]),
    messages: [{ role: "user", content: buildClassifyPrompt(input, labels) }],
  });
  if (!response.ok) return response;

  const text = await messageText(response);
  const { top_label, scores } = parseClassification(text, labels);
  return jsonResponse({ top_label, scores });
}

/**
 * POST /v1/segments — split text into sentences.
 */
export async function handleSegment(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const text = toText(body?.text ?? body?.input);
  if (!text.trim()) return badRequest("Missing required field: text");

  const response = await complete(request, {
    ...omit(body, ["text", "input"]),
    messages: [{ role: "user", content: buildSegmentPrompt(text) }],
  });
  if (!response.ok) return response;

  const content = await messageText(response);
  return jsonResponse({ segments: parseSegments(content) });
}

/**
 * POST /v1/moderations — flag content and report category booleans.
 */
export async function handleModerations(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const input = toText(body?.input);
  if (!input.trim()) return badRequest("Missing required field: input");

  const response = await complete(request, {
    ...omit(body, ["input"]),
    messages: [{ role: "user", content: buildModerationPrompt(input) }],
  });
  if (!response.ok) return response;

  const text = await messageText(response);
  return jsonResponse(parseModeration(text));
}

/**
 * POST /v1/models/query — filter the catalog by `q`, `provider` and `limit`.
 * Returns the same `{ object: "list", data }` shape as GET /v1/models.
 */
export async function handleModelsQuery(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object") body = {};

  const q = typeof body.q === "string" ? body.q.trim().toLowerCase() : "";
  const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
  const requested = Number(body.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;

  let list;
  try {
    const keyAccess = await getKeyAccessContext(request);
    list = await filterModelsListForKey(keyAccess, await buildModelsList([LLM_KIND]));
  } catch (error) {
    return jsonResponse(
      { error: { message: error?.message || "Failed to load models", type: "server_error" } },
      500,
    );
  }

  if (provider) {
    list = list.filter((entry) => {
      const id = String(entry?.id || "").toLowerCase();
      const owner = String(entry?.owned_by || "").toLowerCase();
      return owner === provider || id === provider || id.startsWith(`${provider}/`);
    });
  }
  if (q) {
    list = list.filter((entry) => String(entry?.id || "").toLowerCase().includes(q));
  }
  if (limit > 0) list = list.slice(0, limit);

  return jsonResponse({ object: "list", data: list });
}
