#!/usr/bin/env node
/**
 * Fetch the Anthropic UI fonts into the gitignored local folder.
 *
 *   node scripts/fetch-fonts.mjs <sans-url> <serif-url> <mono-url>
 *
 * The families are proprietary to Anthropic. This helper only exists so a
 * single machine can render the real thing during development — the files are
 * gitignored, never published to npm and never packed into the installer.
 * Grab the woff2 URLs from your own authenticated claude.ai session (DevTools →
 * Network → Font) and pass them here.
 */
import fs from "node:fs";
import path from "node:path";

const TARGETS = [
  { arg: 2, file: "anthropic-sans.woff2" },
  { arg: 3, file: "anthropic-serif.woff2" },
  { arg: 4, file: "anthropic-mono.woff2" },
];

const outDir = path.resolve("public", "fonts", "claude");
fs.mkdirSync(outDir, { recursive: true });

const given = TARGETS.filter((target) => process.argv[target.arg]);
if (given.length === 0) {
  console.log("usage: node scripts/fetch-fonts.mjs <sans-url> <serif-url> <mono-url>");
  console.log(`drop the files into: ${outDir}`);
  console.log("names: anthropic-sans.woff2, anthropic-serif.woff2, anthropic-mono.woff2");
  process.exit(0);
}

for (const target of given) {
  const url = process.argv[target.arg];
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`${target.file}: HTTP ${response.status}`);
    process.exitCode = 1;
    continue;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(path.join(outDir, target.file), buffer);
  console.log(`${target.file}: ${(buffer.length / 1024).toFixed(1)} KB`);
}
