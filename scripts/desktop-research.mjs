#!/usr/bin/env node
/**
 * Desktop research generator (M3).
 *
 * Reads the installed Claude Desktop package read-only and writes measurement
 * docs into docs/research/claude-desktop/. Only counts, names and token values
 * are copied — never source code, fonts or assets.
 *
 *   node scripts/desktop-research.mjs [app-path]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_APP = path.join(
  process.env.ProgramFiles || "C:\\Program Files",
  "WindowsApps",
);
const appRoot = process.argv[2] || findClaudeApp();
const outDir = path.resolve("docs", "research", "claude-desktop");
fs.mkdirSync(outDir, { recursive: true });

function findClaudeApp() {
  try {
    const base = "C:/Program Files/WindowsApps";
    const candidate = fs.readdirSync(base).find((name) => name.startsWith("Claude_") && name.includes("_x64__"));
    if (!candidate) return null;
    return path.join(base, candidate);
  } catch {
    return null;
  }
}

if (!appRoot || !fs.existsSync(appRoot)) {
  console.error(`Claude Desktop package not found. Pass its path: node scripts/desktop-research.mjs "<app dir>"`);
  process.exit(1);
}

const resources = path.join(appRoot, "app", "resources");
const ionAssets = path.join(resources, "ion-dist", "assets", "v1");

/* ---------- 1. asar inventory ---------- */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  const jsonSize = header.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  fs.readSync(fd, json, 0, jsonSize, 16);
  fs.closeSync(fd);
  return JSON.parse(json.toString("utf8"));
}

function walkAsar(node, prefix = "", stats = { files: 0, dirs: 0, top: {}, largest: [] }) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) {
      stats.dirs += 1;
      const topKey = full.split("/")[0];
      stats.top[topKey] = (stats.top[topKey] || 0) + 1;
      walkAsar(entry, full, stats);
    } else {
      stats.files += 1;
      const size = Number(entry.size || 0);
      if (size > 0) stats.largest.push({ path: full, size });
    }
  }
  return stats;
}

const asarPath = path.join(resources, "app.asar");
let inventory = { files: 0, dirs: 0, top: {}, largest: [] };
let pkg = {};
if (fs.existsSync(asarPath)) {
  const header = readAsarHeader(asarPath);
  inventory = walkAsar(header);
  inventory.largest.sort((a, b) => b.size - a.size);
  inventory.largest = inventory.largest.slice(0, 20);
  const pkgEntry = header.files?.["package.json"];
  if (pkgEntry) {
    const fd = fs.openSync(asarPath, "r");
    const start = 16 + Buffer.alloc(0).length;
    // package.json content offset is listed in the header; read a bounded slice.
    const dataOffset = Number(pkgEntry.offset || 0) + start;
    const buffer = Buffer.alloc(Math.min(Number(pkgEntry.size || 0), 4096));
    fs.readSync(fd, buffer, 0, buffer.length, dataOffset);
    fs.closeSync(fd);
    try {
      pkg = JSON.parse(buffer.toString("utf8"));
    } catch {
      pkg = {};
    }
  }
}

/* ---------- 2. design tokens from CSS ---------- */
const tokenMap = new Map();
if (fs.existsSync(ionAssets)) {
  for (const file of fs.readdirSync(ionAssets).filter((f) => f.endsWith(".css"))) {
    const css = fs.readFileSync(path.join(ionAssets, file), "utf8");
    for (const match of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]{1,60});/g)) {
      const [, name, value] = match;
      if (/--(color|radius|space|shadow|font|text|bg|surface|border)/.test(name)) {
        if (!tokenMap.has(name)) tokenMap.set(name, value.trim());
      }
    }
  }
}

/* ---------- 3. pane inventory from strings ---------- */
const stringFiles = [
  path.join(resources, "ion-dist", "i18n", "en-US.json"),
  path.join(resources, "en-US.json"),
];
const keys = new Set();
const strings = fs.existsSync(stringFiles[0]) ? stringFiles[0] : stringFiles[1];
if (fs.existsSync(strings)) {
  const data = JSON.parse(fs.readFileSync(strings, "utf8"));
  const walk = (node, prefix = "") => {
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (prefix) keys.add(prefix);
  };
  walk(data);
}

const GROUPS = ["chat", "project", "artifact", "setting", "connector", "mcp", "prompt", "shortcut", "model", "account", "theme", "sidebar"];
const grouped = Object.fromEntries(GROUPS.map((group) => [group, []]));
for (const key of keys) {
  const lower = key.toLowerCase();
  const group = GROUPS.find((candidate) => lower.includes(candidate));
  if (group) grouped[group].push(key);
}

/* ---------- 4. write docs ---------- */
const inventoryMd = `# Claude Desktop — package inventory

Source (read-only): \`${appRoot}\`

| Item | Value |
|---|---|
| asar files | ${inventory.files} |
| asar dirs | ${inventory.dirs} |
| package name | ${pkg.name || "unknown"} |
| package version | ${pkg.version || "unknown"} |
| ion asset files | ${fs.existsSync(ionAssets) ? fs.readdirSync(ionAssets).length : 0} |

## Top-level asar entries
${Object.entries(inventory.top).map(([name, count]) => `- \`${name}\` (${count} dirs)`).join("\n")}

## Largest entries
${inventory.largest.map((entry) => `- \`${entry.path}\` — ${(entry.size / 1024).toFixed(1)} KB`).join("\n")}
`;

const tokensMd = `# Claude Desktop — design tokens (measured)

Extracted from the renderer CSS shipped with the installed app. Values only; no
CSS or component code is copied.

| Token | Value |
|---|---|
${[...tokenMap.entries()].slice(0, 120).map(([name, value]) => `| \`${name}\` | \`${value}\` |`).join("\n")}
`;

const panesMd = `# Claude Desktop — pane inventory

Derived from the app's own string table (${keys.size} keys). Grouped by feature
area; this is the rebuild checklist for M4.

${GROUPS.map((group) => `## ${group} (${grouped[group].length})
${grouped[group].slice(0, 12).map((key) => `- \`${key}\``).join("\n") || "- (none found)"}`).join("\n\n")}
`;

const flowsMd = `# Claude Desktop — interaction flows

Lifecycle notes for the rebuild. Runtime capture still to be filled in during M4.

## Send message
1. Composer captures text + attachments, disables send.
2. Request goes to the local OriginRouter endpoint with model = selected alias.
3. Streaming chunks append to the assistant message; stop aborts the stream.
4. On completion: persist message, refresh title if first turn.

## Stop
- Abort controller cancels the request; partial text is kept.

## Regenerate
- Drops the assistant turn, replays the transcript up to the last user message.

## Edit user message
- Truncates everything after the edited turn, replays with the new text.

## Attachments
- Images only in v1; stored under ~/.claude/origin/attachments.

## TODO (runtime capture)
- [ ] Keyboard shortcuts (new chat, focus composer, stop).
- [ ] Project switch semantics and context inheritance.
- [ ] Artifact panel open/close + preview transport.
- [ ] Settings persistence keys.
`;

fs.writeFileSync(path.join(outDir, "inventory.md"), inventoryMd);
fs.writeFileSync(path.join(outDir, "tokens.md"), tokensMd);
fs.writeFileSync(path.join(outDir, "panes.md"), panesMd);
fs.writeFileSync(path.join(outDir, "flows.md"), flowsMd);

console.log(`wrote ${outDir}`);
console.log(`asar files=${inventory.files} dirs=${inventory.dirs} tokens=${tokenMap.size} strings=${keys.size}`);
