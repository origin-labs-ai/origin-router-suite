#!/usr/bin/env node
/**
 * `npm run patch:local` — apply the current repo build to an installed OriginRouter.
 *
 * What it does, in order:
 *   1. finds every installed bundle it knows about (server install, desktop app,
 *      portable folder, or an explicit `--target`)
 *   2. decides whether the bundle in `cli/app` is stale (newest source file newer
 *      than the bundle's server.js) and rebuilds only then, or always with `--build`
 *   3. registers the bundle so the dashboard and `or patch` can re-apply it later
 *   4. if the gateway has requests in flight, refuses — a patch restarts the
 *      process, exactly like the update command — unless `--force`
 *   5. stops the gateway, hands the swap to the detached runner, and streams the
 *      runner's status until the new build answers /api/health or rolls back
 *
 * Nothing here writes to the data directory except `~/.or/patch/`, and `.env` is
 * carried over untouched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectTargets, planPatch, buildNeedsRefresh } from "../src/lib/localPatch/plan.mjs";
import {
  LOG_FILE,
  PATCH_DIR,
  RUNNER_FILE,
  SOURCE_FILE,
  STATUS_FILE,
  ensurePatchDir,
  fingerprintBundle,
  readPatchStatus,
  readPatchSource,
  writePatchSource,
} from "../src/lib/localPatch/state.mjs";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 20128;

const HELP = `
Usage: npm run patch:local -- [options]

Build the repo (only when stale) and apply it to an installed OriginRouter.

Options:
  --build           Rebuild even when the bundle looks fresh
  --dry-run         Print the plan and exit without touching anything
  --no-restart      Register the bundle for the dashboard / \`or patch\` and exit
  --watch           Keep watching src/ and open-sse/, patching whenever idle
  --force           Patch even when requests are in flight
  --all             Also patch installs that are not currently running
  --port <port>     Gateway port (default: ${DEFAULT_PORT})
  --target <dir>    Patch this install root or bundle folder
  --bundle <dir>    Use an existing bundle instead of building cli/app
  --keep <n>        Backups to keep next to the install (default: 1)
  -h, --help        Show this help
`;

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    keep: 1,
    build: false,
    dryRun: false,
    noRestart: false,
    watch: false,
    force: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--build":
        opts.build = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--no-restart":
        opts.noRestart = true;
        break;
      case "--watch":
        opts.watch = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--port":
      case "-p":
        opts.port = Number(value()) || DEFAULT_PORT;
        break;
      case "--target":
        opts.target = value();
        break;
      case "--bundle":
        opts.bundle = value();
        break;
      case "--keep":
        opts.keep = Math.max(1, Number(value()) || 1);
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function log(message) {
  console.log(`[patch] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[patch] ${message}`);
  process.exit(code);
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPort(port, open, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isPortOpen(port)) === open) return true;
    await sleep(300);
  }
  return false;
}

/** Listener PIDs for a port. Windows has no lsof, and its netstat is the one truth. */
function findListenerPids(port) {
  const pids = [];
  try {
    if (process.platform === "win32") {
      const netstat = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe");
      const out = execFileSync(netstat, ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (cols[3] !== "LISTENING") continue;
        if (!cols[1].endsWith(`:${port}`)) continue;
        const pid = Number(cols[4]);
        if (pid && pid !== process.pid) pids.push(pid);
      }
    } else {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (pid && pid !== process.pid) pids.push(pid);
      }
    }
  } catch {
    /* no netstat/lsof, or nothing listening */
  }
  return [...new Set(pids)];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The desktop app keeps its bundled server open while it runs, so its folder
 * cannot be renamed. Detect it instead of failing halfway through a swap.
 */
function isDesktopAppRunning() {
  if (process.platform !== "win32") return false;
  try {
    const tasklist = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
    const out = execFileSync(tasklist, ["/FI", "IMAGENAME eq OriginRouter Desktop.exe", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return out.includes("OriginRouter Desktop.exe");
  } catch {
    return false;
  }
}

async function stopGateway(port) {
  const pids = findListenerPids(port);
  if (!pids.length) return [];
  for (const pid of pids) {
    log(`stopping gateway (pid ${pid}) on port ${port}`);
    try {
      process.kill(pid);
    } catch (error) {
      log(`stop failed for ${pid}: ${error.message}`);
    }
  }
  if (await waitForPort(port, false, 20000)) return pids;
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    log(`pid ${pid} ignored the stop request; terminating`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best effort */
    }
  }
  await waitForPort(port, false, 10000);
  return pids;
}

async function activitySnapshot(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version/patch`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      busy: Boolean(data.busy),
      inFlight: Number(data.inFlight) || 0,
      runningDir: typeof data.runningDir === "string" ? data.runningDir : "",
    };
  } catch {
    // Server not running, or an older build that has no patch route yet. Either
    // way there is nothing in flight we can see.
    return null;
  }
}

function gitValue(args) {
  try {
    return String(execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8", windowsHide: true })).trim();
  } catch {
    return "";
  }
}

function resolveBundle(opts) {
  if (opts.bundle) return path.resolve(opts.bundle);
  return path.join(REPO_DIR, "cli", "app");
}

function refreshBundle(opts, bundleDir) {
  const stale = buildNeedsRefresh({ repoDir: REPO_DIR, bundleDir });
  if (!opts.build && !stale.stale) {
    log(`bundle is fresh (${stale.reason})`);
    return true;
  }
  log(opts.build ? "rebuilding (--build)" : `rebuilding: ${stale.reason}`);
  const started = Date.now();
  const result = spawnSync("npm --prefix cli run build", {
    cwd: REPO_DIR,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NEXT_TRACING_ROOT_MODE: "project" },
  });
  if (result.status !== 0) return false;
  log(`build finished in ${Math.round((Date.now() - started) / 1000)}s`);
  return true;
}

function printPlan(plan) {
  log(`bundle: ${plan.bundle.dir}`);
  log(`  version ${plan.bundle.version || "?"} · build ${plan.bundle.buildId || "?"} · ${plan.bundle.builtAt || "unknown build time"}`);
  if (!plan.targets.length) {
    log("no installed bundle found — pass --target <dir>");
    return;
  }
  for (const target of plan.targets) {
    log(
      `target ${target.id} (${target.installMode}) → ${target.appDir}` +
        `\n         ${target.current ? "already on this build" : "needs the patch"}` +
        (target.installed?.patchedAt ? ` · last patched ${target.installed.patchedAt}` : ""),
    );
  }
}

function registerSource(bundleDir) {
  const fingerprint = fingerprintBundle(bundleDir) || {};
  const source = {
    bundle: path.resolve(bundleDir),
    version: fingerprint.version || "",
    buildId: fingerprint.buildId || "",
    hash: fingerprint.hash || "",
    builtAt: fingerprint.builtAt || null,
    commit: gitValue(["rev-parse", "--short", "HEAD"]),
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    repo: REPO_DIR,
  };
  ensurePatchDir();
  writePatchSource(source);
  return source;
}

function spawnRunner(target, source, opts, running) {
  ensurePatchDir();
  const runnerSource = path.join(REPO_DIR, "src", "lib", "localPatch", "runner.cjs");
  fs.copyFileSync(runnerSource, RUNNER_FILE);
  // Fresh status so we never read the previous run's "healthy".
  try {
    fs.rmSync(STATUS_FILE, { force: true });
  } catch {
    /* best effort */
  }

  const child = spawn(
    process.execPath,
    [
      RUNNER_FILE,
      "--app", target.appDir,
      "--source", source.bundle,
      "--port", String(opts.port),
      "--status", STATUS_FILE,
      "--log", LOG_FILE,
      "--keep", String(opts.keep),
      "--version", source.version,
      "--build-id", source.buildId,
      "--hash", source.hash,
      "--commit", source.commit,
      "--repo", REPO_DIR,
      ...(running ? [] : ["--no-start"]),
    ],
    { detached: true, windowsHide: true, stdio: "ignore", cwd: PATCH_DIR, env: process.env },
  );
  child.unref();
  return child.pid;
}

function tailLog(fromBytes) {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size <= fromBytes) return fromBytes;
    const fd = fs.openSync(LOG_FILE, "r");
    const buffer = Buffer.alloc(stat.size - fromBytes);
    fs.readSync(fd, buffer, 0, buffer.length, fromBytes);
    fs.closeSync(fd);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) console.log(`  ${line}`);
    }
    return stat.size;
  } catch {
    return fromBytes;
  }
}

async function waitForRunner(timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  // Only stream what this run writes; the log file is appended across runs.
  let offset = 0;
  try {
    offset = fs.statSync(LOG_FILE).size;
  } catch {
    /* no log yet */
  }
  let lastPhase = "";
  let latest = null;
  while (Date.now() < deadline) {
    latest = readPatchStatus();
    if (latest?.phase && latest.phase !== lastPhase) {
      lastPhase = latest.phase;
      log(`${latest.phase}${latest.message ? ` — ${latest.message}` : ""}`);
    }
    offset = tailLog(offset);
    if (latest && ["healthy", "patched", "rolled-back", "failed"].includes(latest.phase)) return latest;
    await sleep(600);
  }
  return latest;
}

async function applyTarget(target, source, opts, { running }) {
  if (target.current && !opts.build) {
    log(`${target.id} is already on build ${source.buildId || "(unknown)"} — nothing to do`);
    return true;
  }

  if (!running && target.id === "desktop" && isDesktopAppRunning() && !opts.force) {
    log(`${target.label} is running — close it, then run again (or pass --force)`);
    return true;
  }

  if (running) {
    const activity = await activitySnapshot(opts.port);
    if (activity?.busy && !opts.force) {
      console.error("");
      console.error(`  ${activity.inFlight} request(s) are in flight on port ${opts.port}.`);
      console.error("  A patch restarts the gateway — the same choice the update command offers.");
      console.error("  Wait for the dashboard to look idle and run it again, or pass --force.");
      console.error("");
      return false;
    }
    await stopGateway(opts.port);
  }

  const pid = spawnRunner(target, source, opts, running);
  log(`runner started (pid ${pid}); watching ${STATUS_FILE}`);
  const status = await waitForRunner();
  if (!status) {
    log("runner did not report back in time; check ~/.or/patch/patch.log");
    return false;
  }
  if (status.phase === "healthy") {
    log(`patched ${target.appDir} → build ${source.buildId || "?"} (previous saved at ${status.backup || "n/a"})`);
    return true;
  }
  if (status.phase === "patched") {
    log(`patched ${target.appDir} → build ${source.buildId || "?"} — restart ${target.label} to load it`);
    return true;
  }
  log(`patch did not complete: ${status.message || status.phase}`);
  return false;
}

async function runOnce(opts) {
  const bundleDir = resolveBundle(opts);
  if (!opts.dryRun && !opts.noRestart) {
    if (!refreshBundle(opts, bundleDir)) fail("build failed");
  } else if (!fs.existsSync(path.join(bundleDir, "server.js"))) {
    fail(`${bundleDir} is not a built bundle (server.js missing); run without --dry-run first`);
  }

  const targets = detectTargets({ explicitDir: opts.target });
  const plan = planPatch({ targets, bundleDir });
  printPlan(plan);

  if (opts.dryRun) {
    const pending = plan.targets.filter((target) => !target.current);
    log(pending.length ? `${pending.length} target(s) would be patched` : "everything is already current");
    return true;
  }

  const source = registerSource(bundleDir);
  log(`registered source in ${SOURCE_FILE}`);

  if (!plan.targets.length) fail("no installed bundle found to patch", 2);
  if (opts.noRestart) {
    log("skipping restart (--no-restart). Apply later from the dashboard or with `or patch`.");
    return true;
  }

  let ok = true;
  const activity = await activitySnapshot(opts.port);
  const runningDir = activity?.runningDir ? path.resolve(activity.runningDir) : "";
  const isRunning = (target) => Boolean(runningDir) && path.resolve(target.appDir) === runningDir;
  // Fallbacks for a running build that predates the patch route (first run):
  // one target is unambiguous; with several, the port belongs to the server
  // install. `--all` opts every detected target in, and the ones that are not
  // running get a file swap without a restart.
  const fallback = plan.targets.length === 1
    ? plan.targets[0]
    : plan.targets.find((target) => target.id === "server") || plan.targets[0];
  const runningTarget = opts.target ? plan.targets.find(isRunning) || null : plan.targets.find(isRunning) || fallback;
  const selected = opts.all ? plan.targets : runningTarget ? [runningTarget] : plan.targets;

  log(`patching ${selected.map((target) => target.id).join(", ")}${opts.all ? " (--all)" : ""}`);
  for (const target of selected) {
    const applied = await applyTarget(target, source, opts, { running: target === runningTarget });
    ok = applied && ok;
    if (!applied && !opts.force) break;
  }
  if (ok) {
    const fresh = await waitForPort(opts.port, true, 5000);
    if (fresh) log(`gateway answering on http://localhost:${opts.port}`);
  }
  return ok;
}

async function watch(opts) {
  log("watch mode: patching when sources change and the gateway is idle (Ctrl+C to stop)");
  let pending = null;
  const trigger = (why) => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      const activity = await activitySnapshot(opts.port);
      if (activity?.busy) {
        log(`${activity.inFlight} request(s) in flight — waiting for the gateway to go idle`);
        trigger("idle retry");
        return;
      }
      log(`change detected (${why}); patching`);
      try {
        const ok = await runOnce({ ...opts, watch: false, build: true });
        if (!ok) log("patch skipped or failed; waiting for the next change");
      } catch (error) {
        log(`patch error: ${error.message}`);
      }
      log("watching again");
    }, 2500);
  };

  for (const name of ["src", "open-sse", "public"]) {
    const dir = path.join(REPO_DIR, name);
    if (!fs.existsSync(dir)) continue;
    fs.watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      if (/[\\/](node_modules|\.next|\.next-cli-build)[\\/]/.test(file)) return;
      if (!/\.(js|mjs|cjs|jsx|ts|tsx|css|json|svg|png|ico)$/.test(file)) return;
      trigger(file);
    });
  }
  for (const name of ["custom-server.js", "next.config.mjs", "package.json"]) {
    const file = path.join(REPO_DIR, name);
    if (!fs.existsSync(file)) continue;
    fs.watch(file, () => trigger(name));
  }
  await new Promise(() => {});
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }
  if (opts.watch && opts.dryRun) fail("--watch and --dry-run do not combine");

  // A first run without a built bundle should build; a first run WITH one only
  // rebuilds when a source file is newer.
  const bundleDir = resolveBundle(opts);
  if (!opts.watch && !fs.existsSync(path.join(bundleDir, "server.js")) && !opts.build && !opts.noRestart) {
    log("no bundle yet; building one");
    opts.build = true;
  }

  if (opts.watch) {
    await watch(opts);
    return;
  }
  const ok = await runOnce(opts);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => fail(error.stack || error.message));
