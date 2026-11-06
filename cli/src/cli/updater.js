"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const USER_AGENT = "OriginRouter-Updater";
const REQUEST_TIMEOUT_MS = 20000;

function readInstallInfo() {
  try {
    const marker = path.resolve(__dirname, "..", "..", "install.json");
    if (!fs.existsSync(marker)) return null;
    const info = JSON.parse(fs.readFileSync(marker, "utf8"));
    return info && info.mode === "installer" ? info : null;
  } catch {
    return null;
  }
}

// The portable folder ships the same marker with mode "portable". It is not an
// installed product, so it never checks for installer updates - but the
// launcher asks it whether to start in the system tray.
function readPortableInfo() {
  try {
    const marker = path.resolve(__dirname, "..", "..", "install.json");
    if (!fs.existsSync(marker)) return null;
    const info = JSON.parse(fs.readFileSync(marker, "utf8"));
    return info && info.mode === "portable" ? info : null;
  } catch {
    return null;
  }
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function isNewer(candidate, current) {
  const a = normalizeVersion(candidate).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = normalizeVersion(current).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return true;
    if ((a[index] || 0) < (b[index] || 0)) return false;
  }
  return false;
}

function request(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status} for ${url}`));
      }
      return resolve(res);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Update request timed out")));
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  const res = await request(url);
  let body = "";
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

async function download(url, destination) {
  const res = await request(url);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(destination);
    res.pipe(stream);
    stream.on("finish", () => stream.close(resolve));
    stream.on("error", reject);
    res.on("error", reject);
  });
  return destination;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function fetchLatestRelease(repo = "origin-labs-ai/origin-router-suite") {
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!release || !release.tag_name) throw new Error("Latest release has no tag");
  return {
    ...release,
    version: normalizeVersion(release.tag_name),
    assets: Array.isArray(release.assets) ? release.assets : [],
  };
}

/**
 * Pick the installer asset for the channel being updated.
 *
 * "server" is the per-user Inno Setup build (OriginRouter-Setup-x.y.z.exe);
 * "desktop" is the Electron window app (OriginRouter-Desktop-Setup-x.y.z.exe).
 * Taking the wrong one would replace one product with the other, and picking any
 * random .exe would land on an uninstaller stub.
 */
function findInstallerAsset(release, channel = "server") {
  const assets = release.assets || [];
  const isDesktop = channel === "desktop";
  const exact = isDesktop
    ? /^OriginRouter-Desktop-Setup-.*\.exe$/i
    : /^OriginRouter-Setup-.*\.exe$/i;
  const found = assets.find((asset) => exact.test(asset.name));
  if (found) return found;
  return assets.find((asset) => /\.exe$/i.test(asset.name)
    && !/uninstall/i.test(asset.name)
    && (isDesktop ? /Desktop/i.test(asset.name) : !/Desktop/i.test(asset.name)))
    || null;
}

function findChecksumAsset(release, installer) {
  return (release.assets || []).find((asset) => asset.name === `${installer.name}.sha256`)
    || (release.assets || []).find((asset) => /^sha256sums?\.txt$/i.test(asset.name))
    || null;
}

async function verifyChecksum(release, installer, file) {
  const checksumAsset = findChecksumAsset(release, installer);
  if (!checksumAsset) return true;
  const res = await request(checksumAsset.browser_download_url);
  let text = "";
  for await (const chunk of res) text += chunk;
  const expected = (text.match(/[a-f0-9]{64}/i) || [])[0];
  if (!expected) throw new Error("Checksum file did not contain a SHA-256 value");
  const actual = sha256(file);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Installer checksum mismatch (expected ${expected}, got ${actual})`);
  }
  return true;
}

function logLine(message) {
  try {
    const dir = path.join(os.homedir(), ".or");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "updates.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging is best-effort.
  }
}

async function stageInstaller(release, channel = "server") {
  const installer = findInstallerAsset(release, channel);
  if (!installer) throw new Error(`Release has no ${channel} installer asset`);
  const destination = path.join(os.tmpdir(), installer.name);
  logLine(`downloading ${installer.name} from ${installer.browser_download_url}`);
  await download(installer.browser_download_url, destination);
  await verifyChecksum(release, installer, destination);
  logLine(`downloaded ${destination} (${sha256(destination)})`);
  return { installerPath: destination, installerName: installer.name };
}

/**
 * Stage every installer that applies to this machine.
 *
 * The server product always updates. The desktop window app is updated in the
 * same pass when it is installed, so one release keeps both Inno builds current
 * without either product having to schedule its own updater.
 */
async function stageInstallers(release, channels) {
  const staged = [];
  for (const channel of channels) {
    const installer = findInstallerAsset(release, channel);
    if (!installer) {
      logLine(`release has no ${channel} installer asset, skipping`);
      continue;
    }
    const destination = path.join(os.tmpdir(), installer.name);
    await download(installer.browser_download_url, destination);
    await verifyChecksum(release, installer, destination);
    staged.push({ channel, installerPath: destination, installerName: installer.name });
  }
  return staged;
}

function desktopAppInstalled() {
  const exe = path.join(process.env.LOCALAPPDATA || "", "Programs", "OriginRouter Desktop", "OriginRouter Desktop.exe");
  try {
    return fs.existsSync(exe);
  } catch {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Launch a detached PowerShell helper. It waits for this process to release the
// app files, force-closes whatever still holds them, runs the per-user Inno
// Setup installer silently, then starts the new build. The current CLI can exit
// immediately after this returns.
//
// The force-close step is what prevents "OriginRouter cannot be closed": the
// desktop app keeps a Node child (the bundled server) that the installer's own
// close handshake does not reach, so Inno/electron-builder would abort.
function launchInstallerAndRestart({ installerPath, installerPaths = null, installRoot, channel = "server", killImages = [] }) {
  if (process.platform !== "win32") throw new Error("Silent updates are only implemented on Windows");
  const paths = installerPaths && installerPaths.length ? installerPaths : [installerPath];
  const appCmd = path.join(installRoot, "originrouter.cmd");
  const desktopCmd = path.join(process.env.LOCALAPPDATA || "", "Programs", "OriginRouter Desktop", "OriginRouter Desktop.exe");
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const logPath = path.join(os.homedir(), ".or", "updates.log");
  const killList = ["OriginRouter Desktop.exe", ...killImages];
  const script = [
    "Start-Sleep -Seconds 2",
    `$log = ${psQuote(logPath)}`,
    `$app = ${psQuote(appCmd)}`,
    `$desktop = ${psQuote(desktopCmd)}`,
    `$kills = @(${killList.map(psQuote).join(",")})`,
    "foreach ($img in $kills) { try { Stop-Process -Name $img -Force -ErrorAction Stop; Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' closed ' + $img) } catch { } }",
    "Start-Sleep -Seconds 2",
    "try {",
    ...paths.map((one) => `  $p = Start-Process -FilePath ${psQuote(one)} -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait -PassThru; Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' installer ' + $p.ExitCode)`),
    "  if (Test-Path $app) { Start-Process -FilePath $app -ArgumentList '--tray','--skip-update' -WindowStyle Hidden }",
    "  if (Test-Path $desktop) { Start-Process -FilePath $desktop }",
    "} catch { Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' installer failed: ' + $_.Exception.Message) }",
  ].join("; ");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

module.exports = {
  readInstallInfo,
  readPortableInfo,
  normalizeVersion,
  isNewer,
  fetchLatestRelease,
  findInstallerAsset,
  stageInstaller,
  stageInstallers,
  desktopAppInstalled,
  launchInstallerAndRestart,
  logLine,
};
