// Local model download manager.
//
// Two download strategies sit behind one job model:
//   • source "ollama"     → `ollama pull <id>` via child_process.spawn, always
//                           invoked as an ARGV ARRAY (never a shell string) so
//                           no metacharacter in a model id can ever become a
//                           command.
//   • source "huggingface"→ a GGUF file fetched over https://huggingface.co
//                           (host-allowlisted + SSRF-guarded) and streamed to
//                           <DATA_DIR>/models with byte-level progress.
//
// Jobs live in a bounded in-memory map — downloads survive a dashboard refresh
// because the OS process (spawn or stream) keeps running, but they are
// intentionally not persisted: a server restart orphans them either way, and a
// stale progress bar is worse than an honest empty list.
//
// Fail-open: every entry point validates and degrades — bad input becomes a
// failed job (or a thrown *validation* error the route maps to 400), a missing
// ollama binary becomes a failed job with a human message, never a crash.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchPublic, assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { getDataDir } from "@/lib/dataDir.js";

// Where downloads land. Reuses the repo's DATA_DIR resolution (~/.or unless
// overridden), with a `models` folder of our own. Computed lazily so tests can
// point DATA_DIR somewhere temporary before the first call.
export function getModelsDir(destDir) {
  const dir = destDir || path.join(getDataDir(), "models");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // The spawn/stream path will surface the real write error if the folder
    // truly cannot be created; don't fail the start because mkdir sneezed.
  }
  return dir;
}

// The only hosts a Hugging Face download may ever touch. Exact host match, and
// the SSRF guard re-checks every redirect hop (HF "resolve" URLs bounce to a
// CDN, so redirect re-validation is load-bearing here, not paranoia).
export const HF_DOWNLOAD_ALLOWED_HOSTS = new Set(["huggingface.co"]);

// Bounded job log. Finished jobs linger for an hour (TTL sweep below) so the
// user can see what happened, then are dropped; the map itself is capped so a
// pathological session cannot grow it without limit.
const MAX_JOBS = 50;
const FINISHED_TTL_MS = 60 * 60 * 1000; // 1h

const jobs = new Map();
let jobSeq = 0;

// Validation helpers ---------------------------------------------------------

// Ollama model ids: `name[:tag]`, optionally `namespace/name[:tag]`. Tags may
// contain letters, digits, dot, dash, underscore (e.g. `qwen2.5-coder:7b-instruct-q4_K_M`).
// The list itself is case-sensitive upstream, so we allow uppercase too.
const OLLAMA_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._\-]*(?:\/[A-Za-z0-9][A-Za-z0-9._\-]*)?(?::[A-Za-z0-9._\-]+)?$/;

// HF repo ids: `owner/repo` (the search API always returns this shape).
const HF_REPO_REGEX = /^[A-Za-z0-9][A-Za-z0-9._\-]*\/[A-Za-z0-9][A-Za-z0-9._\-]*$/;

// File basename for the streamed download: no separators, no traversal, no
// funny business — it only ever becomes `path.join(dir, basename)`.
function safeBasename(name, fallback) {
  const base = path.basename(String(name || fallback || "")).trim();
  if (!base || base === "." || base === "..") return fallback;
  if (/[\\/:*?"<>|\0]/.test(base)) return fallback;
  return base;
}

// Job record shape. `controller` (AbortController for HF) and `child` (spawn
// handle for Ollama) are internal-only — stripped before a job leaves this
// module via toPublicJob().
function newJob({ source, model }) {
  const id = `lm-${Date.now().toString(36)}-${(jobSeq++).toString(36)}`;
  const job = {
    id,
    source, // "huggingface" | "ollama"
    model, // ollama id or HF repo id (+ file)
    status: "queued", // queued | running | done | failed | cancelled
    bytesDone: 0,
    bytesTotal: null,
    error: null,
    file: null, // destination path once known
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  boundJobs();
  return job;
}

// Keep the map bounded: drop oldest FINISHED jobs first; if everything is
// active (pathological), drop the oldest job of all rather than grow forever.
function boundJobs() {
  while (jobs.size > MAX_JOBS) {
    const terminal = [...jobs.values()].filter((j) => isTerminal(j));
    const victim = terminal[0] || jobs.keys().next().value;
    jobs.delete(victim.id || victim);
  }
}

function isTerminal(job) {
  return job.status === "done" || job.status === "failed" || job.status === "cancelled";
}

function finishJob(job, status, error = null) {
  if (isTerminal(job)) return; // first terminal state wins (cancel vs error race)
  job.status = status;
  job.error = error;
  job.finishedAt = new Date().toISOString();
}

// Start a download. Throws a plain Error for caller mistakes (bad input the
// route maps to 400); runtime failures (binary missing, network dead) become
// failed jobs instead, so the UI shows the failure where the download began.
//   { source: "ollama"|"huggingface", id, destDir?, file? }
//   • ollama      id = model name ("qwen2.5-coder:7b")
//   • huggingface id = "owner/repo"; `file` optionally pins a GGUF filename —
//                   without it we ask the HF API for the repo's file list and
//                   pick a sensible single-file GGUF (shard parts are skipped).
export function startDownload({ source, id, destDir, file } = {}) {
  if (source === "ollama") {
    if (typeof id !== "string" || !OLLAMA_ID_REGEX.test(id)) {
      throw new Error("Invalid Ollama model id");
    }
    const job = newJob({ source, model: id });
    runOllamaPull(job, destDir);
    return toPublicJob(job);
  }

  if (source === "huggingface") {
    if (typeof id !== "string" || !HF_REPO_REGEX.test(id)) {
      throw new Error("Invalid Hugging Face repo id (expected owner/repo)");
    }
    const job = newJob({ source, model: id });
    // fire-and-forget: progress lands in the job map, failures land in the job.
    runHuggingFaceDownload(job, { destDir, file }).catch((err) => {
      finishJob(job, "failed", String(err?.message || err));
    });
    return toPublicJob(job);
  }

  throw new Error(`Unsupported download source: ${String(source)}`);
}

// --- Ollama path ------------------------------------------------------------

// Resolve the ollama executable. On Windows, npm/shim installers expose
// `ollama.cmd`, which plain spawn cannot execute without a shell — and a shell
// is exactly what this module promises never to use. The official installer
// ships `ollama.exe`, so on win32 we prefer the .exe and fall back to the bare
// name; elsewhere the bare name is the right answer.
function ollamaCommand() {
  return process.platform === "win32" ? "ollama.exe" : "ollama";
}

// Spawn `ollama pull <model>` (argv array, NO shell) and mirror its lifecycle
// into the job. Progress parsing is intentionally minimal — ollama prints
// human-readable progress on stdout/stderr, but the job's own state machine
// (running → done/failed) is what the UI needs.
function runOllamaPull(job, destDir) {
  job.status = "running";
  let child;
  try {
    child = spawn(ollamaCommand(), ["pull", job.model], {
      // cwd: models dir when we have one — ollama ignores it, but it keeps the
      // child from inheriting a deleted working directory.
      cwd: destDir || undefined,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Synchronous spawn failures (e.g. executable unreadable) land here.
    finishJob(job, "failed", `Failed to start ollama: ${err?.message || err}`);
    return;
  }
  job.child = child;

  // Asynchronous spawn failures (ENOENT when ollama is not installed) arrive
  // through the 'error' event, not the throw above.
  child.on("error", (err) => {
    finishJob(job, "failed", err?.code === "ENOENT"
      ? "Ollama is not installed or not on PATH — install it from ollama.com"
      : `ollama error: ${err?.message || err}`);
  });

  // Drain output so a chatty pull cannot backpressure the pipe. Keep the tail
  // for the error message when the pull fails.
  let lastLine = "";
  const onChunk = (chunk) => {
    const text = String(chunk);
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length) lastLine = lines[lines.length - 1].slice(0, 200);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  child.on("close", (code, signal) => {
    job.child = null;
    if (job.status === "cancelled") return; // cancel already finalized the job
    if (code === 0) finishJob(job, "done");
    else if (signal) finishJob(job, "failed", `ollama pull terminated (${signal})`);
    else finishJob(job, "failed", `ollama pull exited with code ${code}${lastLine ? `: ${lastLine}` : ""}`);
  });
}

// --- Hugging Face path ------------------------------------------------------

// Pick a GGUF file from a repo's file list (HF API `siblings`). Preference
// order: a plain single-file GGUF (no shard numbering), then any GGUF. This is
// deliberately "curated" rather than clever — multi-shard downloads need join
// logic the dashboard does not have, so we pick a file that works standalone.
function pickGgufFile(siblings) {
  if (!Array.isArray(siblings)) return null;
  const ggufs = siblings
    .map((s) => (typeof s?.rfilename === "string" ? s.rfilename : null))
    .filter((name) => name && name.toLowerCase().endsWith(".gguf"));
  if (!ggufs.length) return null;
  const plain = ggufs.find((name) => !/\d{5}-of-\d{5}/.test(name));
  return plain || ggufs[0];
}

// Validate a download URL: https + exact allowlist + SSRF guard. Throws on any
// mismatch — callers wrap in try/catch and fail the job.
function assertDownloadUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") throw new Error("Download URL must be https");
  if (!HF_DOWNLOAD_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Download host ${parsed.hostname} is not allowed`);
  }
  assertPublicUrl(parsed.toString());
}

// Stream a HF GGUF file to disk with byte progress. The AbortController gives
// cancelDownload() a real kill switch for the in-flight stream. The job stays
// "queued" while we resolve which file to fetch; "running" begins when the
// byte stream itself does.
async function runHuggingFaceDownload(job, { destDir, file }) {
  job.controller = new AbortController();

  const dir = getModelsDir(destDir);

  // Resolve which file to fetch when the caller did not pin one.
  let fileName = file ? safeBasename(file, null) : null;
  if (!fileName) {
    const metaUrl = `https://huggingface.co/api/models/${job.model}`;
    assertDownloadUrl(metaUrl);
    const metaRes = await fetchPublic(metaUrl, { signal: job.controller.signal, headers: { Accept: "application/json" } });
    if (!metaRes.ok) throw new Error(`Hugging Face metadata responded ${metaRes.status}`);
    const meta = await metaRes.json();
    fileName = safeBasename(pickGgufFile(meta?.siblings), null);
    if (!fileName) throw new Error(`No GGUF file found in ${job.model} — open the repo and pass a file name`);
  }

  const destPath = path.join(dir, fileName);
  job.file = destPath;

  const downloadUrl = `https://huggingface.co/${job.model}/resolve/main/${fileName.split("/").map(encodeURIComponent).join("/")}`;
  assertDownloadUrl(downloadUrl);

  // Byte streaming begins — the queued phase is over.
  job.status = "running";
  const res = await fetchPublic(downloadUrl, {
    signal: job.controller.signal,
    headers: { Accept: "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`Hugging Face download responded ${res.status}`);
  if (!res.body) throw new Error("Download response has no body to stream");

  job.bytesTotal = Number(res.headers.get("content-length")) || null;

  // Node streams are the natural pipe target for a file. `Readable.fromWeb`
  // bridges the fetch body; `pipeline` propagates aborts as clean errors and
  // closes the file handle even when we bail midway.
  let bytes = 0;
  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => {
    bytes += chunk.length;
    job.bytesDone = bytes;
  });
  await pipeline(source, fs.createWriteStream(destPath));
  job.bytesDone = bytes;
  finishJob(job, "done");
}

// Public snapshot of a job — internal handles (child, controller) stay inside.
function toPublicJob(job) {
  return {
    id: job.id,
    source: job.source,
    model: job.model,
    status: job.status,
    bytesDone: job.bytesDone,
    bytesTotal: job.bytesTotal,
    error: job.error,
    file: job.file,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

// Cancel a job. Works for both strategies: kills the ollama child, aborts the
// HF stream. Returns the post-cancel job, or null when the id is unknown.
// Cancelling an already-finished job is a no-op that returns its state.
export function cancelDownload(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (isTerminal(job)) return toPublicJob(job);

  if (job.child) {
    try { job.child.kill(); } catch { /* already dead — close handler finalizes */ }
  }
  if (job.controller) {
    try { job.controller.abort(new Error("cancelled")); } catch { /* stream already settled */ }
  }
  finishJob(job, "cancelled");
  return toPublicJob(job);
}

// All jobs, newest first. Sweeps first so TTL'd entries disappear without
// waiting for the interval.
export function listDownloads() {
  sweepFinishedDownloads();
  return [...jobs.values()]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map(toPublicJob);
}

// TTL sweep: finished jobs older than the TTL are forgotten. Exported for
// tests; also invoked lazily by listDownloads and by a low-frequency interval
// below so a long-lived server keeps memory flat even with no page open.
export function sweepFinishedDownloads(nowMs = Date.now()) {
  for (const [id, job] of jobs) {
    if (!isTerminal(job) || !job.finishedAt) continue;
    const finishedMs = Date.parse(job.finishedAt);
    if (Number.isFinite(finishedMs) && nowMs - finishedMs > FINISHED_TTL_MS) {
      jobs.delete(id);
    }
  }
  return jobs.size;
}

// One lazy sweeper for the process lifetime. unref'd so it never keeps the
// server alive just to sweep; guarded so repeated calls cannot stack timers.
let sweeperStarted = false;
export function startDownloadSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const timer = setInterval(() => {
    try { sweepFinishedDownloads(); } catch { /* sweep must never crash the process */ }
  }, 10 * 60 * 1000);
  timer.unref?.();
}
