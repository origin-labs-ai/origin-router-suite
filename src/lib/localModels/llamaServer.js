// llama.cpp as a managed serving backend.
//
// Ollama and LM Studio bring their own servers; llama.cpp ships a bare
// `llama-server` executable the owner drops on disk. This module starts/stops
// one process per GGUF file, health-polls it until the model is loaded, and
// exposes its OpenAI-compatible endpoint to the dashboard.
//
// SECURITY CONTRACT (the reason this file looks the way it does):
//   • The child is spawned with the ARGV ARRAY form and shell:false explicitly
//     set — no metacharacter in any path or id can ever reach a shell. Every
//     argv element is either a module constant or a value that passed the
//     validators below (an absolute existing .gguf path, integers for
//     port/context). No user text is ever interpolated into a command string.
//   • The binary path comes only from findLlamaServerBinary() (PATH scan +
//     the owner-managed ~/.or/bin folders) — never from request input.
//   • The server binds 127.0.0.1 ONLY. `host` is accepted for call symmetry
//     but any other value is refused, so the feature cannot be turned into a
//     LAN-exposed inference endpoint by accident or by a crafted payload.
//   • Talking to the server is the same deliberate loopback exception the
//     engine probes use (see engines.js): 127.0.0.1 here is the product, not
//     an attack target. Like the probes, every fetch re-verifies the final URL
//     against the exact expected origin before any bytes leave the process.
//
// Fail-open contract: startLlamaServer NEVER throws — it resolves
// { ok:true, server } or { ok:false, error } so a fire-and-forget call from
// the API route cannot produce an unhandled rejection, and the UI always has
// a human message to render.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { getDataDir } from "@/lib/dataDir.js";
import { findLlamaServerBinary } from "@/lib/localModels/engines.js";

// Loopback only. The bind host and every client URL are derived from this
// single constant — there is no code path that can serve on another interface.
export const LLAMA_BIND_HOST = "127.0.0.1";

// Model loading can take a while on first read from disk (especially on cold
// caches or big models), so the health wait is generous.
const HEALTH_TIMEOUT_MS = 120 * 1000;
const HEALTH_POLL_MS = 500;
// Individual health probes get a short deadline — a wedged server must not
// stretch the wait beyond the overall timeout.
const HEALTH_PROBE_TIMEOUT_MS = 2000;

// Bounds: a 0.5B model needs ~512 ctx; anything huge is the owner's choice,
// but the range keeps a typo from spawning nonsense.
const MIN_CTX = 256;
const MAX_CTX = 131072;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_MESSAGE_CHARS = 8000;
const DEFAULT_CHAT_MAX_TOKENS = 256;

// Bounded registry of managed servers, mirroring the downloads.js job map:
// in-memory only (a server restart orphans the children either way), capped,
// with terminal records lingering briefly so the UI can show what happened.
const MAX_SERVERS = 20;
const TERMINAL_TTL_MS = 60 * 60 * 1000; // 1h

const servers = new Map(); // id → record (child + log stream stay internal)
let serverSeq = 0;

// ── validation ───────────────────────────────────────────────────────────────

// The model must be an absolute path to an existing .gguf file. llama.cpp
// serves GGUF only, and the path is fed to argv verbatim, so resolving it here
// (and refusing anything that is not a plain file) is both a correctness and a
// safety check.
function assertServeModelPath(modelPath) {
  if (typeof modelPath !== "string" || !modelPath.trim()) {
    throw new Error("A model file path is required");
  }
  const clean = path.resolve(modelPath.trim());
  if (path.extname(clean).toLowerCase() !== ".gguf") {
    throw new Error("llama.cpp serves GGUF files only — pick a .gguf model file");
  }
  let stat;
  try {
    stat = fs.statSync(clean);
  } catch {
    throw new Error("Model file not found — check the path");
  }
  if (!stat.isFile()) {
    throw new Error("Model path is not a file");
  }
  return clean;
}

function sanitizePort(port) {
  const n = Number(port);
  if (port === undefined || port === null || port === "") return 8080; // llama.cpp default
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    throw new Error(`Port must be an integer between ${MIN_PORT} and ${MAX_PORT}`);
  }
  return n;
}

function sanitizeCtx(ctxSize) {
  const n = Number(ctxSize);
  if (ctxSize === undefined || ctxSize === null || ctxSize === "") return 4096;
  if (!Number.isInteger(n) || n < MIN_CTX || n > MAX_CTX) {
    throw new Error(`Context size must be an integer between ${MIN_CTX} and ${MAX_CTX}`);
  }
  return n;
}

// GPU offload depth. 0 means "run on CPU" and is a valid, deliberate choice, so
// it must not be confused with "unset" (unset falls back to the saved default).
const MIN_GPU_LAYERS = 0;
const MAX_GPU_LAYERS = 999;

function sanitizeGpuLayers(gpuLayers) {
  if (gpuLayers === undefined || gpuLayers === null || gpuLayers === "") return null;
  const n = Number(gpuLayers);
  if (!Number.isInteger(n) || n < MIN_GPU_LAYERS || n > MAX_GPU_LAYERS) {
    throw new Error(`GPU layers must be an integer between ${MIN_GPU_LAYERS} and ${MAX_GPU_LAYERS}`);
  }
  return n;
}

// Refuse anything but loopback. The parameter exists so a caller cannot silently
// widen the exposure — the only valid value is the constant.
function assertLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return;
  if (String(host).trim() !== LLAMA_BIND_HOST) {
    throw new Error("Host must be 127.0.0.1 — llama.cpp servers are loopback-only");
  }
}

// Belt-and-braces check before every loopback fetch: the URL must be exactly
// http://127.0.0.1:<expected port> — same pattern as engines.js probes, so a
// future refactor cannot quietly widen the local-engine exception.
function assertLoopbackUrl(url, expectedPort) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== LLAMA_BIND_HOST || parsed.port !== String(expectedPort)) {
    throw new Error(`Refused non-loopback request: ${url}`);
  }
  return parsed;
}

// ── registry plumbing ────────────────────────────────────────────────────────

function isTerminal(server) {
  return server.status === "stopped" || server.status === "failed";
}

function finishServer(server, status, error = null) {
  if (isTerminal(server)) return; // first terminal state wins (stop vs error race)
  server.status = status;
  server.error = error;
  server.stoppedAt = new Date().toISOString();
}

function toPublicServer(server) {
  // Internal handles (child, logStream) never leave the module.
  return {
    id: server.id,
    modelPath: server.modelPath,
    modelName: server.modelName,
    port: server.port,
    host: server.host,
    ctxSize: server.ctxSize,
    status: server.status, // starting | running | stopping | stopped | failed
    error: server.error,
    pid: server.child?.pid ?? null,
    startedAt: server.startedAt,
    stoppedAt: server.stoppedAt,
    endpoint: server.endpoint, // OpenAI-compatible chat completions URL
    healthUrl: server.healthUrl,
    logFile: server.logFile,
  };
}

// Sweep terminal records past the TTL so the map stays bounded without the UI
// losing recent failures. Exported for tests; also invoked lazily on listings.
export function sweepFinishedServers(nowMs = Date.now()) {
  for (const [id, server] of servers) {
    if (!isTerminal(server) || !server.stoppedAt) continue;
    const stoppedMs = Date.parse(server.stoppedAt);
    if (Number.isFinite(stoppedMs) && nowMs - stoppedMs > TERMINAL_TTL_MS) {
      servers.delete(id);
    }
  }
  return servers.size;
}

function boundServers() {
  while (servers.size > MAX_SERVERS) {
    const terminal = [...servers.values()].filter(isTerminal);
    const victim = terminal[0] || servers.keys().next().value;
    servers.delete(victim.id || victim);
  }
}

// All managed servers, newest first (same listing convention as downloads.js).
export function listLlamaServers() {
  sweepFinishedServers();
  return [...servers.values()]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map(toPublicServer);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

// Resolve the llama-server executable. Delegates to engines.js so PATH and the
// owner-managed ~/.or/bin folders stay one source of truth for "installed".
export function resolveLlamaServerBinary() {
  return findLlamaServerBinary();
}

// The owner can pin a specific llama-server in the Local Models settings card.
// Accepted only when it is an absolute path to a file that exists; spawn is
// still argv + shell:false, so nothing here is ever shell-expanded.
function resolveConfiguredBinary(binaryPath) {
  if (typeof binaryPath !== "string" || !binaryPath.trim()) return null;
  try {
    const candidate = path.resolve(binaryPath.trim());
    if (!path.isAbsolute(candidate)) return null;
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

// Log destination: <DATA_DIR>/logs/llama-server-<port>.log. Appended per launch
// with a banner, so repeated runs on the same port keep their history.
function openLogFile(port, argv) {
  const logsDir = path.join(getDataDir(), "logs");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // The write stream below surfaces the real error if the dir is unusable.
  }
  const logFile = path.join(logsDir, `llama-server-${port}.log`);
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  // Logging is best-effort: a deleted logs folder or a full disk degrades to
  // lost log lines — it must never surface as an uncaught exception and take
  // the server manager down with it.
  stream.on("error", () => { /* log write lost — serving continues */ });
  stream.write(`\n[${new Date().toISOString()}] launch llama-server ${argv.join(" ")}\n`);
  return { logFile, stream };
}

// Poll /health until the server answers 200 (model loaded) or we run out of
// time/process. While the model loads llama.cpp answers 503 — that is "keep
// waiting", not an error.
async function waitForHealth(server) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.status === "stopping") return false; // stopLlamaServer won the race
    if (isTerminal(server)) return false; // child died on its own

    const url = server.healthUrl;
    assertLoopbackUrl(url, server.port);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (res.ok) return true; // 200 → model loaded, server ready
      // 503 = still loading; anything else persistent falls out via timeout.
    } catch {
      // Connection refused (server not listening yet) or probe timeout — keep
      // polling; the overall deadline and the child's exit event are the real
      // failure detectors.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}

// Start a llama-server for one GGUF. Never throws — see the module header.
//   { modelPath, port = 8080, ctxSize = 4096, host, binaryPath, gpuLayers }
// port/ctxSize/gpuLayers default to the values saved on the Local Models page;
// binaryPath (optional) overrides PATH discovery with a pinned executable.
export async function startLlamaServer({ modelPath, port, ctxSize, host, name, binaryPath, gpuLayers } = {}) {
  try {
    // 1. Binary. Without it nothing else matters — the message doubles as the
    //    download hint the UI shows.
    const binary = resolveConfiguredBinary(binaryPath) || resolveLlamaServerBinary();
    if (!binary) {
      return {
        ok: false,
        error: "llama.cpp not installed — download a Windows release from github.com/ggml-org/llama.cpp/releases and place llama-server.exe (with its DLLs) in ~/.or/bin/llama.cpp",
      };
    }

    // 2. Inputs. All validators throw plain Errors with human messages, mapped
    //    to { ok:false } below — callers never see a throw from here.
    assertLoopbackHost(host);
    const safePort = sanitizePort(port);
    const safeCtx = sanitizeCtx(ctxSize);
    const safeGpuLayers = sanitizeGpuLayers(gpuLayers);
    const safeModelPath = assertServeModelPath(modelPath);

    if ([...servers.values()].some((s) => !isTerminal(s) && s.port === safePort)) {
      return { ok: false, error: `A llama-server is already starting or running on port ${safePort}` };
    }

    // 3. The argv array — module constants plus the validated values above,
    //    nothing else. spawn is called with shell:false explicitly: the array
    //    form plus no shell is the whole security story.
    const argv = [
      "-m", safeModelPath,
      "--host", LLAMA_BIND_HOST,
      "--port", String(safePort),
      "-c", String(safeCtx),
    ];
    // Only pass the flag when the owner set it: llama.cpp's own default (all
    // layers on GPU when it can) is the right answer when nothing is configured.
    if (safeGpuLayers !== null) argv.push("--n-gpu-layers", String(safeGpuLayers));

    const { logFile, stream } = openLogFile(safePort, argv);

    let child;
    try {
      child = spawn(binary, argv, {
        // cwd at the binary's own folder so its DLL siblings resolve the way
        // they do when launched from Explorer — not a security boundary, just
        // how the release zip expects to be laid out.
        cwd: path.dirname(binary),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false, // explicit: argv array only, never a shell string
      });
    } catch (err) {
      stream.end();
      return { ok: false, error: `Failed to start llama-server: ${err?.message || err}` };
    }

    const id = `lsv-${Date.now().toString(36)}-${(serverSeq++).toString(36)}`;
    const origin = `http://${LLAMA_BIND_HOST}:${safePort}`;
    const server = {
      id,
      modelPath: safeModelPath,
      modelName: (typeof name === "string" && name.trim()) || path.basename(safeModelPath, ".gguf"),
      port: safePort,
      host: LLAMA_BIND_HOST,
      ctxSize: safeCtx,
      gpuLayers: safeGpuLayers,
      status: "starting",
      error: null,
      child,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      endpoint: `${origin}/v1/chat/completions`,
      healthUrl: `${origin}/health`,
      logFile,
    };
    servers.set(id, server);
    boundServers();

    // Mirror child output into the log file so failures are diagnosable
    // (missing DLLs, a bad GGUF, an occupied port — all show up here).
    child.stdout?.on("data", (chunk) => stream.write(chunk));
    child.stderr?.on("data", (chunk) => stream.write(chunk));

    // Async spawn failures (ENOENT for a binary deleted between the fs check
    // and spawn, image format errors) arrive here, not as a throw.
    child.on("error", (err) => {
      stream.end();
      finishServer(server, "failed", `llama-server failed to start: ${err?.message || err}`);
    });

    child.on("close", (code, signal) => {
      server.child = null;
      stream.end(`[${new Date().toISOString()}] llama-server exited (code=${code} signal=${signal})\n`);
      if (server.status === "stopping") finishServer(server, "stopped");
      else if (!isTerminal(server)) {
        finishServer(server, "failed", `llama-server exited unexpectedly (code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}) — see ${logFile}`);
      }
    });

    // 4. Health wait. The record is already in the map as "starting", so a
    //    concurrent listLlamaServers() sees it while the model loads.
    const healthy = await waitForHealth(server);
    if (!healthy) {
      if (!isTerminal(server) && server.status !== "stopping") {
        // Never leave a zombie behind: kill the child, then report. The close
        // handler finalizes the record.
        try { child.kill(); } catch { /* already gone */ }
        return { ok: false, error: `llama-server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s — see ${logFile}` };
      }
      const record = servers.get(id);
      return { ok: false, error: record?.error || "llama-server stopped before becoming healthy" };
    }

    server.status = "running";
    return { ok: true, server: toPublicServer(server) };
  } catch (err) {
    // Validation and unexpected errors share one exit: a result object, never
    // a throw (fire-and-forget callers must not produce unhandled rejections).
    return { ok: false, error: String(err?.message || err) };
  }
}

// Stop a managed server. Resolves once the process is (or already was) gone.
export async function stopLlamaServer(id) {
  const server = servers.get(id);
  if (!server) return { ok: false, error: "Unknown llama-server id" };
  if (isTerminal(server)) return { ok: true, server: toPublicServer(server) }; // idempotent

  // "stopping" makes the health wait stand down and the close handler
  // finalize the record as "stopped" instead of "failed".
  server.status = "stopping";

  const child = server.child;
  if (!child) {
    // Process already exited; the close event may still be in flight.
    finishServer(server, "stopped");
    return { ok: true, server: toPublicServer(server) };
  }

  await new Promise((resolve) => {
    const done = () => resolve();
    // kill() on win32 is TerminateProcess — this is a process we spawned and
    // own; no unrelated process is ever touched because we hold its handle.
    try { child.kill(); } catch { /* already dead */ }
    child.once("close", done);
    setTimeout(done, 5000).unref?.(); // belt-and-braces: never hang the stop call
  });

  finishServer(server, "stopped");
  return { ok: true, server: toPublicServer(server) };
}

// ── chat proxy ───────────────────────────────────────────────────────────────

// One non-streaming chat completion against a managed server's
// OpenAI-compatible endpoint. This is the deliberate loopback exception (see
// module header): the URL is built from the server's own recorded port and
// re-verified against http://127.0.0.1:<port> before the request fires.
//   { id, message, maxTokens }
export async function chatWithLlamaServer({ id, message, maxTokens } = {}) {
  const server = servers.get(id);
  if (!server) return { ok: false, error: "Unknown llama-server id" };
  if (server.status !== "running") {
    return { ok: false, error: `Server is ${server.status}, not running` };
  }
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, error: "A message is required" };
  }
  const text = message.trim().slice(0, MAX_MESSAGE_CHARS);
  const cap = Number.isInteger(Number(maxTokens)) && Number(maxTokens) > 0
    ? Math.min(Number(maxTokens), 2048)
    : DEFAULT_CHAT_MAX_TOKENS;

  const url = server.endpoint;
  try {
    assertLoopbackUrl(url, server.port);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: text }],
          stream: false,
          max_tokens: cap,
        }),
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `llama-server responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") {
      return { ok: false, error: "Unexpected response shape from llama-server" };
    }
    return { ok: true, reply, model: typeof data?.model === "string" ? data.model : server.modelName };
  } catch (err) {
    return { ok: false, error: `Chat request failed: ${err?.message || err}` };
  }
}
