// Replaying a logged request means turning the record the request log kept back
// into a request the router can be asked again. The rules live here, free of any
// database, React or network access, so the API route and the UI can rely on
// the same verdict about what can be replayed and what cannot.
//
// What the request log stores: the OpenAI-shaped body that was forwarded
// upstream ({ messages, model, stream, ...optional params }) next to the
// metadata of the row (id, timestamp, provider, model, connectionId, status).
// Nothing else of the original HTTP request survives — no URL, no method, no
// headers — so the endpoint and method below are the router's chat defaults
// and the headers are the ones a replay needs.

export const REPLAY_ENDPOINT = "/v1/chat/completions";
export const REPLAY_METHOD = "POST";

// The headers a replay sends. The router's own API key is added by the API
// route at send time and never lives in this module — nothing here is a secret.
const DEFAULT_HEADERS = { "Content-Type": "application/json" };

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The log stores the body as an object, but a row written by another writer can
// carry the raw text. A body that is not JSON cannot be replayed: there is
// nothing to send.
function parseStoredBody(stored) {
  if (stored === undefined || stored === null) {
    return { ok: false, reason: "No request body was stored for this request" };
  }

  if (typeof stored === "string") {
    const text = stored.trim();
    if (!text) return { ok: false, reason: "No request body was stored for this request" };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "The stored request body is not valid JSON" };
    }
    return parseStoredBody(parsed);
  }

  if (!isPlainObject(stored)) {
    return { ok: false, reason: "The stored request body is not a JSON object" };
  }

  // A body too big for the log was cut down when it was written. Replaying the
  // cut version would ask the provider something the user never sent.
  if (stored._truncated === true) {
    return { ok: false, reason: "The stored request body was truncated when it was logged" };
  }

  return { ok: true, body: stored };
}

// The log keeps the model the request carried ("provider/model") and, beside
// it, the bare model the provider answered with. The provider-qualified form
// is the one that replays onto the same provider.
function resolveModel(record, body) {
  const fromBody = typeof body?.model === "string" ? body.model.trim() : "";
  if (fromBody) return fromBody;

  const bare = typeof record?.model === "string" ? record.model.trim() : "";
  if (!bare) return null;

  const provider = typeof record?.provider === "string" ? record.provider.trim() : "";
  return provider && !bare.includes("/") ? `${provider}/${bare}` : bare;
}

function countMessages(body) {
  if (Array.isArray(body?.messages)) return body.messages.length;
  if (typeof body?.input === "string") return 1;
  if (Array.isArray(body?.input)) return body.input.length;
  return 0;
}

function buildDescription({ method, endpoint, model, messageCount, streaming }) {
  const base = `Replay ${method} ${endpoint} to ${model} with ${messageCount} message${messageCount === 1 ? "" : "s"}`;
  return streaming ? `${base} (the original request was streamed)` : base;
}

// One pass over a stored record: what was asked, and whether it can be asked
// again. Both public helpers read from this so the summary and the request
// can never disagree.
function analyze(record, options = {}) {
  if (!isPlainObject(record)) {
    return { ok: false, reason: "No stored request was found" };
  }

  const parsed = parseStoredBody(record.request);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const body = parsed.body;
  const model = resolveModel(record, body);
  if (!model) {
    return { ok: false, reason: "The stored request has no model to replay" };
  }

  const messageCount = countMessages(body);
  if (messageCount === 0) {
    return { ok: false, reason: "The stored request has no messages to replay" };
  }

  const endpoint = typeof options.endpoint === "string" && options.endpoint
    ? options.endpoint
    : REPLAY_ENDPOINT;
  const method = typeof options.method === "string" && options.method
    ? options.method.toUpperCase()
    : REPLAY_METHOD;

  // A streamed answer arrives in pieces, so there would be no single body to
  // preview. The replay asks for the same request without streaming and says
  // so in the description, so nobody mistakes it for the original shape.
  const streaming = body.stream === true;
  const stream = typeof options.stream === "boolean" ? options.stream : false;

  const headers = {
    ...DEFAULT_HEADERS,
    ...(isPlainObject(options.headers) ? options.headers : {}),
  };

  const replayBody = { ...body, model, stream };
  // A client header kept beside the body in the log is not a body field.
  delete replayBody.headers;

  return {
    ok: true,
    endpoint,
    method,
    model,
    messageCount,
    streaming,
    headers,
    body: replayBody,
    description: buildDescription({ method, endpoint, model, messageCount, streaming }),
  };
}

/**
 * Rebuild a request the router can be asked again from a stored request record.
 * Returns { endpoint, method, body, headers, model, description } when the
 * record can be replayed, { replayable: false, reason } when it cannot.
 */
export function buildReplayRequest(record, options = {}) {
  const resolved = analyze(record, options);

  if (!resolved.ok) {
    return { replayable: false, reason: resolved.reason };
  }

  return {
    replayable: true,
    endpoint: resolved.endpoint,
    method: resolved.method,
    body: resolved.body,
    headers: resolved.headers,
    model: resolved.model,
    description: resolved.description,
  };
}

/**
 * Describe a stored request for the log UI: what it was and whether the replay
 * button can do anything with it.
 */
export function summarizeReplay(record) {
  if (!isPlainObject(record)) {
    return {
      id: null,
      provider: null,
      model: null,
      status: null,
      timestamp: null,
      endpoint: REPLAY_ENDPOINT,
      method: REPLAY_METHOD,
      messageCount: 0,
      streaming: false,
      replayable: false,
      reason: "No stored request was found",
    };
  }

  const resolved = analyze(record);
  const parsed = parseStoredBody(record.request);

  return {
    id: record.id ?? null,
    provider: record.provider ?? null,
    model: parsed.ok ? resolveModel(record, parsed.body) : (record.model ?? null),
    status: record.status ?? null,
    timestamp: record.timestamp ?? null,
    endpoint: resolved.ok ? resolved.endpoint : REPLAY_ENDPOINT,
    method: resolved.ok ? resolved.method : REPLAY_METHOD,
    messageCount: resolved.ok ? resolved.messageCount : 0,
    streaming: parsed.ok ? parsed.body?.stream === true : false,
    replayable: resolved.ok === true,
    reason: resolved.ok ? null : resolved.reason,
  };
}
