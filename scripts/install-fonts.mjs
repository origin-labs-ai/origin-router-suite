#!/usr/bin/env node
/**
 * Install the Anthropic UI fonts used by the Claude surfaces.
 *
 *   node scripts/install-fonts.mjs [path-to-fonts.zip]
 *
 * The family files are Anthropic's property (the source archive says so
 * explicitly). They are installed into the gitignored `public/fonts/claude/`
 * for local rendering only — never committed, never packed into npm, never
 * baked into the installers.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const zipPath = process.argv[2] || path.join(os.homedir(), "Downloads", "anthropic-fonts-main.zip");
const outDir = path.resolve("public", "fonts", "claude");

const MAP = {
  "AnthropicSans-Romans.woff2": "anthropic-sans.woff2",
  "AnthropicSans-Italics.woff2": "anthropic-sans-italic.woff2",
  "AnthropicSerif-Romans.woff2": "anthropic-serif.woff2",
  "AnthropicSerif-Italics.woff2": "anthropic-serif-italic.woff2",
  "AnthropicMono.woff2": "anthropic-mono.woff2",
};

if (!fs.existsSync(zipPath)) {
  console.error(`fonts archive not found: ${zipPath}`);
  process.exit(1);
}

// Minimal ZIP reader: we only need stored/deflated entries, so no dependency.
function readEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(path.basename(name), {
      data: method === 0 ? raw : zlib.inflateRawSync(raw),
      directory: name.endsWith("/"),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

const entries = readEntries(fs.readFileSync(zipPath));
fs.mkdirSync(outDir, { recursive: true });

let installed = 0;
for (const [sourceName, targetName] of Object.entries(MAP)) {
  const entry = entries.get(sourceName);
  if (!entry) {
    console.warn(`missing ${sourceName}`);
    continue;
  }
  fs.writeFileSync(path.join(outDir, targetName), entry.data);
  installed += 1;
  console.log(`${targetName}: ${(entry.data.length / 1024).toFixed(1)} KB`);
}

fs.writeFileSync(
  path.join(outDir, "README.txt"),
  [
    "Anthropic Sans / Serif / Mono — local install only.",
    "",
    "These files belong to Anthropic. They were installed from a personal",
    "archive for local rendering of the Claude surfaces and are excluded from",
    "git, npm packages and installers by design.",
    "",
  ].join("\n"),
);

console.log(`installed ${installed} files into ${outDir} (gitignored)`);
