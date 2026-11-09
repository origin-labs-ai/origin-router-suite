#!/usr/bin/env node
// Regenerates src/shared/utils/providerIconManifest.json from the assets in
// public/providers.
//
// Why a manifest at all: the icon folder is not one format. It is our PNG set,
// the brand SVG library, and fetched .ico marks for the long tail. Asking for
// the wrong extension costs a 404 and - when a component gives up after one
// miss - a provider that owns a perfectly good logo renders as a letter glyph.
// With the map, every id resolves to the file that is actually on disk in one
// lookup and zero failed requests.
//
// Run after adding or replacing assets:  npm run gen:icons
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIR = path.join(ROOT, "public", "providers");
const OUT_FILE = path.join(ROOT, "src", "shared", "utils", "providerIconManifest.json");

// Winner when one id ships in several formats: the same order ProviderIcon
// walks as its fallback ladder, so behaviour matches whether an id is known
// to the manifest or not.
export const ICON_EXTENSIONS = ["png", "svg", "ico", "webp", "jpg", "jpeg"];

function build() {
  const entries = new Map();
  for (const file of fs.readdirSync(ASSET_DIR)) {
    const match = file.match(/^(.+)\.([^.]+)$/);
    if (!match) continue;
    const [, stem, extRaw] = match;
    const ext = extRaw.toLowerCase();
    if (!ICON_EXTENSIONS.includes(ext)) continue;
    const current = entries.get(stem);
    if (!current || ICON_EXTENSIONS.indexOf(ext) < ICON_EXTENSIONS.indexOf(current)) {
      entries.set(stem, ext);
    }
  }
  const sorted = Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return sorted;
}

const manifest = build();
fs.writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
const counts = manifest && Object.values(manifest).reduce((acc, ext) => {
  acc[ext] = (acc[ext] || 0) + 1;
  return acc;
}, {});
console.log(`providerIconManifest.json: ${Object.keys(manifest).length} ids`, counts);
