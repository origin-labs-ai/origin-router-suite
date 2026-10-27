#!/usr/bin/env node
/**
 * Package the built CLI into a portable folder per platform.
 *
 *   node scripts/package-cli.mjs --platform win
 *
 * CI runs this on windows/macos/ubuntu after `npm run build` in cli/, so each
 * runner only ever packages its own platform (no cross-compilation tricks).
 * Output: dist/<platform>/  with `originrouter.cmd` (win) or `originrouter` shim.
 */
import fs from "node:fs";
import path from "node:path";

const platformArg = process.argv.find((a) => a.startsWith("--platform="));
const platform = platformArg ? platformArg.split("=")[1] : process.platform.replace("win32", "win").replace("darwin", "mac");
const outDir = path.resolve("dist", platform);
const cliApp = path.resolve("cli", "app");

if (!fs.existsSync(cliApp)) {
  console.error("cli/app is missing — run `npm run build` inside cli/ first.");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(cliApp, path.join(outDir, "app"), { recursive: true });
fs.cpSync(path.resolve("cli", "cli.js"), path.join(outDir, "cli.js"));
fs.cpSync(path.resolve("cli", "hooks"), path.join(outDir, "hooks"), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.resolve("cli", "package.json"), "utf8"));
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ ...pkg, bin: { originrouter: "./cli.js" } }, null, 2));

if (platform === "win") {
  fs.writeFileSync(path.join(outDir, "originrouter.cmd"), "@echo off\r\nnode \"%~dp0cli.js\" %*\r\n");
} else {
  const shim = "#!/bin/sh\nexec node \"$(dirname \"$0\")/cli.js\" \"$@\"\n";
  fs.writeFileSync(path.join(outDir, "originrouter"), shim, { mode: 0o755 });
}

console.log(`packaged ${platform} -> ${outDir}`);
