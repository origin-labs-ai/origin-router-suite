const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

// Claude by Origin keeps every byte of its state inside ~/.claude/origin, next
// to an existing Claude install but never writing into it.
const ORIGIN_HOME = process.env.ORIGIN_CLAUDE_HOME || path.join(os.homedir(), ".claude", "origin");
fs.mkdirSync(ORIGIN_HOME, { recursive: true });
app.setPath("userData", ORIGIN_HOME);
app.setPath("sessionData", path.join(ORIGIN_HOME, "session"));

const APP_URL = process.env.ORIGIN_APP_URL || "http://localhost:20128/claude";
const ORIGIN_ROUTER = process.env.ORIGIN_ROUTER_BIN || "originrouter";
const BOUNDS_FILE = path.join(ORIGIN_HOME, "window.json");

if (process.platform === "win32") app.setAppUserModelId("ai.originlabs.claude");

// Single instance: a second launch focuses the existing window (deep links land
// on the running app instead of spawning a duplicate).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function readBounds() {
  try {
    return JSON.parse(fs.readFileSync(BOUNDS_FILE, "utf8"));
  } catch {
    return { width: 1280, height: 860 };
  }
}

function saveBounds(window) {
  try {
    if (window.isMinimized() || window.isMaximized()) return;
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(window.getBounds()));
  } catch {
    // Persisting geometry is best-effort.
  }
}

function isServerUp() {
  return new Promise((resolve) => {
    const request = http.get("http://localhost:20128/api/health", { timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function offlinePage(reason) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Claude by Origin</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; height:100vh; display:grid; place-items:center; background:#171717; color:#e8e6e3;
           font-family:'Anthropic Sans',-apple-system,BlinkMacSystemFont,system-ui,sans-serif; }
    .card { max-width: 460px; padding: 28px; border:1px solid rgba(255,255,255,.12);
            border-radius:14px; background:#1f1f1f; text-align:center; }
    h1 { font-size:18px; margin:0 0 8px; }
    p { font-size:13px; line-height:1.6; color:#a8a5a0; margin:0 0 16px; }
    code { background:#111; padding:2px 6px; border-radius:6px; font-family:'Anthropic Mono',ui-monospace,monospace; }
  </style></head>
  <body><div class="card">
    <h1>OriginRouter is not running</h1>
    <p>${reason}</p>
    <p>Start it with <code>${ORIGIN_ROUTER}</code>, then reopen this window.</p>
  </div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function loadApp(window) {
  const up = await isServerUp();
  if (up) {
    await window.loadURL(APP_URL);
    return;
  }
  await window.loadURL(offlinePage("Claude by Origin talks to the local OriginRouter server on port 20128."));
  // Keep retrying quietly, then land on the real UI once the server is up.
  const timer = setInterval(async () => {
    if (window.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    if (await isServerUp()) {
      clearInterval(timer);
      window.loadURL(APP_URL);
    }
  }, 3000);
}

function createWindow() {
  const bounds = readBounds();
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: "Claude by Origin",
    backgroundColor: "#171717",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  loadApp(window);

  window.on("close", () => saveBounds(window));
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

// claude-origin://open — used by the dashboard button.
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient("claude-origin", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("claude-origin");
}

let mainWindow = null;

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
