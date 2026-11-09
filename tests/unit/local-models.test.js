// Unit tests for the Local Models feature (src/lib/localModels/).
//
// Coverage:
//   • registerLocalFile validation — bad extension rejected, missing file
//     rejected, happy path records the path without copying anything.
//   • Download job state machine — ollama pull running→done via spawn events
//     (spawn mocked), cancel kills the child, HF stream writes bytes and lands
//     done (fetch mocked with a real Response body).
//   • Search normalization — Hugging Face API rows normalized, Ollama library
//     HTML parsed with curated fallback, unified search merged + tagged.
//   • Engine probes fail open — connection refused / HTTP errors / missing
//     models endpoint all degrade to { ok:false, models:[] } instead of throwing.
//
// Hermeticity: global fetch is mocked; node:dns is mocked so the repo's real
// SSRF guard (used by search + HF downloads) never does a live lookup. The DB
// runs on a real SQLite file in a temp DATA_DIR, following the pattern of
// db-null-byte-params.test.js.

import fs from "node:fs";
import os from "node:os";
import path from "path";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// Repo SSRF guard does DNS resolution on non-literal hosts — point it at a
// public address so tests never touch the network.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

// child_process.spawn is mocked for the ollama pull path: tests drive the fake
// child's events (error/close) instead of launching a real process.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// Temp DATA_DIR for the whole file — must be set BEFORE any module import that
// touches src/lib/dataDir.js (its module-level DATA_DIR const is computed at
// import time).
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "or-local-models-"));
process.env.DATA_DIR = TEMP_ROOT;
const MODELS_DIR = path.join(TEMP_ROOT, "models");

const originalDataDir = process.env.ORIGINROUTER_DATA_DIR;
delete process.env.ORIGINROUTER_DATA_DIR;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  // Module-scope scratch dir (HF download bytes land here).
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* tmp best effort */ }
});

// ---------------------------------------------------------------------------
// Engine probes — fail-open contract
// ---------------------------------------------------------------------------
describe("engine probes fail open", () => {
  let engines;

  beforeEach(async () => {
    vi.resetModules();
    engines = await import("../../src/lib/localModels/engines.js");
  });

  it("returns ok:false with an empty list when the connection is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
    }));
    const out = await engines.probeOllama();
    expect(out.ok).toBe(false);
    expect(out.models).toEqual([]);
    expect(typeof out.error).toBe("string");
  });

  it("reports a non-200 response as offline instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const lm = await engines.probeLmStudio();
    expect(lm.ok).toBe(false);
    expect(lm.models).toEqual([]);
  });

  it("maps an aborted request to a Timed out failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }));
    const out = await engines.probeLlamaCpp();
    expect(out.ok).toBe(false);
    expect(out.error).toBe("Timed out");
  });

  it("keeps a healthy llama.cpp alive when /v1/models is missing", async () => {
    // /health answers 200; the models endpoint 404s on older builds — health
    // wins, models degrade to an empty list.
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/health")) return { ok: true, status: 200 };
      return { ok: false, status: 404 };
    }));
    const out = await engines.probeLlamaCpp();
    expect(out.ok).toBe(true);
    expect(out.models).toEqual([]);
  });

  it("normalizes an Ollama /api/tags payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: "qwen2.5-coder:7b", size: 4700000000, modified_at: "2026-01-02T03:04:05Z" },
          { name: "llama3:latest" },
        ],
      }),
    })));
    const out = await engines.probeOllama();
    expect(out.ok).toBe(true);
    expect(out.models[0]).toEqual({
      name: "qwen2.5-coder:7b",
      size: 4700000000,
      modified: "2026-01-02T03:04:05Z",
    });
    expect(out.models[1].size).toBe(null);
  });

  it("normalizes an LM Studio /v1/models payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen2.5-7b-instruct" }, { id: "e5-mistral" }] }),
    })));
    const out = await engines.probeLmStudio();
    expect(out.ok).toBe(true);
    expect(out.models).toEqual([{ id: "qwen2.5-7b-instruct" }, { id: "e5-mistral" }]);
  });

  it("never probes anything except the hard-coded 127.0.0.1 endpoints", async () => {
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      seen.push(String(url));
      return { ok: false, status: 404 };
    }));
    await engines.probeAllEngines();
    // Every URL must be one of the three known local origins — the local-engine
    // exception must not be wide enough to hit anything else.
    const allowed = [
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:1234/v1/models",
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/v1/models",
    ];
    for (const url of seen) expect(allowed).toContain(url);
  });
});

// ---------------------------------------------------------------------------
// Search — normalization + fail-open fallbacks
// ---------------------------------------------------------------------------
describe("search normalization", () => {
  let search;

  beforeEach(async () => {
    vi.resetModules();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    search = await import("../../src/lib/localModels/search.js");
  });

  it("normalizes Hugging Face rows into the shared shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        id: "bartowski/Llama-3.2-1B-Instruct-GGUF",
        author: "bartowski",
        downloads: 123456,
        likes: 42,
        pipeline_tag: "text-generation",
        lastModified: "2026-02-03T04:05:06.000Z",
        tags: ["gguf", "llama"],
      },
      { /* row without id — dropped */ },
    ]), { status: 200, headers: { "content-type": "application/json" } })));

    const out = await search.searchHuggingFace("llama", { limit: 10 });
    expect(out.source).toBe("huggingface");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toEqual({
      source: "huggingface",
      id: "bartowski/Llama-3.2-1B-Instruct-GGUF",
      author: "bartowski",
      downloads: 123456,
      likes: 42,
      pipelineTag: "text-generation",
      lastModified: "2026-02-03T04:05:06.000Z",
      tags: ["gguf", "llama"],
    });
  });

  it("fail-opens to an empty list + note when the HF API is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network dead"); }));
    const out = await search.searchHuggingFace("llama");
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/failed/i);
  });

  it("parses the Ollama library HTML into tagged rows", async () => {
    const html = `
      <div><a href="/library/llama3.2">Llama 3.2</a>
        <p>Meta's compact 3B and 1B models for on-device use.</p>
        <span>2.0GB</span><span>1.3GB</span></div>
      <div><a href="/library/qwen2.5-coder">Qwen2.5 Coder</a>
        <p>Code specific Qwen models.</p><span>4.7GB</span></div>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));
    const out = await search.searchOllamaLibrary("coder");
    expect(out.results.some((r) => r.id === "qwen2.5-coder")).toBe(true);
    const coder = out.results.find((r) => r.id === "qwen2.5-coder");
    expect(coder.source).toBe("ollama");
    expect(coder.description).toMatch(/Code specific/);
  });

  it("falls back to the curated list when the library page cannot be parsed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>totally redesigned</html>", { status: 200 })));
    const out = await search.searchOllamaLibrary("");
    expect(out.note).toMatch(/curated/i);
    const ids = out.results.map((r) => r.id);
    for (const family of ["llama3", "qwen2.5", "qwen2.5-coder", "deepseek-r1", "mistral", "gemma2", "phi4", "llava"]) {
      expect(ids).toContain(family);
    }
  });

  it("merges all three sources with tags in searchLocal", async () => {
    let call = 0;
    const urls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      call += 1;
      urls.push(String(url));
      if (String(url).includes("huggingface.co")) {
        // The gguf shelf returns the same repo the plain search does, so the
        // dedupe (one row per source:id) is exercised too.
        return new Response(JSON.stringify([{ id: "owner/repo-gguf", downloads: 5, likes: 1 }]), { status: 200 });
      }
      return new Response('<a href="/library/qwen2.5">Qwen 2.5</a><p>Qwen general models.</p>', { status: 200 });
    }));

    const out = await search.searchLocal("qwen", { limit: 10 });
    expect(out.notes.length).toBe(0);
    const sources = out.results.map((r) => r.source);
    expect(sources).toContain("huggingface");
    expect(sources).toContain("ollama");
    // Every row keeps a source tag the download path understands.
    for (const row of out.results) expect(["huggingface", "ollama"]).toContain(row.source);
    // The llama.cpp shelf rides the HF host with the gguf filter, and its rows
    // are tagged library:"llamacpp" so the UI can badge them apart.
    expect(urls.some((u) => u.includes("filter=gguf"))).toBe(true);
    expect(call).toBe(3); // exactly one request per source
  });

  it("the llama.cpp shelf only returns gguf-tagged rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify([{ id: "owner/qwen-gguf", downloads: 9, likes: 2 }]),
      { status: 200 },
    )));
    const out = await search.searchLlamaCppLibrary("qwen");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ library: "llamacpp", format: "gguf", source: "huggingface" });
  });
});

// ---------------------------------------------------------------------------
// registerLocalFile — validation against a real temp SQLite DB
// ---------------------------------------------------------------------------
describe("registerLocalFile", () => {
  let tempDir;
  const savedDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    // Fresh DATA_DIR + fresh module registry per test so the db driver opens a
    // brand-new SQLite file (same pattern as db-null-byte-params.test.js).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "or-lm-registry-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    process.env.DATA_DIR = savedDataDir;
  });

  it("rejects unsupported extensions with the accepted list in the message", async () => {
    const { registerLocalFile } = await import("../../src/lib/localModels/registry.js");
    await expect(registerLocalFile({ path: "some/model.txt" })).rejects.toThrow(/Unsupported file type/);
    await expect(registerLocalFile({ path: "some/model.part" })).rejects.toThrow(/\.gguf/);
  });

  it("rejects a path that does not exist", async () => {
    const { registerLocalFile } = await import("../../src/lib/localModels/registry.js");
    await expect(
      registerLocalFile({ path: path.join(tempDir, "missing.gguf") })
    ).rejects.toThrow(/File not found/);
  });

  it("rejects a directory that merely has the right extension", async () => {
    const { registerLocalFile } = await import("../../src/lib/localModels/registry.js");
    const dir = path.join(tempDir, "fake.gguf");
    fs.mkdirSync(dir);
    await expect(registerLocalFile({ path: dir })).rejects.toThrow(/not a file/);
  });

  it("registers an existing gguf file in place and records its size", async () => {
    const { registerLocalFile, listLocalModels } = await import("../../src/lib/localModels/registry.js");
    const modelPath = path.join(tempDir, "qwen2.5-7b-q4_k_m.gguf");
    fs.writeFileSync(modelPath, Buffer.alloc(2048, 1));

    const model = await registerLocalFile({ path: modelPath, name: "Qwen 2.5 7B" });
    expect(model.name).toBe("Qwen 2.5 7B");
    expect(model.source).toBe("file");
    expect(model.path).toBe(path.resolve(modelPath));
    expect(model.sizeBytes).toBe(2048);
    expect(model.addedAt).toBeTruthy();

    // Nothing was copied: the original file is still exactly where it was.
    expect(fs.existsSync(modelPath)).toBe(true);
    expect(fs.readdirSync(tempDir)).toContain("qwen2.5-7b-q4_k_m.gguf");

    // And it shows up in the listing.
    const listed = await listLocalModels();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(model.id);
  });

  it("derives the name from the basename when none is given", async () => {
    const { registerLocalFile } = await import("../../src/lib/localModels/registry.js");
    const modelPath = path.join(tempDir, "llama-3-8b.safetensors");
    fs.writeFileSync(modelPath, "x");
    const model = await registerLocalFile({ path: modelPath });
    expect(model.name).toBe("llama-3-8b");
  });

  it("removeLocalModel deletes only the DB row, never the file", async () => {
    const { registerLocalFile, removeLocalModel } = await import("../../src/lib/localModels/registry.js");
    const modelPath = path.join(tempDir, "tiny.bin");
    fs.writeFileSync(modelPath, "abc");
    const model = await registerLocalFile({ path: modelPath });

    expect(await removeLocalModel(model.id)).toBe(true);
    expect(await removeLocalModel(model.id)).toBe(false); // already gone
    expect(fs.existsSync(modelPath)).toBe(true); // file untouched
  });
});

// ---------------------------------------------------------------------------
// Download manager — job state machine, cancel, validation, TTL sweep
// ---------------------------------------------------------------------------
describe("download jobs", () => {
  let downloads;

  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    downloads = await import("../../src/lib/localModels/downloads.js");
  });

  it("rejects invalid input before anything is spawned or fetched", () => {
    expect(() => downloads.startDownload({ source: "ftp", id: "x" })).toThrow(/Unsupported download source/);
    expect(() => downloads.startDownload({ source: "ollama", id: "a b; rm -rf" })).toThrow(/Invalid Ollama model id/);
    expect(() => downloads.startDownload({ source: "huggingface", id: "no-slash" })).toThrow(/Invalid Hugging Face repo id/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs the ollama state machine running → done with an argv-array spawn", async () => {
    const job = downloads.startDownload({ source: "ollama", id: "qwen2.5-coder:7b" });
    // spawn got the command as an ARGV ARRAY — never a shell string.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("ollama.exe"); // win32 test host prefers the .exe
    expect(args).toEqual(["pull", "qwen2.5-coder:7b"]);

    const running = downloads.listDownloads().find((j) => j.id === job.id);
    expect(running.status).toBe("running");

    // Simulate a successful pull.
    spawnMock.mock.results[0].value.emit("close", 0, null);
    const done = downloads.listDownloads().find((j) => j.id === job.id);
    expect(done.status).toBe("done");
    expect(done.error).toBe(null);
  });

  it("fails the job with an install hint when ollama is missing (ENOENT)", async () => {
    const job = downloads.startDownload({ source: "ollama", id: "llama3" });
    const child = spawnMock.mock.results[0].value;
    child.emit("error", Object.assign(new Error("spawn ollama.exe ENOENT"), { code: "ENOENT" }));
    const failed = downloads.listDownloads().find((j) => j.id === job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/not installed/i);
  });

  it("cancel kills the child and survives the subsequent close event", async () => {
    const job = downloads.startDownload({ source: "ollama", id: "gemma2:9b" });
    const child = spawnMock.mock.results[0].value;

    const cancelled = downloads.cancelDownload(job.id);
    expect(cancelled.status).toBe("cancelled");
    expect(child.kill).toHaveBeenCalled();

    // The process dying after the cancel must not flip the job to failed.
    child.emit("close", null, "SIGTERM");
    const after = downloads.listDownloads().find((j) => j.id === job.id);
    expect(after.status).toBe("cancelled");
  });

  it("streams an HF GGUF file with progress and lands done", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/api/models/")) {
        // Metadata: repo file listing. The picker must choose the plain GGUF.
        return new Response(JSON.stringify({
          siblings: [
            { rfilename: "readme.md" },
            { rfilename: "model-00001-of-00002.gguf" },
            { rfilename: "model-q4_k_m.gguf" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("0123456789", { status: 200, headers: { "content-length": "10" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const job = downloads.startDownload({ source: "huggingface", id: "owner/repo", destDir: MODELS_DIR });
    expect(job.status).toBe("queued");

    await vi.waitFor(() => {
      const current = downloads.listDownloads().find((j) => j.id === job.id);
      expect(current.status).toBe("done");
    }, { timeout: 5000 });

    const done = downloads.listDownloads().find((j) => j.id === job.id);
    expect(done.bytesDone).toBe(10);
    expect(done.bytesTotal).toBe(10);
    expect(done.file).toContain("model-q4_k_m.gguf");
    expect(fs.readFileSync(done.file, "utf-8")).toBe("0123456789");

    // Only huggingface.co was ever contacted, over https.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/huggingface\.co\//);
    }
  });

  it("fails cleanly when the repo has no GGUF file to download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      siblings: [{ rfilename: "pytorch_model.bin" }],
    }), { status: 200 })));

    const job = downloads.startDownload({ source: "huggingface", id: "owner/repo", destDir: MODELS_DIR });
    await vi.waitFor(() => {
      const current = downloads.listDownloads().find((j) => j.id === job.id);
      expect(current.status).toBe("failed");
    }, { timeout: 5000 });
    const failed = downloads.listDownloads().find((j) => j.id === job.id);
    expect(failed.error).toMatch(/No GGUF file/);
  });

  it("sweeps finished jobs out of memory after the 1h TTL", async () => {
    vi.useFakeTimers();
    try {
      const fresh = await import("../../src/lib/localModels/downloads.js");
      fresh.startDownloadSweeper();
      const job = fresh.startDownload({ source: "ollama", id: "phi4" });
      spawnMock.mock.results[0].value.emit("close", 0, null);
      expect(fresh.listDownloads()).toHaveLength(1);

      // Past the TTL, the sweeper interval drops the finished job.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      const ids = fresh.listDownloads().map((j) => j.id);
      expect(ids).not.toContain(job.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
