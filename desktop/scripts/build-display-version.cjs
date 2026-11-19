"use strict";
// electron-builder insists on strict semver in package.json, but a release can
// legitimately use a shorter display version such as `0.6`. Keep the committed
// version exact: give the builder a temporary 0.6.0, restore package.json, put
// the display version back inside app.asar, and compile the installer with it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktop = path.resolve(__dirname, "..");
const pkgPath = path.join(desktop, "package.json");
const original = fs.readFileSync(pkgPath, "utf8");
const displayVersion = String(process.env.OR_DISPLAY_VERSION || "").trim() || JSON.parse(original).version;

function restore() {
  fs.writeFileSync(pkgPath, original);
}

// Only rewrite when the display version is not already valid semver.
const semver = require(path.join(desktop, "node_modules/semver"));
const buildVersion = semver.valid(displayVersion, true) ? displayVersion : "0.6.0";

try {
  if (buildVersion !== displayVersion) {
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ ...JSON.parse(original), version: buildVersion }, null, 2) + "\n",
    );
  }

  const builder = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["electron-builder", "--win", "dir", "--x64"],
    { cwd: desktop, stdio: "inherit", shell: process.platform === "win32" },
  );
  restore();
  if (builder.status !== 0) process.exit(builder.status || 1);

  if (buildVersion !== displayVersion) {
    const asar = require(path.join(desktop, "node_modules/@electron/asar"));
    const archive = path.join(desktop, "dist/win-unpacked/resources/app.asar");
    const extractTo = fs.mkdtempSync(path.join(os.tmpdir(), "or-asar-display-"));
    asar.extractAll(archive, extractTo);
    const innerPath = path.join(extractTo, "package.json");
    const inner = JSON.parse(fs.readFileSync(innerPath, "utf8"));
    inner.version = displayVersion;
    fs.writeFileSync(innerPath, JSON.stringify(inner, null, 2) + "\n");
    asar.createPackage(extractTo, archive);
    fs.rmSync(extractTo, { recursive: true, force: true });
    console.log(`app.asar version restored to ${displayVersion}`);
  }

  const installer = spawnSync(process.execPath, ["scripts/desktop-installer.cjs"], {
    cwd: desktop,
    stdio: "inherit",
    env: { ...process.env, OR_DISPLAY_VERSION: displayVersion },
  });
  process.exit(installer.status === 0 ? 0 : 1);
} catch (err) {
  restore();
  console.error(err);
  process.exit(1);
}
