"use strict";

// Compile the desktop app with Inno Setup.
//
// electron-builder only unpacks the app (`--win dir`); the installer format is
// Inno for both products, so install, silent update and uninstall behave
// identically for the gateway and the window app, and the updater keeps
// downloading `OriginRouter-Desktop-Setup-<version>.exe` from the release.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkg = require("../package.json");
const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(repoRoot, "installer", "origin-router-desktop.iss");
const unpacked = path.join(__dirname, "..", "dist", "win-unpacked");

const candidates = [
  process.env.ISCC_PATH,
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
].filter(Boolean);

const iscc = candidates.find((file) => fs.existsSync(file));
if (!iscc) {
  console.error("Inno Setup compiler (ISCC.exe) not found. Set ISCC_PATH or install Inno Setup 6.");
  process.exit(1);
}

if (!fs.existsSync(path.join(unpacked, "OriginRouter Desktop.exe"))) {
  console.error(`Missing ${unpacked}\\OriginRouter Desktop.exe - run electron-builder --win dir first.`);
  process.exit(1);
}

// electron-builder needs strict semver in package.json, but a release can use
// a shorter display version (0.6 rather than 0.6.0). The installer, its file
// name and the Windows version info follow the display version when set.
const displayVersion = String(process.env.OR_DISPLAY_VERSION || "").trim() || pkg.version;
const result = spawnSync(iscc, [script, `/DAppVersion=${displayVersion}`], {
  stdio: "inherit",
  cwd: repoRoot,
});
process.exit(result.status === 0 ? 0 : 1);
