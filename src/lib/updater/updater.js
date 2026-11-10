// Standalone detached updater process.
// Downloads the signed installer from the release feed, runs it silently and
// exposes progress over a tiny HTTP server while the Next server is down.
// Survives after parent Next server exits (detached + unref by spawner).

const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

const packageName = process.env.UPDATER_PKG_NAME || "originrouter";
const port = parseInt(process.env.UPDATER_PORT || "20129", 10);
const tailLines = parseInt(process.env.UPDATER_TAIL_LINES || "8", 10);
const maxRetries = parseInt(process.env.UPDATER_RETRIES || "3", 10);
const retryDelayMs = parseInt(process.env.UPDATER_RETRY_DELAY_MS || "5000", 10);
const lingerMs = parseInt(process.env.UPDATER_LINGER_MS || "30000", 10);
const waitMinMs = parseInt(process.env.UPDATER_WAIT_MIN_MS || "3000", 10);
const waitMaxMs = parseInt(process.env.UPDATER_WAIT_MAX_MS || "15000", 10);
const waitCheckMs = parseInt(process.env.UPDATER_WAIT_CHECK_MS || "500", 10);
const appPort = parseInt(process.env.UPDATER_APP_PORT || "20128", 10);

// Data directory (match mitm/paths.js logic)
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "originrouter");
  }
  return path.join(os.homedir(), ".originrouter");
}
const updateDir = path.join(getDataDir(), "update");
try { fs.mkdirSync(updateDir, { recursive: true }); } catch { /* best effort */ }
const statusFile = path.join(updateDir, "status.json");
const logFile = path.join(updateDir, "install.log");

const state = {
  phase: "starting",
  packageName,
  startedAt: Date.now(),
  finishedAt: null,
  attempt: 0,
  maxRetries,
  done: false,
  success: false,
  exitCode: null,
  error: null,
  logTail: [],
};

function pushLog(line) {
  const trimmed = line.replace(/\r?\n$/, "");
  if (!trimmed) return;
  state.logTail.push(trimmed);
  if (state.logTail.length > tailLines) state.logTail = state.logTail.slice(-tailLines);
  try { fs.appendFileSync(logFile, `${trimmed}\n`); } catch { /* best effort */ }
}

function persistStatus() {
  try { fs.writeFileSync(statusFile, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}

function setPhase(phase) {
  state.phase = phase;
  persistStatus();
}

// HTTP server exposing status (browser polls this while Next server is dead)
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/update/status" || req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(state));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.on("error", (e) => {
  state.error = `status server error: ${e.message}`;
  persistStatus();
});

server.listen(port, "127.0.0.1", () => {
  persistStatus();
  waitForAppExit().then(runInstall);
});

// Check if app port is still being listened on (= app server still alive)
function isAppPortBusy() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(appPort, "127.0.0.1");
  });
}

// Wait for the app process to fully exit before the installer runs (avoids a
// Windows file-lock on the replaced files).
async function waitForAppExit() {
  setPhase("waitingForExit");
  pushLog(`[updater] waiting for app to exit (min ${Math.round(waitMinMs / 1000)}s)...`);

  // Hard minimum delay: OS needs time to release file handles
  await sleep(waitMinMs);

  // Poll app port until free or max timeout
  const deadline = Date.now() + (waitMaxMs - waitMinMs);
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (!busy) {
      pushLog(`[updater] app port :${appPort} is free, proceeding`);
      return;
    }
    await sleep(waitCheckMs);
  }
  pushLog(`[updater] timeout waiting for app, proceeding anyway`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const RELEASES_API = "https://api.github.com/repos/origin-labs-ai/origin-router-suite/releases/latest";
const RELEASES_PAGE = "https://github.com/origin-labs-ai/origin-router-suite/releases/latest";
// The per-user Inno build is the thing the updater installs. The desktop build
// bundles the gateway and has its own updater, so it is not this one.
const INSTALLER_ASSET = /^OriginRouter-Setup-.*.exe$/i;

async function fetchRelease() {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "originrouter-updater" },
  });
  if (!res.ok) throw new Error(`release feed responded ${res.status}`);
  return res.json();
}

async function download(url, destination) {
  const res = await fetch(url, { headers: { "User-Agent": "originrouter-updater" } });
  if (!res.ok) throw new Error(`download responded ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer;
}

function sha256(buffer) {
  return require("crypto").createHash("sha256").update(buffer).digest("hex");
}

// Expected digest for an asset: the .sha256 published next to it.
async function expectedDigest(release, assetName) {
  const sidecar = (release.assets || []).find((a) => a.name === `${assetName}.sha256`);
  if (!sidecar) return null;
  const res = await fetch(sidecar.browser_download_url, { headers: { "User-Agent": "originrouter-updater" } });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  const match = text.match(/[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : null;
}

async function runInstall() {
  state.attempt += 1;
  setPhase("installing");

  // Only Windows ships a silent installer. Everywhere else the update is a
  // download, so hand the user the release page instead of silently replacing
  // a running tree.
  if (process.platform !== "win32") {
    pushLog("[updater] no silent installer on this platform - opening the release page");
    openBrowser(RELEASES_PAGE);
    finalize(false, null, "Download the portable build for this platform from the release page.");
    return;
  }

  try {
    pushLog("[updater] reading the release feed");
    const release = await fetchRelease();
    const installer = (release.assets || []).find((a) => INSTALLER_ASSET.test(a.name));
    if (!installer) throw new Error("no OriginRouter-Setup-*.exe asset in the latest release");

    const destination = path.join(updateDir, installer.name);
    pushLog(`[updater] downloading ${installer.name} (${Math.round((installer.size || 0) / 1048576)} MB)`);
    const bytes = await download(installer.browser_download_url, destination);

    const expected = await expectedDigest(release, installer.name);
    const actual = sha256(bytes);
    if (expected && expected !== actual) {
      throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
    }
    pushLog(`[updater] checksum ${expected ? "verified" : "not published"} (${actual})`);

    pushLog("[updater] running the installer silently");
    const child = spawn(destination, [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/CLOSEAPPLICATIONS",
      "/SP-",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    child.stdout.on("data", (buf) => { buf.toString().split(/\r?\n/).forEach(pushLog); persistStatus(); });
    child.stderr.on("data", (buf) => { buf.toString().split(/\r?\n/).forEach(pushLog); persistStatus(); });
    child.on("error", (e) => finalize(false, null, e.message));
    child.on("close", (code) => {
      pushLog(`[updater] installer exited with code ${code}`);
      if (code === 0) {
        try { fs.unlinkSync(destination); } catch { /* keep it if locked */ }
        finalize(true, code, null);
        return;
      }
      if (state.attempt < maxRetries) {
        pushLog(`[updater] retrying in ${Math.round(retryDelayMs / 1000)}s...`);
        setTimeout(runInstall, retryDelayMs);
        return;
      }
      finalize(false, code, `Install failed after ${maxRetries} attempts`);
    });
  } catch (e) {
    pushLog(`[updater] ${e.message}`);
    if (state.attempt < maxRetries) {
      setTimeout(runInstall, retryDelayMs);
      return;
    }
    finalize(false, null, e.message);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? `open "${url}"`
    : platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  try { spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

// Wait until app port is listening (server alive again), then open dashboard
async function waitForAppAndOpenBrowser() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (busy) {
      openBrowser(`http://localhost:${appPort}/dashboard`);
      pushLog(`[updater] app ready, opened dashboard`);
      return;
    }
    await sleep(1000);
  }
  pushLog(`[updater] app not responding within 30s, skip browser open`);
}

function relaunchApp() {
  if (process.env.UPDATER_RELAUNCH !== "1") return;
  const cmd = process.env.UPDATER_RELAUNCH_CMD;
  if (!cmd) return;
  let args = [];
  try { args = JSON.parse(process.env.UPDATER_RELAUNCH_ARGS || "[]"); } catch { /* noop */ }
  const isWin = process.platform === "win32";
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: isWin,
      env: { ...process.env, UPDATER_RELAUNCH: "", UPDATER_RELAUNCH_CMD: "", UPDATER_RELAUNCH_ARGS: "" },
    });
    child.unref();
    pushLog(`[updater] relaunched: ${cmd} ${args.join(" ")} (pid=${child.pid})`);
    // Wait for new app to come up, then auto-open browser so user sees the result
    waitForAppAndOpenBrowser();
  } catch (e) {
    pushLog(`[updater] relaunch failed: ${e.message}`);
  }
}

function finalize(success, exitCode, error) {
  state.done = true;
  state.success = success;
  state.exitCode = exitCode;
  state.error = error;
  state.finishedAt = Date.now();
  setPhase(success ? "done" : "error");
  if (success) relaunchApp();
  // Linger so browser can poll final status, then exit & close the port
  setTimeout(() => {
    try { server.close(); } catch { /* ignore */ }
    process.exit(success ? 0 : 1);
  }, lingerMs);
}
