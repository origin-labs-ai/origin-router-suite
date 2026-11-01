"use strict";

// electron-builder is configured with signAndEditExecutable=false so the build
// does not need the winCodeSign symlink step. That also skips the normal icon
// embedding, which is why the installed app kept the default Electron icon.
// This hook runs after packing and before NSIS, so the EXE inside the installer
// (and therefore the shortcut/taskbar icon) carries the Origin mark.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function findRcedit() {
  const explicit = process.env.RCEDIT_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const cache = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  try {
    for (const entry of fs.readdirSync(cache)) {
      const candidate = path.join(cache, entry, "rcedit-x64.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

module.exports = async function afterPack(context) {
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(exePath)) {
    console.warn(`[afterPack] ${exeName} not found; skipping icon embedding`);
    return;
  }

  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn("[afterPack] rcedit-x64.exe not found; skipping icon embedding");
    return;
  }

  const icon = path.join(__dirname, "..", "assets", "icon.ico");
  const version = context.packager.appInfo.version || "0.0.0";
  execFileSync(rcedit, [
    exePath,
    "--set-icon", icon,
    "--set-file-version", version,
    "--set-product-version", version,
    "--set-version-string", "ProductName", "OriginRouter Desktop",
    "--set-version-string", "FileDescription", "OriginRouter Desktop",
    "--set-version-string", "CompanyName", "Origin Labs",
    "--set-version-string", "LegalCopyright", "Origin Labs",
  ], { windowsHide: true, stdio: "inherit" });
  console.log(`[afterPack] embedded Origin icon into ${exeName}`);
};
