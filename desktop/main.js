"use strict";

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require("electron");
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

// Both background services live in the tray, so nothing may leave a console
// window on screen: the gateway's own output and the orchestrator's output are
// redirected to log files, and the tray menu opens them on demand in a visible
// window the user closes when done.
const ROUTER_LOG = path.join(os.homedir(), ".or", "logs", "router.log");
const PANDA_HOME = path.join(os.homedir(), ".or", "panda");
const PANDA_LOG = path.join(PANDA_HOME, "panda.log");
const PANDA_ERR_LOG = path.join(PANDA_HOME, "panda.err.log");
const PANDA_SERVE = "C:\\Users\\thaku\\Tools\\PandaOrchestrator\\.venv-panda\\Scripts\\panda-router-serve.exe";
const PANDA_ARTIFACTS = "C:\\Users\\thaku\\Tools\\PandaOrchestrator\\artifacts\\panda-router-v4";
const PANDA_PORT = 8765;
const TRAY_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "assets", "icon.ico");
const REPO_URL = "https://github.com/origin-labs-ai/originrouter";

app.setName("OriginRouter");
app.setAppUserModelId("ai.originlabs.originrouter.desktop");
app.setPath("userData", ORIGIN_HOME);

let mainWindow = null;
let serverChild = null;
let startedServer = false;
let tray = null;
let quitting = false;

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
  try {
    fs.mkdirSync(path.dirname(ROUTER_LOG), { recursive: true });
  } catch {}
  // windowsHide keeps the child off the screen; the log file is what the tray's
  // "Open Router Console" item tails, so nothing is lost by running hidden.
  const logStream = fs.createWriteStream(ROUTER_LOG, { flags: "a" });
  serverChild = spawn(
    runtime,
    [cli, "--tray", "--skip-update", "--host", "127.0.0.1"],
    {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverChild.stdout?.pipe(logStream);
  serverChild.stderr?.pipe(logStream);
  serverChild.on("error", (error) => logStream.write(`[spawn] ${error.message}\n`));
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

function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Start the PandaOrchestrator model picker if port 8765 is not answering.
 * Fully hidden: no console flashes, its output goes to ~/.or/panda/panda.log.
 * The router works without it (it falls back to its own ordering), so a failure
 * here is logged and ignored.
 */
function ensurePandaOrchestrator() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `if (-not (Get-NetTCPConnection -LocalPort ${PANDA_PORT} -State Listen)) {`,
    `  if (Test-Path '${PANDA_SERVE}') {`,
    `    $env:PANDA_ROUTER_ARTIFACTS='${PANDA_ARTIFACTS}';`,
    `    $env:PANDA_ROUTER_DB='${path.join(PANDA_HOME, "router_log.sqlite")}';`,
    `    Start-Process -FilePath '${PANDA_SERVE}' -ArgumentList '--port','${PANDA_PORT}','--db','${path.join(PANDA_HOME, "router_log.sqlite")}' -WindowStyle Hidden -RedirectStandardOutput '${PANDA_LOG}' -RedirectStandardError '${PANDA_ERR_LOG}'`,
    "  }",
    "}",
  ].join(" ");
  try {
    fs.mkdirSync(PANDA_HOME, { recursive: true });
    const child = spawn(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// A visible terminal that follows one of the background services' logs.
function openConsoleWindow(file, title) {
  const script = [
    `$Host.UI.RawUI.WindowTitle='${title}';`,
    `if (Test-Path '${file}') { Get-Content '${file}' -Tail 300 -Wait } else { 'No log yet at ${file}' }`,
  ].join(" ");
  const child = spawn(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", () => {});
  child.unref();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Open OriginRouter (GUI)", click: showMainWindow },
    { label: "Open Gateway Console (log)", click: () => openConsoleWindow(ROUTER_LOG, "OriginRouter gateway console") },
    { label: "Open Panda Orchestrator Console (log)", click: () => openConsoleWindow(PANDA_LOG, "PandaOrchestrator console") },
    { label: "Restart Panda Orchestrator", click: ensurePandaOrchestrator },
    { type: "separator" },
    { label: "Check for Updates", click: () => shell.openExternal(`${REPO_URL}/releases/latest`) },
    { label: "Hide Window (keep running)", click: () => mainWindow?.hide() },
    { type: "separator" },
    { label: "Quit OriginRouter", click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    // An empty image would make the tray entry invisible, and then a hidden
    // window with no way back would look exactly like a process that cannot be
    // closed. Try the .ico, then the .png, and only fall back to a text-less
    // icon after both fail.
    let image = nativeImage.createFromPath(TRAY_ICON_PATH);
    if (image.isEmpty()) image = nativeImage.createFromPath(ICON_PATH);
    if (image.isEmpty()) {
      tray = null;
      return;
    }
    tray = new Tray(image.resize({ width: 16, height: 16 }));
    tray.setToolTip("OriginRouter — gateway running");
    tray.setContextMenu(buildTrayMenu());
    tray.on("double-click", showMainWindow);
  } catch {
    tray = null;
  }
}

// Tell the user once where the app went, so hiding on close is never mistaken
// for a stuck process.
function notifyHiddenOnce() {
  if (!tray) return;
  try {
    tray.displayBalloon({
      title: "OriginRouter is still running",
      content: "Minimised to the tray. Right-click the tray icon to open the gateway, its logs, or to Quit.",
      iconType: "info",
    });
  } catch {}
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
  // The dashboard is served from the local gateway, whose bundle changes on every
  // update. Electron's disk cache survives restarts, so a stale page would keep
  // rendering the previous build's logic (and its old capability labels) after an
  // auto-update. Clearing on startup guarantees the UI matches the installed server.
  try {
    app.defaultSession?.clearCache();
  } catch {}

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

  // Closing the window hides it: the gateway and the orchestrator keep running
  // in the tray, and both consoles stay reachable from the tray menu.
  mainWindow.on("close", (event) => {
    saveBounds();
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
      notifyHiddenOnce();
    }
  });
  app.on("before-quit", () => { quitting = true; });
  createTray();
  ensurePandaOrchestrator();
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
