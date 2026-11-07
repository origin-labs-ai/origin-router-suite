// Local engine bridge — live status probes for the three local inference
// runtimes the dashboard can talk to.
//
// SECURITY EXCEPTION (by design): every other outbound request in this feature
// goes through the SSRF guard and is forbidden from touching loopback. The
// probes here are the single deliberate exception — Ollama, LM Studio and
// llama.cpp run ON the user's machine, so 127.0.0.1 is not an attack target
// but the whole point. To keep that exception airtight we do NOT use free-form
// URLs: each probe hard-codes its endpoint and re-verifies the final URL
// against the exact expected origin before any bytes leave the process.
//
// Fail-open contract: an engine that is off, slow, or speaking gibberish is a
// normal state of the world, never a crash. Every probe resolves to
// { ok, models, error } — `ok:false` with an empty list is a perfectly valid
// answer that the dashboard renders as a gray status dot.

// Fixed endpoints. Port and host are constants, never user input.
export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const LMSTUDIO_ORIGIN = "http://127.0.0.1:1234";
export const LLAMACPP_ORIGIN = "http://127.0.0.1:8080";

// One engine's health summary. Shapes what the page's status cards render.
//   ok      — engine answered our probe
//   models  — what it currently serves (empty when unknown)
//   error   — short human reason for the failure, absent when ok
function emptyResult() {
  return { ok: false, models: [], error: undefined };
}

// Guard shared by all three probes: refuse to fire unless `url` is exactly the
// expected origin + the expected path. Belt-and-braces — the URLs are built
// from the constants right above — but the check lives next to every call so
// a future refactor cannot quietly widen the local-engine exception.
function assertLocalEndpoint(url, expectedOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid engine probe URL: ${url}`);
  }
  if (parsed.origin !== expectedOrigin) {
    throw new Error(`Engine probe refused: ${parsed.origin} is not the expected ${expectedOrigin}`);
  }
}

// fetch with a hard deadline. An engine that hangs must cost the dashboard at
// most `timeoutMs`, not a spinning request. Aborts resolve like errors below.
async function fetchWithTimeout(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      // Never let a stale engine response be served from a cache layer.
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

// Turn any probe failure (refused connection, timeout, bad JSON, non-200) into
// the fail-open result. The error text is kept short — it is displayed in the
// UI as a tooltip, not logged as a stack trace.
function failure(err) {
  const result = emptyResult();
  result.error = err?.name === "AbortError" ? "Timed out" : String(err?.message || err || "Unreachable");
  return result;
}

// Probe Ollama: GET /api/tags → { models: [{ name, size, modified_at }] }.
// Sizes arrive in bytes; we pass them through untouched for the UI to format.
export async function probeOllama({ timeoutMs = 3000 } = {}) {
  const url = `${OLLAMA_ORIGIN}/api/tags`;
  try {
    assertLocalEndpoint(url, OLLAMA_ORIGIN);
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) return failure(new Error(`HTTP ${res.status}`));
    const data = await res.json();
    const rows = Array.isArray(data?.models) ? data.models : [];
    return {
      ok: true,
      models: rows.map((m) => ({
        name: typeof m?.name === "string" ? m.name : String(m?.model || ""),
        size: Number.isFinite(Number(m?.size)) ? Number(m.size) : null,
        modified: typeof m?.modified_at === "string" ? m.modified_at : null,
      })).filter((m) => m.name),
    };
  } catch (err) {
    return failure(err);
  }
}

// Probe LM Studio: GET /v1/models → OpenAI-style { data: [{ id }] }.
// LM Studio only serves models while its local server tab is running, so an
// `ok:false` here most often means "server not started", not "not installed".
export async function probeLmStudio({ timeoutMs = 3000 } = {}) {
  const url = `${LMSTUDIO_ORIGIN}/v1/models`;
  try {
    assertLocalEndpoint(url, LMSTUDIO_ORIGIN);
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) return failure(new Error(`HTTP ${res.status}`));
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return {
      ok: true,
      models: rows
        .map((m) => (typeof m?.id === "string" ? { id: m.id } : null))
        .filter(Boolean),
    };
  } catch (err) {
    return failure(err);
  }
}

// Probe llama.cpp: the server exposes /health and (optionally) /v1/models.
// /health is the authoritative liveness answer; /v1/models may be absent on
// older builds, so an unhealthy models endpoint must not fail an otherwise
// healthy server. Health-first, models best-effort.
export async function probeLlamaCpp({ timeoutMs = 3000 } = {}) {
  const healthUrl = `${LLAMACPP_ORIGIN}/health`;
  const modelsUrl = `${LLAMACPP_ORIGIN}/v1/models`;
  try {
    assertLocalEndpoint(healthUrl, LLAMACPP_ORIGIN);
    assertLocalEndpoint(modelsUrl, LLAMACPP_ORIGIN);

    const healthRes = await fetchWithTimeout(healthUrl, { timeoutMs });
    if (!healthRes.ok) return failure(new Error(`HTTP ${healthRes.status}`));

    // Models are optional: try them, and fall through to an empty list when
    // the build does not implement the endpoint.
    let models = [];
    try {
      const modelsRes = await fetchWithTimeout(modelsUrl, { timeoutMs });
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        const rows = Array.isArray(data?.data) ? data.data : [];
        models = rows
          .map((m) => (typeof m?.id === "string" ? { id: m.id } : null))
          .filter(Boolean);
      }
    } catch {
      // Endpoint missing/unimplemented — health already answered, keep going.
    }

    return { ok: true, models };
  } catch (err) {
    return failure(err);
  }
}

// Convenience for the API route: fire all three probes concurrently. A slow
// engine must not delay the status of the other two cards.
export async function probeAllEngines({ timeoutMs = 3000 } = {}) {
  const [ollama, lmstudio, llamacpp] = await Promise.all([
    probeOllama({ timeoutMs }),
    probeLmStudio({ timeoutMs }),
    probeLlamaCpp({ timeoutMs }),
  ]);
  return { ollama, lmstudio, llamacpp };
}
