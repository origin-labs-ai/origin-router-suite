#!/usr/bin/env node
/**
 * Local patch runner.
 *
 * This file is copied to <DATA_DIR>/patch/runner.cjs before it runs, so the
 * folder it is about to replace can be deleted underneath it. It does the part
 * the gateway cannot do on Windows: wait for the old process to release its
 * files, swap the bundle, then bring the gateway back on the new code.
 *
 * Failure is never silent: every phase lands in the status file, and a build
 * that does not answer /api/health is rolled back to the previous folder.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const appDir = path.resolve(args.app || "");
const sourceDir = path.resolve(args.source || "");
const port = Number(args.port || 20128);
const parentPid = Number(args.parent || 0);
const statusFile = args.status || "";
const logFile = args.log || "";
const keepBackups = Math.max(1, Number(args.keep || 1));
const healthPath = args["health-path"] || "/api/health";
// A target that is not the process we just stopped cannot be health-checked or
// started by us: the desktop app owns its own gateway child. Swap the files,
// record the manifest, and let its owner restart it.
const noStart = args["no-start"] === "1";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    /* logging must never be the reason a patch fails */
  }
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusFile, "utf8"));
  } catch {
    return {};
  }
}

function status(patch) {
  if (!statusFile) return;
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    const next = { ...readStatus(), ...patch, at: new Date().toISOString() };
    const tmp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, statusFile);
  } catch {
    /* best effort */
  }
  log(`${patch.phase || "status"}${patch.message ? `: ${patch.message}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function portOpen(timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
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

async function waitForPort(open, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen()) === open) return true;
    await sleep(400);
  }
  return false;
}

async function healthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return true;
    } catch {
      /* not ready yet */
    }
    await sleep(700);
  }
  return false;
}

function renameWithRetry(from, to, attempts = 40, delayMs = 250) {
  return new Promise((resolve) => {
    const tryRename = (left) => {
      try {
        fs.renameSync(from, to);
        resolve(true);
      } catch (error) {
        if (left <= 1) {
          log(`rename failed: ${from} -> ${to}: ${error.message}`);
          resolve(false);
          return;
        }
        setTimeout(() => tryRename(left - 1), delayMs);
      }
    };
    tryRename(attempts);
  });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function spawnGateway(dir) {
  const logDir = path.join(path.dirname(statusFile || appDir), "gateway.log");
  let out;
  let err;
  try {
    fs.mkdirSync(path.dirname(logDir), { recursive: true });
    out = fs.openSync(logDir, "a");
    err = fs.openSync(`${logDir}.err`, "a");
  } catch {
    out = "ignore";
    err = "ignore";
  }
  const child = spawn(
    process.execPath,
    ["--dns-result-order=ipv4first", "--max-old-space-size=6144", "custom-server.js"],
    {
      cwd: dir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, PORT: String(port), HOSTNAME: process.env.HOSTNAME || "0.0.0.0", NODE_ENV: "production" },
    },
  );
  child.unref();
  log(`spawned gateway pid ${child.pid} from ${dir}`);
  return child.pid || 0;
}

function writeManifest(dir) {
  const manifest = {
    version: args.version || "",
    buildId: args["build-id"] || "",
    hash: args.hash || "",
    commit: args.commit || "",
    repo: args.repo || "",
    source: sourceDir,
    patchedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, ".patch.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function pruneBackups(baseDir, prefix) {
  try {
    const backups = fs
      .readdirSync(path.dirname(baseDir))
      .filter((name) => name.startsWith(`${prefix}${path.basename(baseDir)}.bak-`))
      .sort();
    while (backups.length > keepBackups) {
      const victim = backups.shift();
      fs.rmSync(path.join(path.dirname(baseDir), victim), { recursive: true, force: true });
      log(`pruned backup ${victim}`);
    }
  } catch (error) {
    log(`backup prune skipped: ${error.message}`);
  }
}

async function main() {
  // The gateway spawns this runner from inside the bundle it is about to
  // replace. On Windows a process whose working directory sits inside a folder
  // holds a handle on it, so renaming that folder fails with EBUSY/EPERM —
  // moving off the bundle first is what makes the swap possible at all.
  try {
    process.chdir(os.tmpdir());
  } catch {
    /* keep the inherited cwd; the rename retry may still win */
  }

  if (!appDir || !sourceDir) {
    status({ phase: "failed", ok: false, message: "missing --app or --source" });
    process.exit(2);
  }
  if (!fs.existsSync(path.join(appDir, "server.js"))) {
    status({ phase: "failed", ok: false, message: `${appDir} is not a bundle`, appDir });
    process.exit(2);
  }
  if (!fs.existsSync(path.join(sourceDir, "server.js"))) {
    status({ phase: "failed", ok: false, message: `${sourceDir} is not a bundle`, sourceDir });
    process.exit(2);
  }

  status({ phase: "waiting", ok: false, message: "waiting for the gateway to exit", appDir, sourceDir, port });

  if (parentPid && isAlive(parentPid)) {
    for (let i = 0; i < 120 && isAlive(parentPid); i += 1) await sleep(250);
  }
  // The process may ignore the exit request; free the folder anyway.
  if (parentPid && isAlive(parentPid)) {
    try {
      process.kill(parentPid);
      log(`sent terminate to parent ${parentPid}`);
    } catch (error) {
      log(`parent kill failed: ${error.message}`);
    }
    for (let i = 0; i < 40 && isAlive(parentPid); i += 1) await sleep(250);
  }
  if (!noStart) await waitForPort(false, 15000);

  const backup = `${appDir}.bak-${stamp()}`;
  status({ phase: "swapping", ok: false, message: "replacing the bundle", backup });
  if (!(await renameWithRetry(appDir, backup))) {
    // Nothing was replaced, so the install still works: bring it back up rather
    // than leaving the user with a dead port.
    if (!noStart) spawnGateway(appDir);
    status({ phase: "failed", ok: false, message: "could not move the old bundle aside; is the gateway still running?", backup });
    process.exit(1);
  }

  try {
    copyDir(sourceDir, appDir);
    const envBackup = path.join(backup, ".env");
    if (fs.existsSync(envBackup)) fs.copyFileSync(envBackup, path.join(appDir, ".env"));
    writeManifest(appDir);
  } catch (error) {
    log(`copy failed: ${error.message}`);
    fs.rmSync(appDir, { recursive: true, force: true });
    if (await renameWithRetry(backup, appDir)) spawnGateway(appDir);
    status({ phase: "rolled-back", ok: false, message: `copy failed: ${error.message}`, appDir, backup });
    process.exit(1);
  }

  if (noStart) {
    pruneBackups(appDir, "");
    status({ phase: "patched", ok: true, message: "bundle replaced; restart the app to load it", appDir, backup });
    process.exit(0);
  }

  status({ phase: "restarting", ok: false, message: "starting the new build", appDir, backup });

  // A CLI/tray supervisor restarts the gateway on a non-zero exit. Give it a
  // chance before starting a second copy ourselves.
  await waitForPort(true, 20000);
  if (!(await portOpen())) spawnGateway(appDir);

  if (await healthy(60000)) {
    pruneBackups(appDir, "");
    status({ phase: "healthy", ok: true, message: "patch applied", appDir, backup, port });
    process.exit(0);
  }

  status({ phase: "rolled-back", ok: false, message: "new build did not become healthy", appDir, backup });
  const failed = `${appDir}.failed-${stamp()}`;
  await waitForPort(false, 5000);
  await renameWithRetry(appDir, failed);
  if (!(await renameWithRetry(backup, appDir))) {
    status({ phase: "failed", ok: false, message: `rollback failed; old bundle is at ${backup}`, appDir, backup });
    process.exit(1);
  }
  spawnGateway(appDir);
  const recovered = await healthy(30000);
  status({
    phase: recovered ? "rolled-back" : "failed",
    ok: false,
    message: recovered ? "new build failed health check; previous build restored" : "rollback started but the old build is not healthy either",
    appDir,
    backup,
    failed,
  });
  process.exit(1);
}

main().catch((error) => {
  status({ phase: "failed", ok: false, message: error.message });
  process.exit(1);
});
