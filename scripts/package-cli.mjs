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
import { spawnSync } from "node:child_process";

// Node's recursive copy walks an npm tree one file at a time and hits Windows'
// 260-character path limit on deep dependency folders - which is what killed the
// CI windows job silently after 20 minutes. robocopy takes long paths, copies
// multithreaded and ships with every Windows install, so on win32 the big trees go
// through it; anything else (or a machine without it) keeps cpSync.
function copyTree(src, dest) {
  const robocopy = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "Robocopy.exe");
  if (process.platform !== "win32" || !fs.existsSync(robocopy)) {
    return fs.cpSync(src, dest, { recursive: true });
  }
  const result = spawnSync(
    robocopy,
    [src, dest, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/MT:16"],
    { encoding: "utf8" }
  );
  // robocopy reports results in the exit code: 0-7 is success (1 = files copied),
  // 8 and above is a real failure.
  if (result.status >= 8) {
    throw new Error(`robocopy ${src} -> ${dest} failed with code ${result.status}:\n${result.stdout || result.stderr}`);
  }
  return undefined;
}

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
copyTree(cliApp, path.join(outDir, "app"));
fs.cpSync(path.resolve("cli", "cli.js"), path.join(outDir, "cli.js"));
copyTree(path.resolve("cli", "src"), path.join(outDir, "src"));
copyTree(path.resolve("cli", "hooks"), path.join(outDir, "hooks"));
copyTree(path.resolve("cli", "node_modules"), path.join(outDir, "node_modules"));

const pkg = JSON.parse(fs.readFileSync(path.resolve("cli", "package.json"), "utf8"));
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ ...pkg, bin: { originrouter: "./cli.js", or: "./cli.js" } }, null, 2));
fs.writeFileSync(path.join(outDir, "install.json"), JSON.stringify({
  mode: "installer",
  name: pkg.name,
  version: pkg.version,
  updateRepo: "origin-labs-ai/origin-router-suite",
}, null, 2));

if (platform === "win") {
  fs.writeFileSync(path.join(outDir, "originrouter.cmd"), "@echo off\r\nnode \"%~dp0cli.js\" %*\r\n");
  fs.writeFileSync(path.join(outDir, "or.cmd"), "@echo off\r\nnode \"%~dp0cli.js\" %*\r\n");
} else {
  const shim = "#!/bin/sh\nexec node \"$(dirname \"$0\")/cli.js\" \"$@\"\n";
  fs.writeFileSync(path.join(outDir, "originrouter"), shim, { mode: 0o755 });
}

console.log(`packaged ${platform} -> ${outDir}`);
