// Unit tests for the managed llama.cpp backend (src/lib/localModels/llamaServer.js).
//
// Coverage:
//   • Binary resolution — PATH first, then the owner-managed ~/.or/bin/llama.cpp
//     and ~/.or/bin drop folders; a clear refusal (and NO spawn) when the
//     binary is missing entirely.
//   • Argv-array spawn contract — llama-server is launched with an ARGV ARRAY
//     built only from constants and validated values, with shell:false set
//     explicitly. Never a shell string.
//   • Input validation — non-GGUF paths, missing files, non-loopback hosts and
//     out-of-range ports/ctx are refused before anything spawns.
//   • Health-wait logic with a stubbed fetch — 503 (model loading) keeps
//     waiting, 200 marks the server running; a child that dies mid-load fails
//     the start with the human error from the record; stop() kills the child
//     and lands the record in "stopped".
//   • Chat proxy — posts one non-streaming completion to the exact loopback
//     endpoint of the recorded server and unwraps choices[0].message.content.
//
// Hermeticity: child_process.spawn is mocked (tests drive the fake child's
// events), node:os.homedir is pointed at a temp root so the ~/.or paths under
// test are synthetic, and DATA_DIR points at a temp dir so log files never
// touch real user data. No real process is ever spawned here.

import fs from "node:fs";
import osReal from "node:os";
import path from "path";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// child_process.spawn is mocked: tests assert on the spawn call (argv array +
// options) and drive the fake child's events instead of launching processes.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

// engines.js (and dataDir.js) resolve ~/.or from os.homedir(). The holder lets
// each test point "home" at a synthetic root; the real value is captured inside
// the factory (hoisted code cannot reference import bindings) so afterEach can
// restore it. holder === null means "pass through the real homedir".
const { homedirHolder, realHomedirHolder } = vi.hoisted(() => ({
  homedirHolder: { value: null },
  realHomedirHolder: { value: null },
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  if (realHomedirHolder.value === null) realHomedirHolder.value = actual.homedir();
  const homedir = () => homedirHolder.value ?? realHomedirHolder.value;
  return {
    ...actual,
    default: { ...actual.default, homedir },
    homedir,
  };
});

// DATA_DIR must be set BEFORE any import that touches src/lib/dataDir.js.
const TEMP_ROOT = fs.mkdtempSync(path.join(osReal.tmpdir(), "or-llama-server-"));
process.env.DATA_DIR = path.join(TEMP_ROOT, "data");
const LOGS_DIR = path.join(process.env.DATA_DIR, "logs");

// Synthetic home and the two owner-managed binary locations under it.
const FAKE_HOME = path.join(TEMP_ROOT, "home");
const OR_BIN_LLAMA = path.join(FAKE_HOME, ".or", "bin", "llama.cpp");
const OR_BIN = path.join(FAKE_HOME, ".or", "bin");

const savedPath = process.env.PATH;

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 424242;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

// A real file on disk that passes findOnPath/firstExisting existence checks.
function plantBinary(dir, name = "llama-server.exe") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "not really an exe");
  return file;
}

// A real (tiny) .gguf file that passes the model validators.
function plantModel(dir, name = "tiny-model-q4_k_m.gguf") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(64, 7));
  return file;
}

afterEach(() => {
  process.env.PATH = savedPath;
  homedirHolder.value = null; // pass through to the real homedir again
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

afterAll(() => {
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* tmp best effort */ }
});

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------
describe("llama-server binary resolution", () => {
  let engines;
  let llamaServer;

  beforeEach(async () => {
    vi.resetModules();
    engines = await import("../../src/lib/localModels/engines.js");
    llamaServer = await import("../../src/lib/localModels/llamaServer.js");
  });

  it("finds the binary on PATH first", () => {
    const onPath = plantBinary(path.join(TEMP_ROOT, "pathdir"));
    const inOrBin = plantBinary(OR_BIN_LLAMA);
    process.env.PATH = path.dirname(onPath);
    homedirHolder.value = FAKE_HOME;

    expect(llamaServer.resolveLlamaServerBinary()).toBe(onPath);
    // Detection agrees with the launcher's resolution.
    expect(engines.detectInstalledEngines().llamacpp).toBe(true);
    expect(inOrBin).toBeTruthy(); // both exist; PATH order wins
  });

  it("falls back to ~/.or/bin/llama.cpp when PATH has nothing", () => {
    const dropped = plantBinary(OR_BIN_LLAMA);
    process.env.PATH = "";
    homedirHolder.value = FAKE_HOME;

    expect(llamaServer.resolveLlamaServerBinary()).toBe(dropped);
    // Detection must see the drop-folder install too — "installed" is the
    // whole point of the ~/.or/bin extension.
    expect(engines.detectInstalledEngines().llamacpp).toBe(true);
  });

  it("also probes the bare ~/.or/bin folder", () => {
    // Fresh home: the ~/.or/bin/llama.cpp candidate from other tests must not
    // shadow the bare-bin candidate under test here.
    const bareHome = path.join(TEMP_ROOT, "home-bare-bin");
    const dropped = plantBinary(path.join(bareHome, ".or", "bin"));
    process.env.PATH = "";
    homedirHolder.value = bareHome;

    expect(llamaServer.resolveLlamaServerBinary()).toBe(dropped);
  });

  it("returns null when no location has the binary, and detection says so", () => {
    process.env.PATH = "";
    homedirHolder.value = path.join(TEMP_ROOT, "empty-home");

    expect(llamaServer.resolveLlamaServerBinary()).toBeNull();
    expect(engines.detectInstalledEngines().llamacpp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startLlamaServer — spawn contract, validation, refusals
// ---------------------------------------------------------------------------
describe("startLlamaServer", () => {
  let llamaServer;

  beforeEach(async () => {
    vi.resetModules();
    llamaServer = await import("../../src/lib/localModels/llamaServer.js");
    // Everything resolves: binary on PATH (fake file), fetch healthy instantly.
    const bin = plantBinary(path.join(TEMP_ROOT, "pathdir"));
    process.env.PATH = path.dirname(bin);
    homedirHolder.value = FAKE_HOME;
    spawnMock.mockImplementation(() => makeFakeChild());
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
  });

  it("spawns an argv ARRAY with shell:false — never a shell string", async () => {
    const model = plantModel(TEMP_ROOT);
    const result = await llamaServer.startLlamaServer({ modelPath: model, port: 8091, ctxSize: 512 });

    expect(result.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    // The command is the resolved binary path itself; the model path, host,
    // port and context are separate argv elements — nothing for a shell to
    // reparse even if a path contained spaces or metacharacters.
    expect(cmd).toMatch(/llama-server\.exe$/);
    expect(args).toEqual([
      "-m", path.resolve(model),
      "--host", "127.0.0.1",
      "--port", "8091",
      "-c", "512",
    ]);
    expect(opts.shell).toBe(false); // explicit, not just the default
    expect(typeof opts.cwd).toBe("string");
  });

  it("refuses to spawn when the binary is missing, with a download hint", async () => {
    process.env.PATH = "";
    homedirHolder.value = path.join(TEMP_ROOT, "nothing-home");
    const model = plantModel(TEMP_ROOT);

    const result = await llamaServer.startLlamaServer({ modelPath: model });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/llama\.cpp not installed/i);
    expect(result.error).toMatch(/\.or\/bin\/llama\.cpp/); // the hint names the drop folder
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses non-GGUF and missing model files before spawning", async () => {
    const safetensors = plantModel(TEMP_ROOT, "weights.safetensors");
    let result = await llamaServer.startLlamaServer({ modelPath: safetensors });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/GGUF/i);

    result = await llamaServer.startLlamaServer({ modelPath: path.join(TEMP_ROOT, "ghost.gguf") });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);

    result = await llamaServer.startLlamaServer({ modelPath: "" });
    expect(result.ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses any host other than 127.0.0.1 — loopback only", async () => {
    const model = plantModel(TEMP_ROOT);
    const result = await llamaServer.startLlamaServer({ modelPath: model, host: "0.0.0.0" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/127\.0\.0\.1/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-range ports and context sizes", async () => {
    const model = plantModel(TEMP_ROOT);
    expect((await llamaServer.startLlamaServer({ modelPath: model, port: 80 })).ok).toBe(false);
    expect((await llamaServer.startLlamaServer({ modelPath: model, port: 70000 })).ok).toBe(false);
    expect((await llamaServer.startLlamaServer({ modelPath: model, ctxSize: 12 })).ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("registers the server as starting→running and exposes the loopback endpoints", async () => {
    const model = plantModel(TEMP_ROOT);
    const result = await llamaServer.startLlamaServer({ modelPath: model, port: 8091 });

    expect(result.ok).toBe(true);
    expect(result.server.status).toBe("running");
    expect(result.server.host).toBe("127.0.0.1");
    expect(result.server.port).toBe(8091);
    expect(result.server.endpoint).toBe("http://127.0.0.1:8091/v1/chat/completions");
    expect(result.server.healthUrl).toBe("http://127.0.0.1:8091/health");
    // The log lands in <DATA_DIR>/logs/llama-server-<port>.log.
    expect(result.server.logFile).toBe(path.join(LOGS_DIR, "llama-server-8091.log"));

    const listed = llamaServer.listLlamaServers();
    expect(listed.some((s) => s.id === result.server.id && s.status === "running")).toBe(true);
  });

  it("does not start a second server on the same port", async () => {
    const model = plantModel(TEMP_ROOT);
    await llamaServer.startLlamaServer({ modelPath: model, port: 8091 });
    const second = await llamaServer.startLlamaServer({ modelPath: model, port: 8091 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already/i);
  });
});

// ---------------------------------------------------------------------------
// Health-wait logic with a stubbed fetch
// ---------------------------------------------------------------------------
describe("health wait", () => {
  let llamaServer;

  beforeEach(async () => {
    vi.resetModules();
    llamaServer = await import("../../src/lib/localModels/llamaServer.js");
    const bin = plantBinary(path.join(TEMP_ROOT, "pathdir"));
    process.env.PATH = path.dirname(bin);
    homedirHolder.value = FAKE_HOME;
    spawnMock.mockImplementation(() => makeFakeChild());
  });

  it("keeps polling while /health answers 503 (model loading), then runs", async () => {
    const calls = [];
    let flip = false;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (flip) return { ok: true, status: 200 };
      flip = true;
      return { ok: false, status: 503 };
    }));

    const model = plantModel(TEMP_ROOT);
    const result = await llamaServer.startLlamaServer({ modelPath: model, port: 8091 });
    expect(result.ok).toBe(true);
    // Both polls hit the exact hard-coded loopback health URL.
    for (const url of calls) expect(url).toBe("http://127.0.0.1:8091/health");
  });

  it("fails the start and reports the log when the child dies mid-load", async () => {
    // Server never answers (connection refused), then the process exits.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8091"), { code: "ECONNREFUSED" });
    }));

    const model = plantModel(TEMP_ROOT);
    const pending = llamaServer.startLlamaServer({ modelPath: model, port: 8091 });

    // Let the health loop register, then the child dies on its own.
    await new Promise((r) => setTimeout(r, 700));
    const child = spawnMock.mock.results[0].value;
    child.emit("close", 1, null);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited unexpectedly|stopped before becoming healthy/);
  });

  it("stopLlamaServer kills the child and lands the record in stopped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    const model = plantModel(TEMP_ROOT);
    const result = await llamaServer.startLlamaServer({ modelPath: model, port: 8091 });
    const child = spawnMock.mock.results[0].value;

    const stopPromise = llamaServer.stopLlamaServer(result.server.id);
    child.emit("close", 0, null); // the kill lands as a close event
    const stopped = await stopPromise;

    expect(child.kill).toHaveBeenCalled();
    expect(stopped.ok).toBe(true);
    expect(stopped.server.status).toBe("stopped");

    // Stopping an unknown id is a clean refusal, not a throw.
    const ghost = await llamaServer.stopLlamaServer("lsv-nope");
    expect(ghost.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chat proxy — loopback-only, one completion, unwrapped reply
// ---------------------------------------------------------------------------
describe("chatWithLlamaServer", () => {
  let llamaServer;

  beforeEach(async () => {
    vi.resetModules();
    llamaServer = await import("../../src/lib/localModels/llamaServer.js");
    const bin = plantBinary(path.join(TEMP_ROOT, "pathdir"));
    process.env.PATH = path.dirname(bin);
    homedirHolder.value = FAKE_HOME;
    spawnMock.mockImplementation(() => makeFakeChild());
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
  });

  it("POSTs one non-streaming completion to the server's loopback endpoint", async () => {
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" } }],
        model: "tiny-model",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const model = plantModel(TEMP_ROOT);
    const { server } = await llamaServer.startLlamaServer({ modelPath: model, port: 8091 });

    const result = await llamaServer.chatWithLlamaServer({ id: server.id, message: "Say OK" });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("OK");

    const { url, init } = seen.find((call) => call.init?.method === "POST");
    // The deliberate loopback exception: exactly this origin, nothing else.
    expect(url).toBe("http://127.0.0.1:8091/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "Say OK" }]);
  });

  it("refuses to chat with an unknown id or a server that is not running", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let result = await llamaServer.chatWithLlamaServer({ id: "lsv-nope", message: "hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown/);

    result = await llamaServer.chatWithLlamaServer({ id: "", message: "hi" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
