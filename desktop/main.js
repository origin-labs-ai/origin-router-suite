"use strict";

const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = 20128;
const ORIGIN_URL = `http://127.0.0.1:${PORT}`;
const DASHBOARD_URL = `${ORIGIN_URL}/dashboard`;
const ORIGIN_HOME = path.join(os.homedir(), ".or", "desktop");
const BOUNDS_FILE = path.join(ORIGIN_HOME, "window-bounds.json");
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "assets", "icon.png");

app.setName("OriginRouter");
app.setAppUserModelId("ai.originlabs.originrouter.desktop");
app.setPath("userData", ORIGIN_HOME);

let mainWindow = null;
let serverChild = null;
let startedServer = false;

function readBounds() {
  try {
    const value = JSON.parse(fs.readFileSync(BOUNDS_FILE, "utf8"));
    if (Number.isInteger(value.width) && Number.isInteger(value.height)) return value;
  } catch {}
  return { width: 1440, height: 900 };
}

// Saved bounds can point at a monitor that is no longer attached, or past the
// right edge after a resolution change. A frameless window in that state shows
// no titlebar controls and looks frozen, so clamp it into the work area.
function clampBounds(bounds) {
  const primary = screen.getPrimaryDisplay().workArea;
  const requested = {
    x: Number.isFinite(bounds.x) ? bounds.x : primary.x,
    y: Number.isFinite(bounds.y) ? bounds.y : primary.y,
    width: Number.isFinite(bounds.width) ? bounds.width : 1440,
    height: Number.isFinite(bounds.height) ? bounds.height : 900,
  };
  const display = screen.getDisplayMatching(requested);
  const area = display?.workArea || primary;
  const width = Math.max(960, Math.min(requested.width, area.width));
  const height = Math.max(640, Math.min(requested.height, area.height));
  const x = Math.min(Math.max(requested.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(requested.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.mkdirSync(ORIGIN_HOME, { recursive: true });
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(mainWindow.getBounds(), null, 2));
  } catch {}
}

function health(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN_URL}/api/health`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function findServerCli() {
  const candidates = [
    path.join(process.resourcesPath, "server", "cli.js"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "OriginRouter", "cli.js"),
    // `electron .` during development: use the freshly built CLI artifact.
    path.join(__dirname, "..", "dist", "win", "cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// Prefer the real Node runtime. Electron's embedded Node lacks the ABI for the
// native SQLite driver and can also miss sql.js's wasm path, which surfaces as
// "[DB] No SQLite driver available".
function findNodeExecutable() {
  const candidates = [
    process.env.NODE_EXE,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function startBundledServer() {
  if (startedServer || serverChild) return;
  const cli = findServerCli();
  if (!cli) return;
  startedServer = true;
  const systemNode = findNodeExecutable();
  const runtime = systemNode || process.execPath;
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    TRAY_MODE: "1",
  };
  if (!systemNode) env.ELECTRON_RUN_AS_NODE = "1";
  serverChild = spawn(
    runtime,
    [cli, "--tray", "--skip-update", "--host", "127.0.0.1"],
    {
      env,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  serverChild.on("exit", () => { serverChild = null; });
}

async function ensureServer() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await health()) return true;
    if (attempt === 0) startBundledServer();
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

function stopOwnedServer() {
  if (!serverChild || !startedServer) return;
  const pid = serverChild.pid;
  serverChild = null;
  try {
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    execFile(path.join(systemRoot, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
  } catch {}
}

function offlinePage() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OriginRouter</title><style>
  body{margin:0;background:#1a1a1a;color:#ededed;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{width:min(520px,90vw);text-align:center;padding:32px;border:1px solid #333;border-radius:16px;background:#222}
  h1{font-size:20px;margin:0 0 8px} p{color:#9ca3af;line-height:1.6;font-size:14px}
  button{margin-top:18px;border:0;border-radius:10px;background:#2B7FFF;color:#fff;padding:10px 18px;font-weight:700;cursor:pointer}
  </style></head><body><div class="card"><h1>OriginRouter is starting…</h1>
  <p>The local gateway is not reachable yet. It starts with the desktop app; if this persists, make sure Node.js 18+ is installed and port 20128 is free.</p>
  <button onclick="location.href='${DASHBOARD_URL}'">Retry</button></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function sendMaximizedState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("or:window-maximized", mainWindow.isMaximized());
}

function registerWindowControls() {
  const windowFor = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.on("or:window-minimize", (event) => windowFor(event)?.minimize());
  ipcMain.on("or:window-toggle-maximize", (event) => {
    const win = windowFor(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("or:window-close", (event) => windowFor(event)?.close());
  ipcMain.handle("or:window-is-maximized", (event) => Boolean(windowFor(event)?.isMaximized()));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...clampBounds(readBounds()),
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#1b1b1b",
    icon: ICON_PATH,
    // Native Windows frame: standard caption with the app icon and the title
    // text, plus the OS min/max/close buttons. The in-page caption strip used to
    // replace this; it needs no bridge anymore, so the window is framed and
    // `DesktopTitleBar` stays hidden (it only renders for a frameless window).
    frame: true,
    title: "OriginRouter",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("close", saveBounds);
  mainWindow.on("maximize", sendMaximizedState);
  mainWindow.on("unmaximize", sendMaximizedState);
  mainWindow.on("restore", sendMaximizedState);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(offlinePage());
  ensureServer().then((ready) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL(ready ? DASHBOARD_URL : offlinePage());
  });
}

registerWindowControls();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    try {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    } catch {}
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", stopOwnedServer);
}
